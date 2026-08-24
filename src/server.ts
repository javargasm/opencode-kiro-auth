import type { Server } from "bun";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Message, Model, Api, Context } from "./types";
import { streamKiro } from "./stream";
import { log } from "./debug";
import { enterSessionLog } from "./file-logger";
import {
  KIRO_MODEL_IDS,
  buildModelsFromApi,
  findKiroModel,
  fetchAvailableModels,
  getCachedDynamicModels,
  kiroModels,
  resolveApiRegion,
  resolveKiroModel,
  resolveProfileArn,
  resetProfileArnCache,
  seedProfileArn,
  setCachedDynamicModels,
  type KiroModel,
  validateNativeKiroEffort,
  DEFAULT_PROFILE_ARN,
} from "./models";
import { refreshKiroToken, BUILDER_ID_REGION } from "./oauth";
import { stats } from "./dashboard-stats";
import { getDashboardHtml } from "./dashboard-ui";
import {
  GATEWAY_AUTH_HEADER,
  GATEWAY_AUTH_NONCE_HEADER,
  GATEWAY_AUTH_TIMESTAMP_HEADER,
  GATEWAY_CAPABILITIES,
  GATEWAY_CHALLENGE_HEADER,
  GATEWAY_PROTOCOL_VERSION,
  gatewayChallengeProof,
  gatewayRequestSignature,
} from "./gateway-auth";

export {
  GATEWAY_AUTH_HEADER,
  GATEWAY_AUTH_NONCE_HEADER,
  GATEWAY_AUTH_TIMESTAMP_HEADER,
  GATEWAY_CAPABILITIES,
  GATEWAY_CHALLENGE_HEADER,
  GATEWAY_PROTOCOL_VERSION,
  gatewayChallengeProof,
  gatewayRequestSignature,
} from "./gateway-auth";

export const OPENCODE_CWD_HEADER = "x-opencode-cwd";
export const OPENCODE_EFFORT_HEADER = "x-opencode-kiro-effort";
export const OPENCODE_REGION_HEADER = "x-opencode-kiro-region";
export const OPENCODE_PROFILE_ARN_HEADER = "x-opencode-kiro-profile-arn";
const usedGatewayNonces = new Map<string, number>();
const GATEWAY_AUTH_WINDOW_MS = 30_000;
const GATEWAY_NONCE_MAX_ENTRIES = 65_536;

function bearerToken(req: Request): string | undefined {
  return req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || undefined;
}

function matchesGatewayToken(candidate: string | null | undefined, gatewayToken: string | undefined): boolean {
  if (!candidate || !gatewayToken) return false;
  const actual = Buffer.from(candidate.trim());
  const expected = Buffer.from(gatewayToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hasValidGatewayRequestAuth(req: Request, gatewayToken: string | undefined): boolean {
  if (!gatewayToken) return true;
  // Generic Anthropic clients cannot generate OpenCode's nonce-bound HMAC.
  // Accept the local gateway secret through either standard API-key transport.
  if (
    matchesGatewayToken(req.headers.get("x-api-key"), gatewayToken)
    || matchesGatewayToken(bearerToken(req), gatewayToken)
  ) {
    return true;
  }

  const timestamp = req.headers.get(GATEWAY_AUTH_TIMESTAMP_HEADER) ?? "";
  const nonce = req.headers.get(GATEWAY_AUTH_NONCE_HEADER) ?? "";
  const signature = req.headers.get(GATEWAY_AUTH_HEADER) ?? "";
  const timestampMs = Number(timestamp);
  const now = Date.now();
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > GATEWAY_AUTH_WINDOW_MS) return false;
  for (const [key, expiresAt] of usedGatewayNonces) {
    if (expiresAt < now) usedGatewayNonces.delete(key);
  }
  if (
    !nonce
    || usedGatewayNonces.has(nonce)
    || !/^[a-f0-9]{64}$/.test(signature)
  ) return false;

  const url = new URL(req.url);
  const path = `${url.pathname}${url.search}`;
  const expected = Buffer.from(
    gatewayRequestSignature(gatewayToken, timestamp, nonce, req.method, path),
    "hex",
  );
  const actual = Buffer.from(signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;

  // Replay safety requires retaining every accepted nonce for its entire
  // validity window: evicting a live entry would make that request replayable.
  // The finite cap is the unavoidable storage/rate tradeoff (about 2,184
  // accepted requests/second over 30s); once genuinely full, fail closed until
  // entries expire rather than weakening replay protection.
  if (usedGatewayNonces.size >= GATEWAY_NONCE_MAX_ENTRIES) {
    return false;
  }
  // Retain the nonce for its entire signature-validity window. A client clock
  // can be ahead of ours, so pruning merely 30 seconds after receipt could
  // otherwise make the still-valid signature replayable.
  usedGatewayNonces.set(nonce, timestampMs + GATEWAY_AUTH_WINDOW_MS);
  return true;
}

// ── Gateway credential store ─────────────────────────────────────────
// The gateway owns the Kiro auth lifecycle: import → store → refresh.
// OpenCode's auth loader is kept only for the login UI flow; actual API
// calls use these credentials directly.

interface GatewayCredentials {
  accessToken: string;
  /** pipe-packed: refreshToken|clientId|clientSecret|authMethod */
  refreshPacked: string;
  region: string;
  authMethod: "builder-id" | "idc" | "desktop" | "social";
  profileArn?: string;
  expiresAt: number;
}

let _creds: GatewayCredentials | null = null;

export function formatKiroErrorDetail(errorObj: unknown): string {
  const raw = errorObj instanceof Error
    ? errorObj.message
    : typeof errorObj === "string"
      ? errorObj
      : (errorObj as any)?.errorMessage || (errorObj as any)?.message || String(errorObj ?? "");
  if (!raw || raw === "error" || raw === "[object Object]") return "Unknown Kiro error";
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed?.message) {
        const reason = parsed.reason ? ` (${parsed.reason})` : "";
        return `${parsed.message}${reason}`;
      }
    }
  } catch {
    // fallback to raw
  }
  return raw;
}

// Single-flight guard: concurrent requests that all observe an expired token
// must share ONE refresh, not fire N parallel refreshes. With rotating refresh
// tokens (the desktop endpoint), parallel refreshes invalidate each other and
// cause intermittent auth failures.
let _credentialGeneration = 0;
let _refreshInFlight: { generation: number; promise: Promise<void> } | null = null;
let _modelsRefreshInFlight: { generation: number; promise: Promise<KiroModel[] | null> } | null = null;

const ATTACHING_CATALOG_TTL_MS = 5 * 60_000;
const ATTACHING_CATALOG_MAX_ENTRIES = 32;
const ATTACHING_CATALOG_MAX_IN_FLIGHT = 8;
const OWNER_ACCESS_TOKEN_ALIAS_MAX_ENTRIES = 8;
interface AttachingCatalog {
  models: KiroModel[];
  profileArn: string;
  expiresAt: number;
}
const attachingCatalogs = new Map<string, AttachingCatalog>();
const attachingCatalogsInFlight = new Map<string, Promise<{ models: KiroModel[]; profileArn: string } | null>>();
const ownerAccessTokenAliases = new Set<string>();

function installGatewayCredentials(credentials: GatewayCredentials | null): void {
  _credentialGeneration++;
  _refreshInFlight = null;
  _modelsRefreshInFlight = null;
  resetUsageState();
  resetProfileArnCache();
  setCachedDynamicModels(null);
  attachingCatalogs.clear();
  attachingCatalogsInFlight.clear();
  ownerAccessTokenAliases.clear();
  _creds = credentials;
  if (!credentials) {
    stopGatewayUsageRefresh();
    return;
  }
  rememberOwnerAccessToken(credentials.accessToken);
  if (credentials.profileArn) {
    seedProfileArn(
      credentials.profileArn,
      credentials.accessToken,
      resolveApiRegion(credentials.region),
    );
  }
}

async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new Error("Request aborted");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function accessTokenDigest(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

function rememberOwnerAccessToken(accessToken: string): void {
  if (!accessToken) return;
  const digest = accessTokenDigest(accessToken);
  ownerAccessTokenAliases.delete(digest);
  ownerAccessTokenAliases.add(digest);
  while (ownerAccessTokenAliases.size > OWNER_ACCESS_TOKEN_ALIAS_MAX_ENTRIES) {
    const oldest = ownerAccessTokenAliases.values().next().value;
    if (!oldest) break;
    ownerAccessTokenAliases.delete(oldest);
  }
}

function isOwnerAccessToken(accessToken: string): boolean {
  return accessToken === _creds?.accessToken || ownerAccessTokenAliases.has(accessTokenDigest(accessToken));
}

function isOwnerRequest(
  accessToken: string | undefined,
  region: string | undefined,
  profileArn: string | undefined,
): boolean {
  if (!accessToken) return true;
  if (isOwnerAccessToken(accessToken)) return true;
  if (
    profileArn
    && _creds?.profileArn === profileArn
    && resolveApiRegion(region || _creds.region) === resolveApiRegion(_creds.region)
  ) {
    // Access tokens rotate, but the account profile is stable. A long-lived
    // OpenCode process can therefore send an older token for the same owner.
    // Remember it as an alias and dispatch with the gateway's fresh token.
    rememberOwnerAccessToken(accessToken);
    return true;
  }
  return false;
}

function ownerCredentialConflict(
  accessToken: string | undefined,
  explicitRegion: string | undefined,
  explicitProfileArn: string | undefined,
): string | null {
  if (!_creds) return null;
  const identifiesOwner = !accessToken
    || isOwnerAccessToken(accessToken)
    || Boolean(explicitProfileArn && explicitProfileArn === _creds.profileArn);
  if (!identifiesOwner) return null;
  if (
    explicitRegion
    && resolveApiRegion(explicitRegion) !== resolveApiRegion(_creds.region)
  ) {
    return "Owner credential region does not match the active gateway account";
  }
  if (
    explicitProfileArn
    && explicitProfileArn !== _creds.profileArn
  ) {
    return "Owner credential profile does not match the active gateway account";
  }
  return null;
}

function attachingCatalogKey(accessToken: string, region: string, profileArn?: string): string {
  return createHash("sha256")
    .update(`${accessToken}\0${resolveApiRegion(region)}\0${profileArn ?? ""}`)
    .digest("hex");
}

function rememberAttachingCatalog(
  accessToken: string,
  region: string,
  requestedProfileArn: string | undefined,
  result: { models: KiroModel[]; profileArn: string },
): void {
  const now = Date.now();
  const entry = {
    models: result.models,
    profileArn: result.profileArn,
    expiresAt: now + ATTACHING_CATALOG_TTL_MS,
  };
  for (const profileArn of new Set([undefined, requestedProfileArn, result.profileArn])) {
    const key = attachingCatalogKey(accessToken, region, profileArn);
    if (!attachingCatalogs.has(key) && attachingCatalogs.size >= ATTACHING_CATALOG_MAX_ENTRIES) {
      const oldest = attachingCatalogs.keys().next().value;
      if (oldest) attachingCatalogs.delete(oldest);
    }
    attachingCatalogs.set(key, entry);
  }
}

function getAttachingCatalog(
  accessToken: string,
  region: string,
  profileArn?: string,
  allowStale = false,
): AttachingCatalog | undefined {
  const key = attachingCatalogKey(accessToken, region, profileArn);
  const entry = attachingCatalogs.get(key);
  if (!entry || (!allowStale && entry.expiresAt <= Date.now())) return undefined;
  return entry;
}

export function getAuthRegion(): string { return _creds?.region ?? "us-east-1"; }

/** Called once at plugin startup from index.ts */
export async function initGatewayAuth(): Promise<void> {
  try {
    const { importFromKiroCli } = await import("./kiro-cli-sync");
    const imported = await importFromKiroCli();
    if (!imported) {
      log.warn("[gateway-auth] No Kiro CLI credentials found");
      return;
    }

    const packParts = [
      imported.refreshToken,
      imported.clientId || "",
      imported.clientSecret || "",
      imported.authMethod,
      imported.source || "",
      imported.tokenKey || "",
    ];

    const credentials: GatewayCredentials = {
      accessToken: imported.accessToken,
      refreshPacked: packParts.join("|"),
      region: imported.region,
      authMethod: imported.authMethod,
      profileArn: imported.profileArn || DEFAULT_PROFILE_ARN,
      expiresAt: Date.now() + 3500 * 1000, // assume ~1h validity
    };
    installGatewayCredentials(credentials);

    log.info(`[gateway-auth] Initialized (method=${imported.authMethod}, region=${imported.region})`);

    if (imported.refreshToken) {
      try {
        log.info("[gateway-auth] Refreshing token at startup…");
        const refreshed = await refreshKiroToken(
          credentials.refreshPacked,
          credentials.region,
          credentials.authMethod as any
        );
        if (_creds === credentials) {
          rememberOwnerAccessToken(credentials.accessToken);
          credentials.accessToken = refreshed.access;
          credentials.refreshPacked = refreshed.refresh;
          credentials.expiresAt = refreshed.expires;
        }
        if (_creds === credentials && credentials.profileArn) {
          seedProfileArn(credentials.profileArn, credentials.accessToken, resolveApiRegion(credentials.region));
        }
        log.info("[gateway-auth] Token refreshed on startup successfully");
      } catch (err) {
        log.warn("[gateway-auth] Startup token refresh failed, trying with existing token", err);
      }
    }

    startGatewayUsageRefresh();

    // Catalog discovery can require two management calls. Do not keep /health
    // in a "starting" state while those endpoints are slow or offline; the
    // config hook applies a short budget and falls back to static models while
    // this shared refresh continues in the background.
    void refreshGatewayModels();
  } catch (err) {
    log.error("[gateway-auth] Init failed", err);
  }
}

/** Fetch a catalog for explicit request credentials without borrowing another account's profile. */
export async function fetchGatewayModelsForCredentials(
  accessToken: string,
  region: string,
  profileArn?: string,
  useProfileCache = false,
  signal?: AbortSignal,
): Promise<{ models: KiroModel[]; profileArn: string } | null> {
  const apiRegion = resolveApiRegion(region);
  const resolvedProfileArn = profileArn
    ?? await resolveProfileArn(accessToken, apiRegion, useProfileCache, signal)
    ?? DEFAULT_PROFILE_ARN;
  if (!resolvedProfileArn) return null;

  const apiModels = await fetchAvailableModels(accessToken, apiRegion, resolvedProfileArn, signal);
  return { models: buildModelsFromApi(apiModels), profileArn: resolvedProfileArn };
}

async function fetchAttachingCatalog(
  accessToken: string,
  region: string,
  profileArn: string | undefined,
  signal?: AbortSignal,
): Promise<{ models: KiroModel[]; profileArn: string } | null> {
  const key = attachingCatalogKey(accessToken, region, profileArn);
  let pending = attachingCatalogsInFlight.get(key);
  if (!pending) {
    if (attachingCatalogsInFlight.size >= ATTACHING_CATALOG_MAX_IN_FLIGHT) {
      throw new Error("Too many concurrent attaching-account catalog requests");
    }
    let tracked!: Promise<{ models: KiroModel[]; profileArn: string } | null>;
    tracked = fetchGatewayModelsForCredentials(accessToken, region, profileArn)
      .finally(() => {
        if (attachingCatalogsInFlight.get(key) === tracked) attachingCatalogsInFlight.delete(key);
      });
    pending = tracked;
    attachingCatalogsInFlight.set(key, pending);
  }
  return waitWithSignal(pending, signal);
}

/** Refresh the owner's model catalog while preserving the last good cache on failure. */
export async function refreshGatewayModels(): Promise<KiroModel[] | null> {
  const generation = _credentialGeneration;
  if (_modelsRefreshInFlight?.generation === generation) return _modelsRefreshInFlight.promise;
  if (!_creds?.accessToken) return getCachedDynamicModels();
  const credentials = _creds;

  const promise = (async () => {
    try {
      const accessToken = await getAccessToken();
      if (_credentialGeneration !== generation || _creds !== credentials) return getCachedDynamicModels();
      const result = await fetchGatewayModelsForCredentials(
        accessToken,
        credentials.region,
        credentials.profileArn,
        true,
      );
      if (_credentialGeneration !== generation || _creds !== credentials) return getCachedDynamicModels();
      if (!result) {
        log.info("[kiro-models.fetched] Skipping fetch, no profileArn available");
        return getCachedDynamicModels();
      }

      credentials.profileArn = result.profileArn;
      seedProfileArn(result.profileArn, accessToken, resolveApiRegion(credentials.region));
      setCachedDynamicModels(result.models);
      log.info(`[kiro-models.fetched] Found ${result.models.length}`);
      return result.models;
    } catch (err) {
      log.warn("[gateway-auth] Failed to fetch dynamic models (will fallback to last known list)", err);
      return getCachedDynamicModels();
    }
  })();
  const flight = { generation, promise };
  _modelsRefreshInFlight = flight;

  try {
    return await promise;
  } finally {
    if (_modelsRefreshInFlight === flight) _modelsRefreshInFlight = null;
  }
}

/** Get a fresh access token, refreshing if expired (single-flight). */
async function getAccessToken(signal?: AbortSignal): Promise<string> {
  if (!_creds) throw new Error("Kiro credentials not initialized — run /login kiro");
  const credentials = _creds;
  const generation = _credentialGeneration;

  if (Date.now() >= credentials.expiresAt) {
    // Coalesce concurrent refreshes into one in-flight promise so parallel
    // requests don't each rotate (and invalidate) the refresh token.
    if (_refreshInFlight?.generation !== generation) {
      const promise = (async () => {
        log.info("[gateway-auth] Token expired, refreshing...");
        const refreshed = await refreshKiroToken(
          credentials.refreshPacked,
          credentials.region,
          credentials.authMethod,
        );
        if (_credentialGeneration !== generation || _creds !== credentials) return;
        rememberOwnerAccessToken(credentials.accessToken);
        credentials.accessToken = refreshed.access;
        credentials.refreshPacked = refreshed.refresh;
        credentials.expiresAt = refreshed.expires;
        if (credentials.profileArn) {
          seedProfileArn(credentials.profileArn, credentials.accessToken, resolveApiRegion(credentials.region));
        }
        log.info("[gateway-auth] Token refreshed successfully");
      })();
      const flight = { generation, promise };
      _refreshInFlight = flight;
      void promise
        .finally(() => {
          if (_refreshInFlight === flight) _refreshInFlight = null;
        })
        // `finally()` creates a distinct promise. Handle only that detached
        // cleanup chain so the original rejection still reaches every waiter.
        .catch(() => undefined);
    }
    const refresh = _refreshInFlight;
    if (!refresh || refresh.generation !== generation) {
      throw new Error("Kiro credential refresh was superseded");
    }
    await waitWithSignal(refresh.promise, signal);
  }

  if (_credentialGeneration !== generation || _creds !== credentials) {
    throw new Error("Kiro credentials changed while processing the request");
  }
  return credentials.accessToken;
}

// ── Kiro account usage limits (credits) ──────────────────────────────
// Mirrors pi-usage-bars fetchKiroUsage: calls AmazonCodeWhispererService
// .GetUsageLimits and returns a percentage (used/limit) for the TUI bar.
// Cached for 20s to avoid hammering AWS from the TUI/dashboard poll loops.

export interface KiroUsageLimits {
  percentage: number;
  creditsUsed: number;
  creditsTotal: number;
  planTitle: string | null;
  monthlyResetsIn: string | null;
  error?: string;
}

let _usageCache: { data: KiroUsageLimits; at: number } | null = null;
let _usageInFlight: Promise<KiroUsageLimits> | null = null;
let _usageAbortController: AbortController | null = null;
let _usageRefreshTimer: ReturnType<typeof setInterval> | null = null;
export const USAGE_REFRESH_MS = 20_000;
export const USAGE_CACHE_MS = USAGE_REFRESH_MS;
export const USAGE_REQUEST_TIMEOUT_MS = 10_000;

function formatDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  if (d >= 1) return `${d}d`;
  const h = Math.floor((sec % 86400) / 3600);
  if (h >= 1) return `${h}h`;
  const m = Math.floor((sec % 3600) / 60);
  return m >= 1 ? `${m}m` : "<1m";
}

export async function fetchKiroUsageLimits(
  options: { timeoutMs?: number; force?: boolean } = {},
): Promise<KiroUsageLimits> {
  if (!options.force && _usageCache && Date.now() - _usageCache.at < USAGE_CACHE_MS) {
    return _usageCache.data;
  }
  if (_usageInFlight) return _usageInFlight;

  if (!_creds) {
    return { percentage: 0, creditsUsed: 0, creditsTotal: 0, planTitle: null, monthlyResetsIn: null, error: "no credentials" };
  }

  const credentials = _creds;
  const generation = _credentialGeneration;
  const stale = _usageCache?.data;
  const accountUnchanged = () => _credentialGeneration === generation && _creds === credentials;
  const failure = (message: string): KiroUsageLimits => {
    const data = accountUnchanged() && stale
      ? { ...stale, error: message }
      : {
          percentage: 0,
          creditsUsed: 0,
          creditsTotal: 0,
          planTitle: null,
          monthlyResetsIn: null,
          error: message,
        };
    if (accountUnchanged()) _usageCache = { data, at: Date.now() };
    return data;
  };

  const abortController = new AbortController();
  _usageAbortController = abortController;
  const timeoutSignal = AbortSignal.timeout(
    Math.max(1, options.timeoutMs ?? USAGE_REQUEST_TIMEOUT_MS),
  );
  const signal = AbortSignal.any([abortController.signal, timeoutSignal]);

  const pending = (async (): Promise<KiroUsageLimits> => {
    try {
    const accessToken = await getAccessToken(signal);
    if (_credentialGeneration !== generation || _creds !== credentials) throw new Error("Kiro account changed");
    const apiRegion = resolveApiRegion(credentials.region);

    // Resolve profileArn if missing (Builder ID social login may not have it).
    let profileArn = credentials.profileArn;
    if (!profileArn) {
      profileArn = await resolveProfileArn(accessToken, apiRegion, true, signal) ?? DEFAULT_PROFILE_ARN;
      if (profileArn && _credentialGeneration === generation && _creds === credentials) {
        credentials.profileArn = profileArn;
        seedProfileArn(profileArn, accessToken, apiRegion);
      }
    }

    const body: Record<string, unknown> = { isEmailRequired: true, origin: "AI_EDITOR" };
    if (profileArn) body.profileArn = profileArn;

    const res = await fetch(`https://q.${apiRegion}.amazonaws.com/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
        "x-amzn-codewhisperer-optout": "true",
        "amz-sdk-invocation-id": crypto.randomUUID(),
        "amz-sdk-request": "attempt=1; max=1",
        "x-amzn-kiro-agent-mode": "vibe",
        "User-Agent": "opencode-kiro",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const message = `HTTP ${res.status}`;
      if (!accountUnchanged()) throw new Error("Kiro account changed");
      return failure(message);
    }

    const data: any = await res.json();
    let usedCount = 0;
    let limitCount = 0;
    let nextReset: number | null = null;

    if (Array.isArray(data.usageBreakdownList)) {
      for (const entry of data.usageBreakdownList) {
        usedCount += entry.currentUsage ?? 0;
        limitCount += entry.usageLimit ?? 0;
        if (entry.freeTrialInfo) {
          usedCount += entry.freeTrialInfo.currentUsage ?? 0;
          limitCount += entry.freeTrialInfo.usageLimit ?? 0;
        }
        if (entry.nextDateReset) nextReset = entry.nextDateReset;
      }
    }

    const percentage = limitCount > 0 ? Number(((usedCount / limitCount) * 100).toFixed(2)) : 0;
    const out: KiroUsageLimits = {
      percentage,
      creditsUsed: usedCount,
      creditsTotal: limitCount,
      planTitle: null,
      monthlyResetsIn: null,
    };

    if (nextReset) {
      const diffSec = Math.max(0, (nextReset * 1000 - Date.now()) / 1000);
      out.monthlyResetsIn = formatDuration(diffSec);
    }

    const subTitle: string | undefined = data.subscriptionInfo?.subscriptionTitle;
    if (subTitle) {
      out.planTitle = subTitle.replace(/^KIRO\s+/i, "").replace(/\w\S*/g, (w: string) =>
        w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
      );
    }

    if (!accountUnchanged()) throw new Error("Kiro account changed");
    _usageCache = { data: out, at: Date.now() };
    return out;
  } catch (err) {
      const message = !accountUnchanged()
        ? "Kiro account changed"
        : signal.aborted
          ? "usage request timed out"
        : err instanceof Error ? err.message : String(err);
      return failure(message);
    }
  })();

  _usageInFlight = pending;
  try {
    return await pending;
  } finally {
    if (_usageInFlight === pending) _usageInFlight = null;
    if (_usageAbortController === abortController) _usageAbortController = null;
  }
}

/** Keep the owner process's usage cache warm; readers should normally hit it. */
export function startGatewayUsageRefresh(): void {
  if (_usageRefreshTimer || !_creds) return;

  const refresh = () => {
    if (!_creds) return;
    void fetchKiroUsageLimits({ force: true }).catch((error) => {
      log.warn("[gateway-usage] Background refresh failed", error);
    });
  };

  _usageRefreshTimer = setInterval(refresh, USAGE_REFRESH_MS);
  (_usageRefreshTimer as unknown as { unref?: () => void }).unref?.();
  refresh();
}

export function stopGatewayUsageRefresh(): void {
  if (_usageRefreshTimer) {
    clearInterval(_usageRefreshTimer);
    _usageRefreshTimer = null;
  }
  _usageAbortController?.abort(new Error("Gateway usage refresh stopped"));
}

function resetUsageState(): void {
  _usageAbortController?.abort(new Error("Usage state reset"));
  _usageAbortController = null;
  _usageInFlight = null;
  _usageCache = null;
}

/** @internal — test helper to inject credentials without Kiro CLI */
export function _seedCredentials(
  token: string,
  region = "us-east-1",
  expiresAt = Date.now() + 3600_000,
  profileArn?: string,
) {
  installGatewayCredentials({
    accessToken: token,
    refreshPacked: "",
    region,
    authMethod: "idc",
    profileArn,
    expiresAt,
  });
}

/** @internal — test helper to simulate a gateway owner without local credentials. */
export function _clearCredentials(): void {
  installGatewayCredentials(null);
}

/** @internal — deterministic replay-cache seams for gateway auth tests. */
export function _resetGatewayNoncesForTest(): void {
  usedGatewayNonces.clear();
}

/** @internal — avoid 1,001 loopback HTTP round trips in nonce-boundary tests. */
export const _hasValidGatewayRequestAuthForTest = hasValidGatewayRequestAuth;

/**
 * Origin allow-list for the local gateway. Server-side callers (OpenCode,
 * curl) send NO Origin header and are always allowed. Browsers always send
 * Origin; only localhost origins are permitted, which blocks drive-by requests
 * from arbitrary websites to 127.0.0.1:7438 — the gateway proxies the user's
 * Kiro credentials, so an open CORS surface means credential/quota abuse.
 */
function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function hasLoopbackRequestHost(req: Request, url: URL): boolean {
  if (!isLoopbackHostname(url.hostname)) return false;
  const host = req.headers.get("host");
  if (!host) return false;
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function anthropicStopReason(finalMsg: Pick<Extract<Message, { role: "assistant" }>, "stopReason" | "content">): "max_tokens" | "tool_use" | "end_turn" {
  if (finalMsg.stopReason === "length") return "max_tokens";
  if (finalMsg.content.some((block) => block.type === "toolCall")) return "tool_use";
  return "end_turn";
}

/** True for a browser cross-origin request that must be rejected. */
function isDisallowedBrowserRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false; // non-browser caller (no Origin header) — allow
  return !isLocalhostOrigin(origin);
}

/**
 * Format an error response matching Anthropic's API error schema.
 * @ai-sdk/anthropic parses this format to surface errors to the caller.
 * Without it, errors are silently swallowed as "Unexpected server error".
 */
function anthropicError(
  status: number,
  type: "authentication_error" | "invalid_request_error" | "api_error" | "not_found_error" | "overloaded_error",
  message: string,
): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

const DASHBOARD_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const DASHBOARD_SESSION_COOKIE = "opencode-kiro-dashboard";
const DASHBOARD_SESSION_MAX_AGE_SECONDS = 3600;
const DASHBOARD_SESSION_MAX_ENTRIES = 64;

function createDashboardSession(sessions: Map<string, number>): string {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
  while (sessions.size >= DASHBOARD_SESSION_MAX_ENTRIES) {
    const oldest = sessions.keys().next().value;
    if (!oldest) break;
    sessions.delete(oldest);
  }

  const token = randomBytes(32).toString("hex");
  sessions.set(token, now + DASHBOARD_SESSION_MAX_AGE_SECONDS * 1000);
  return token;
}

function readCookie(req: Request, name: string): string | undefined {
  const prefix = `${name}=`;
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return undefined;
}

function dashboardSessionCookie(sessionToken: string): string {
  return [
    `${DASHBOARD_SESSION_COOKIE}=${sessionToken}`,
    "Path=/dashboard",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${DASHBOARD_SESSION_MAX_AGE_SECONDS}`,
  ].join("; ");
}

function hasValidDashboardRequestAuth(
  req: Request,
  gatewayToken: string | undefined,
  sessions: Map<string, number>,
): boolean {
  if (!gatewayToken || hasValidGatewayRequestAuth(req, gatewayToken)) return true;
  const sessionToken = readCookie(req, DASHBOARD_SESSION_COOKIE);
  if (!sessionToken) return false;
  const expiresAt = sessions.get(sessionToken);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(sessionToken);
    return false;
  }
  return true;
}

function dashboardError(status: 401 | 403, message: string): Response {
  const response = anthropicError(status, "authentication_error", message);
  for (const [name, value] of Object.entries(DASHBOARD_RESPONSE_HEADERS)) {
    response.headers.set(name, value);
  }
  response.headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  return response;
}

/**
 * Detect OpenCode's title-generation turn. OpenCode prepends a user message
 * that begins with "Generate a title for this conversation" (see opencode
 * src/session/prompt.ts). Keying off this marker means we strip wrapping
 * markdown ONLY for titles — never for normal chat, which legitimately uses
 * **bold**, `code`, and quotes.
 */
function isTitleGenerationRequest(messages: any[]): boolean {
  for (const m of messages) {
    if (m?.role !== "user") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((b: any) => (typeof b === "string" ? b : b?.text || "")).join(" ")
          : "";
    if (/generate a title for this conversation/i.test(text)) return true;
  }
  return false;
}

/** Short, stable, filesystem-safe hash for grouping log files. */
function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** Plain text of the first user message — stable across every turn of a
 *  conversation (history grows, but the first message never changes). */
function firstUserMessageText(messages: any[]): string {
  for (const m of messages) {
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((b: any) => (typeof b === "string" ? b : b?.text || ""))
        .join(" ")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

/**
 * A stable-ish seed string identifying one conversation. Prefers the first
 * user message's TEXT (human-meaningful, fixed across turns). When that is
 * empty — e.g. the client compacted history and dropped the original prompt,
 * or the first message is image/tool-result only — it falls back to a
 * fingerprint of the first message's full structure so unrelated
 * conversations never share a seed.
 */
function conversationSeed(messages: any[]): string {
  const text = firstUserMessageText(messages);
  if (text) return text;
  if (messages.length > 0) {
    try {
      return "msg0:" + JSON.stringify(messages[0]);
    } catch {
      // fall through
    }
  }
  return "";
}

/**
 * Derive a stable per-session id so all turns of one conversation land in the
 * same /tmp/kiro-logs/session-{id}.log file, regardless of client.
 *
 * Priority (first match wins):
 *  1. Explicit session header (`x-session-id` / `x-kiro-session-id` /
 *     `anthropic-session-id`) — most stable, survives history compaction.
 *  2. Anthropic `metadata.user_id` — Claude Code embeds a stable id here.
 *  3. Title-generation turns get their own bucket (keyed on the seed).
 *  4. Content fingerprint — first user text, else first-message structure.
 *  5. Degenerate request (no messages): hash of the whole body.
 *
 * There is intentionally NO shared "default" bucket: every request resolves to
 * a hashed id so unrelated conversations are never mixed into one file. This id
 * is also reused as the source key for the Kiro API `conversationId` (see
 * `resolveConversationId` in stream.ts), so all turns of one conversation share
 * a single upstream conversationId — matching the Kiro CLI.
 */
function deriveLogSessionId(body: any, messages: any[], headers?: Headers): string {
  const headerId =
    headers?.get("x-session-id") ||
    headers?.get("x-kiro-session-id") ||
    headers?.get("anthropic-session-id");
  if (headerId && headerId.trim().length > 0) {
    return `s-${shortHash(headerId.trim())}`;
  }

  const userId = body?.metadata?.user_id;
  if (typeof userId === "string" && userId.trim().length > 0) {
    return `u-${shortHash(userId.trim())}`;
  }

  const seed = conversationSeed(messages);

  if (isTitleGenerationRequest(messages)) {
    return `title-${shortHash(seed || "untitled")}`;
  }

  if (seed) {
    return `c-${shortHash(seed)}`;
  }

  // No messages at all — hash the body so this still gets a unique file
  // rather than collapsing into a shared bucket.
  try {
    return `c-${shortHash(JSON.stringify(body))}`;
  } catch {
    return `c-${shortHash(String(Date.now()))}`;
  }
}


/**
 * Strip wrapping markdown/quotes from a generated title. Kiro models often
 * return titles wrapped in bold (`**Title**`), quotes, backticks, or with a
 * leading heading/list marker, despite OpenCode's title prompt asking for
 * plain text. OpenCode's own cleanup only strips <think> tags and takes the
 * first non-empty line, so the wrapping survives into the session title.
 *
 * Applied ONLY to title-generation turns (see isTitleGenerationRequest), so
 * normal assistant responses keep their markdown intact.
 */
export function stripTitleMarkdown(text: string): string {
  let t = text.trim();
  let prev: string;
  do {
    prev = t;
    t = t.replace(/^\*\*([\s\S]+?)\*\*$/, "$1").trim(); // **bold**
    t = t.replace(/^\*([\s\S]+?)\*$/, "$1").trim(); // *italic*
    t = t.replace(/^__([\s\S]+?)__$/, "$1").trim(); // __bold__
    t = t.replace(/^_([\s\S]+?)_$/, "$1").trim(); // _italic_
    t = t.replace(/^`([\s\S]+?)`$/, "$1").trim(); // `code`
    t = t.replace(/^["'“”]([\s\S]+?)["'“”]$/, "$1").trim(); // "quoted"
    t = t.replace(/^#{1,6}\s+/, "").trim(); // # heading
    t = t.replace(/^[-*]\s+/, "").trim(); // - bullet
  } while (t !== prev && t.length > 0);
  return t;
}

export interface GatewayServerOptions {
  isReady?: () => boolean;
  gatewayToken?: string;
  onRestart?: () => void | Promise<void>;
}

export function startGatewayServer(
  port: number = 0,
  options: GatewayServerOptions = {},
): Promise<Server<any>> {
  return new Promise((resolve) => {
    const dashboardSessions = new Map<string, number>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      // Reasoning models can take 30-60s before emitting the first token
      // while thinking. Bun's default 10s idle timeout is far too short.
      idleTimeout: 255,
      async fetch(req) {
        const url = new URL(req.url);
        if (!hasLoopbackRequestHost(req, url)) {
          return anthropicError(421, "invalid_request_error", "Local gateway requires a loopback Host");
        }

        // Handle CORS preflight. Reflect the Origin only for localhost so a
        // remote website's preflight fails and the browser never sends the
        // real cross-origin request. Non-browser callers don't preflight.
        if (req.method === "OPTIONS") {
          const origin = req.headers.get("origin");
          const headers: Record<string, string> = {
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": [
              "Content-Type",
              "Accept",
              "Authorization",
              "x-api-key",
              "anthropic-version",
              "anthropic-beta",
              "x-session-id",
              OPENCODE_CWD_HEADER,
              OPENCODE_EFFORT_HEADER,
              OPENCODE_REGION_HEADER,
              OPENCODE_PROFILE_ARN_HEADER,
              GATEWAY_AUTH_HEADER,
              GATEWAY_AUTH_TIMESTAMP_HEADER,
              GATEWAY_AUTH_NONCE_HEADER,
            ].join(", "),
          };
          if (origin && isLocalhostOrigin(origin)) {
            headers["Access-Control-Allow-Origin"] = origin;
            headers["Vary"] = "Origin";
          }
          return new Response(null, { headers });
        }

        // Dashboard endpoints
        if (url.pathname === "/dashboard") {
          const nonce = randomBytes(18).toString("base64");
          const headers: Record<string, string> = {
            "Content-Type": "text/html; charset=utf-8",
            ...DASHBOARD_RESPONSE_HEADERS,
            "Content-Security-Policy": `default-src 'none'; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
            "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
          };
          if (options.gatewayToken) {
            headers["Set-Cookie"] = dashboardSessionCookie(createDashboardSession(dashboardSessions));
          }
          return new Response(getDashboardHtml(nonce), {
            headers,
          });
        }
        if (url.pathname === "/dashboard/api/stats") {
          if (isDisallowedBrowserRequest(req)) {
            return dashboardError(403, "Browser origin not allowed");
          }
          if (!hasValidDashboardRequestAuth(req, options.gatewayToken, dashboardSessions)) {
            return dashboardError(401, "Invalid local gateway token");
          }
          return new Response(JSON.stringify(stats.getStats()), {
            headers: {
              "Content-Type": "application/json",
              ...DASHBOARD_RESPONSE_HEADERS,
              "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
            },
          });
        }
        if (url.pathname === "/dashboard/api/usage") {
          if (isDisallowedBrowserRequest(req)) {
            return dashboardError(403, "Browser origin not allowed");
          }
          if (!hasValidDashboardRequestAuth(req, options.gatewayToken, dashboardSessions)) {
            return dashboardError(401, "Invalid local gateway token");
          }
          const usage = await fetchKiroUsageLimits();
          return new Response(JSON.stringify(usage), {
            headers: {
              "Content-Type": "application/json",
              ...DASHBOARD_RESPONSE_HEADERS,
              "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
            },
          });
        }

        if ((url.pathname === "/v1/restart" || url.pathname === "/dashboard/api/restart") && req.method === "POST") {
          if (isDisallowedBrowserRequest(req)) {
            return anthropicError(403, "authentication_error", "Browser origin not allowed");
          }
          if (!hasValidGatewayRequestAuth(req, options.gatewayToken) && !hasValidDashboardRequestAuth(req, options.gatewayToken, dashboardSessions)) {
            return anthropicError(401, "authentication_error", "Invalid local gateway token");
          }
          if (options.onRestart) {
            setTimeout(() => {
              void options.onRestart?.();
            }, 50);
          }
          return new Response(JSON.stringify({ status: "restarting", message: "Gateway restart initiated" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Health check endpoint
        if (url.pathname === "/health" || url.pathname === "/") {
          const challenge = req.headers.get(GATEWAY_CHALLENGE_HEADER);
          return new Response(JSON.stringify({
            status: "healthy",
            service: "opencode-kiro-gateway",
            protocolVersion: GATEWAY_PROTOCOL_VERSION,
            capabilities: GATEWAY_CAPABILITIES,
            ready: options.isReady?.() ?? true,
            proof: options.gatewayToken && challenge
              ? gatewayChallengeProof(options.gatewayToken, challenge)
              : undefined,
          }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.pathname === "/v1/models" && req.method === "GET") {
          if (isDisallowedBrowserRequest(req)) {
            return anthropicError(403, "authentication_error", "Browser origin not allowed");
          }
          if (!hasValidGatewayRequestAuth(req, options.gatewayToken)) {
            return anthropicError(401, "authentication_error", "Invalid local gateway token");
          }
          const requestBearer = bearerToken(req);
          const bearer = matchesGatewayToken(requestBearer, options.gatewayToken) ? undefined : requestBearer;
          const explicitRegion = req.headers.get(OPENCODE_REGION_HEADER)?.trim() || undefined;
          const requestRegion = explicitRegion || BUILDER_ID_REGION;
          const requestProfileArn = req.headers.get(OPENCODE_PROFILE_ARN_HEADER)?.trim() || undefined;
          const ownerConflict = ownerCredentialConflict(bearer, explicitRegion, requestProfileArn);
          if (ownerConflict) {
            return anthropicError(409, "invalid_request_error", ownerConflict);
          }
          let dynamicModels: KiroModel[] | null;
          if (url.searchParams.get("refresh") === "1") {
            if (bearer && !isOwnerRequest(bearer, requestRegion, requestProfileArn)) {
              const staleCatalog = getAttachingCatalog(bearer, requestRegion, requestProfileArn, true);
              try {
                const result = await fetchAttachingCatalog(
                  bearer,
                  requestRegion,
                  requestProfileArn,
                  req.signal,
                );
                dynamicModels = result?.models ?? staleCatalog?.models ?? null;
                if (result) rememberAttachingCatalog(bearer, requestRegion, requestProfileArn, result);
              } catch {
                if (!staleCatalog) {
                  return anthropicError(502, "api_error", "Kiro model catalog request failed");
                }
                dynamicModels = staleCatalog.models;
              }
            } else {
              dynamicModels = await refreshGatewayModels();
            }
          } else {
            dynamicModels = getCachedDynamicModels();
          }
          const models = dynamicModels ?? kiroModels;
          return new Response(JSON.stringify({
            object: "list",
            source: dynamicModels !== null ? "dynamic" : "static",
            data: models,
          }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Anthropic Messages endpoint
        if ((url.pathname === "/v1/messages" || url.pathname === "/messages") && req.method === "POST") {
          // Reject cross-origin browser requests: the gateway proxies the
          // user's Kiro credentials and must not be drivable from a web page.
          if (isDisallowedBrowserRequest(req)) {
            return anthropicError(403, "invalid_request_error", "Cross-origin requests are not allowed");
          }
          if (!hasValidGatewayRequestAuth(req, options.gatewayToken)) {
            return anthropicError(401, "authentication_error", "Invalid local gateway token");
          }
          const requestBearer = bearerToken(req);
          // Authorization may carry the local gateway secret for clients that
          // do not support x-api-key. Never forward that secret to Kiro.
          const bearer = matchesGatewayToken(requestBearer, options.gatewayToken) ? undefined : requestBearer;
          const requestRegion = req.headers.get(OPENCODE_REGION_HEADER)?.trim();
          const requestProfileArn = req.headers.get(OPENCODE_PROFILE_ARN_HEADER)?.trim();
          const requestAuthRegion = requestRegion || _creds?.region || BUILDER_ID_REGION;
          const ownerConflict = ownerCredentialConflict(bearer, requestRegion, requestProfileArn);
          if (ownerConflict) {
            return anthropicError(409, "invalid_request_error", ownerConflict);
          }
          const ownerRequest = isOwnerRequest(bearer, requestAuthRegion, requestProfileArn);
          let body: any;
          try {
            body = await req.json();
          } catch (e) {
            return anthropicError(400, "invalid_request_error", "Bad Request: Invalid JSON body");
          }

          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return anthropicError(400, "invalid_request_error", "Bad Request: JSON body must be an object");
          }
          if (typeof body.model !== "string" || body.model.trim().length === 0) {
            return anthropicError(400, "invalid_request_error", "Bad Request: model must be a non-empty string");
          }
          if (
            body.max_tokens !== undefined
            && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0)
          ) {
            return anthropicError(400, "invalid_request_error", "Bad Request: max_tokens must be a positive integer");
          }

          let accessToken: string;
          try {
            accessToken = ownerRequest ? await getAccessToken(req.signal) : bearer!;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return anthropicError(401, "authentication_error", `Kiro: ${msg}`);
          }

          const anthropicModelId = body.model.trim();
          const anthropicMessages = body.messages || [];
          const workingDirectory = req.headers.get(OPENCODE_CWD_HEADER)?.trim();
          if (workingDirectory && !isAbsolute(workingDirectory)) {
            return anthropicError(400, "invalid_request_error", `${OPENCODE_CWD_HEADER} must be an absolute path`);
          }
          // Anthropic system can be string or array of content blocks
          let systemPrompt = "";
          if (typeof body.system === "string") {
            systemPrompt = body.system;
          } else if (Array.isArray(body.system)) {
            systemPrompt = body.system
              .map((b: any) => (typeof b === "string" ? b : b.text || ""))
              .join("\n");
          }
          const streamRequested = !!body.stream;
          // Kiro/CodeWhisperer exposes no temperature knob — read for
          // logging/parity only; intentionally NOT forwarded to the API.
          const temperature = body.temperature ?? 0.5;
          // Anthropic requires max_tokens; streamKiro forwards it only when the
          // target catalog explicitly advertises top-level max_tokens.
          const maxTokens = body.max_tokens as number | undefined;

          // Bind this request to its own session log file. Derived once and
          // reused for streamKiro below. From here on, every log.*() in this
          // request (including the detached streamKiro IIFE and SSE stream,
          // both created synchronously after this call) routes to
          // session-{id}.log. Each request gets its own async context.
          const logSessionId = deriveLogSessionId(body, anthropicMessages, req.headers);
          enterSessionLog(logSessionId);

          log.debug(`[gateway] sys=${systemPrompt.length}c msgs=${anthropicMessages.length} tools=${body.tools?.length ?? 0}`);

          try {
            const piMessages = translateAnthropicToPi(anthropicMessages);

            const context: Context = {
              messages: piMessages,
              // Don't send OpenCode's system prompt to Kiro — it's designed
              // for Anthropic's native API and bloats the content to 34KB+.
              // Kiro uses its own agent prompt via the synthetic seed pair.
              systemPrompt: "",
              tools: body.tools ? translateAnthropicToolsToPi(body.tools) : undefined,
            };

            const apiRegion = resolveApiRegion(requestAuthRegion);
            const kiroEndpoint = `https://runtime.${apiRegion}.kiro.dev`;
            const globalCatalogModel = typeof anthropicModelId === "string"
              ? findKiroModel(anthropicModelId)
              : undefined;
            let attachingCatalog = bearer && !ownerRequest
              ? getAttachingCatalog(bearer, requestAuthRegion, requestProfileArn)
              : undefined;
            const staleAttachingCatalog = bearer && !ownerRequest
              ? getAttachingCatalog(bearer, requestAuthRegion, requestProfileArn, true)
              : undefined;
            const requestsNativeEffort = Boolean(
              req.headers.get(OPENCODE_EFFORT_HEADER)
              || body.output_config?.effort
              || body.reasoning_effort,
            );
            const requestsCatalogMaxTokens = typeof maxTokens === "number" && maxTokens > 0;
            if (
              bearer
              && !ownerRequest
              && !attachingCatalog
              && (!globalCatalogModel || requestsNativeEffort || requestsCatalogMaxTokens)
            ) {
              try {
                const result = await fetchAttachingCatalog(
                  bearer,
                  requestAuthRegion,
                  requestProfileArn,
                  req.signal,
                );
                if (!result) {
                  if (!staleAttachingCatalog) {
                    return anthropicError(502, "api_error", "Kiro profile is unavailable for this account");
                  }
                  attachingCatalog = staleAttachingCatalog;
                } else {
                  rememberAttachingCatalog(bearer, requestAuthRegion, requestProfileArn, result);
                  attachingCatalog = getAttachingCatalog(bearer, requestAuthRegion, requestProfileArn);
                }
              } catch (error) {
                log.warn(
                  "[gateway] Attaching account catalog refresh failed",
                  error instanceof Error ? error.message : String(error),
                );
                if (!staleAttachingCatalog) {
                  return anthropicError(502, "api_error", "Kiro account catalog refresh failed");
                }
                attachingCatalog = staleAttachingCatalog;
              }
            }
            const profileArn = requestProfileArn
              || attachingCatalog?.profileArn
              || (ownerRequest ? _creds?.profileArn : undefined);
            const attachingModels = attachingCatalog?.models;

            const catalogModel = typeof anthropicModelId === "string"
              ? attachingModels?.find((model) => model.id === anthropicModelId)
                ?? (ownerRequest ? globalCatalogModel : undefined)
              : undefined;
            const piModel: Model<Api> = catalogModel
              ? { ...catalogModel, baseUrl: kiroEndpoint }
              : {
                id: anthropicModelId,
                name: anthropicModelId,
                provider: "kiro",
                api: "kiro-api",
                baseUrl: kiroEndpoint,
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_000_000,
                maxTokens: 128_000,
              };

            log.debug("[gateway] body-keys", Object.keys(body));

            // The local header preserves the selected native variant when the
            // Anthropic SDK omits `none`; body fields keep direct API callers
            // backward compatible. Every candidate is catalog-validated.
            const nativeEffort = [
              req.headers.get(OPENCODE_EFFORT_HEADER),
              body.output_config?.effort,
              body.reasoning_effort,
            ].map((effort) => validateNativeKiroEffort(catalogModel, effort)).find(Boolean);

            // Title-generation turns need wrapping markdown stripped from the
            // model's output (Kiro models return "**Title**" despite the prompt).
            const isTitleTurn = isTitleGenerationRequest(anthropicMessages);

            log.info(`[gateway] → ${kiroEndpoint} model=${anthropicModelId} region=${apiRegion} stream=${streamRequested}`);

            const upstreamController = new AbortController();
            const upstreamSignal = AbortSignal.any([req.signal, upstreamController.signal]);
            const kiroStream = streamKiro(piModel, context, {
              apiKey: accessToken,
              modelMetadata: catalogModel ?? (bearer ? piModel as KiroModel : undefined),
              nativeEffort,
              temperature,
              maxTokens,
              // The log session id is a stable per-conversation key (survives
              // history growth). Reuse it as the Kiro `conversationId` source so
              // every turn of one conversation shares a single id, like Kiro CLI.
              sessionId: logSessionId,
              logSessionId,
              workingDirectory: workingDirectory || undefined,
              profileArn,
              cacheProfileArn: ownerRequest,
              signal: upstreamSignal,
            });
            const safeKiroStreamResult = async (stream: typeof kiroStream): Promise<any> => {
              try {
                if (!stream || typeof stream.result !== "function") {
                  return { stopReason: "error", errorMessage: "Kiro stream initialization failed" };
                }
                return await stream.result();
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                log.error("[gateway] Error awaiting kiroStream.result():", msg);
                return { stopReason: "error", errorMessage: msg };
              }
            };

            if (streamRequested) {
              // Buffer first event: if the stream fails immediately (auth, profileArn, etc.)
              // return a clean HTTP error instead of a broken SSE stream.
              const iter = kiroStream[Symbol.asyncIterator]();
              let firstResult: IteratorResult<any>;
              try {
                firstResult = await iter.next();
              } catch (err) {
                upstreamController.abort(err);
                const msg = err instanceof Error ? err.message : String(err);
                log.error("[gateway] Stream failed before first event:", msg);
                return anthropicError(502, "api_error", `Kiro: ${msg}`);
              }

              if (firstResult.done) {
                upstreamController.abort(new Error("Kiro stream ended before producing events"));
                return anthropicError(502, "api_error", "Kiro: stream ended without producing events");
              }

              // Collect buffered events until we get a content event or error.
              // The stream produces "start" first (non-content), then content deltas or errors.
              const bufferedEvents: any[] = [firstResult.value];

              // If first event is "start" (no content yet), keep reading until we get real content or an error
              while (bufferedEvents[bufferedEvents.length - 1]?.type === "start") {
                try {
                  const next = await iter.next();
                  if (next.done) break;
                  bufferedEvents.push(next.value);
                } catch (err) {
                  upstreamController.abort(err);
                  const msg = err instanceof Error ? err.message : String(err);
                  log.error("[gateway] Stream failed during buffering:", msg);
                  return anthropicError(502, "api_error", `Kiro: ${msg}`);
                }
              }

              // If any buffered event is an error, return HTTP error
              const errorEvent = bufferedEvents.find((e) => e.type === "error");
              if (errorEvent) {
                const errMsg = formatKiroErrorDetail(errorEvent.error ?? errorEvent.reason);
                upstreamController.abort(new Error(errMsg));
                log.error("[gateway] Kiro stream error:", errMsg);
                return anthropicError(502, "api_error", `Kiro: ${errMsg}`);
              }

              let sseCancelled = false;
              let resumeBackpressure: (() => void) | null = null;
              let stopSseHeartbeat = () => {};
              const wakeBackpressure = () => {
                const resume = resumeBackpressure;
                resumeBackpressure = null;
                resume?.();
              };

              const streamResponse = new ReadableStream<string>({
                start(controller) {
                  void (async () => {
                  const waitForCapacity = async () => {
                    while (!sseCancelled && !upstreamSignal.aborted && (controller.desiredSize ?? 1) <= 0) {
                      await new Promise<void>((resolve) => {
                        resumeBackpressure = resolve;
                        if (sseCancelled || upstreamSignal.aborted || (controller.desiredSize ?? 1) > 0) {
                          wakeBackpressure();
                        }
                      });
                    }
                    if (sseCancelled || upstreamSignal.aborted) {
                      throw upstreamSignal.reason ?? new Error("SSE client disconnected");
                    }
                  };
                  const enqueue = (chunk: string) => {
                    if (sseCancelled || upstreamSignal.aborted) {
                      throw upstreamSignal.reason ?? new Error("SSE client disconnected");
                    }
                    controller.enqueue(chunk);
                  };
                  // Heartbeat: streamKiro retries internally on idle / first-token
                  // timeouts (idle 60s + backoff, up to ~4 min) without pushing any
                  // events. With no traffic the SSE connection looks frozen to the
                  // client. Emit periodic `ping` events (part of the Anthropic SSE
                  // protocol — clients ignore them) during silence so the connection
                  // stays visibly alive. Declared outside the try so `finally` can
                  // always clear the timer.
                  const PING_INTERVAL_MS = 15_000;
                  let lastActivity = Date.now();
                  let pingTimer: ReturnType<typeof setInterval> | null = null;
                  const stopHeartbeat = () => {
                    if (pingTimer) {
                      clearInterval(pingTimer);
                      pingTimer = null;
                    }
                  };
                  stopSseHeartbeat = stopHeartbeat;
                  const startHeartbeat = () => {
                    pingTimer = setInterval(() => {
                      // Only ping after a real gap — no noise during normal streaming.
                      if (
                        sseCancelled
                        || upstreamSignal.aborted
                        || (controller.desiredSize ?? 1) <= 0
                        || Date.now() - lastActivity < PING_INTERVAL_MS
                      ) return;
                      try {
                        enqueue("event: ping\ndata: {\"type\":\"ping\"}\n\n");
                      } catch {
                        // Controller already closed — stop pinging.
                        stopHeartbeat();
                      }
                    }, PING_INTERVAL_MS);
                  };
                  try {
                    const msgId = `msg_${crypto.randomUUID()}`;
                    enqueue(
                      "event: message_start\ndata: " +
                      JSON.stringify({
                        type: "message_start",
                        message: {
                          id: msgId,
                          type: "message",
                          role: "assistant",
                          content: [],
                          model: anthropicModelId,
                          stop_reason: null,
                          stop_sequence: null,
                          usage: { input_tokens: 0, output_tokens: 0 }
                        }
                      }) + "\n\n"
                    );

                    // Stream is live — begin the keepalive heartbeat.
                    startHeartbeat();

                    let contentBlockIndex = 0;
                    let activeBlockType: "thinking" | "redacted_thinking" | "text" | "tool_use" | null = null;
                    // For title turns we buffer text deltas and emit the
                    // markdown-stripped title once at the end, since wrapping
                    // like **Title** can't be detected from a single delta.
                    let titleTextBuffer = "";

                    const closeActiveBlock = () => {
                      if (activeBlockType !== null) {
                        enqueue(
                          "event: content_block_stop\ndata: " +
                          JSON.stringify({
                            type: "content_block_stop",
                            index: contentBlockIndex - 1
                          }) + "\n\n"
                        );
                        activeBlockType = null;
                      }
                    };

                    const ensureBlockStarted = (type: "thinking" | "text") => {
                      if (activeBlockType === type) return;
                      closeActiveBlock();

                      activeBlockType = type;
                      enqueue(
                        "event: content_block_start\ndata: " +
                        JSON.stringify({
                          type: "content_block_start",
                          index: contentBlockIndex++,
                          content_block: {
                            type,
                            [type]: ""
                          }
                        }) + "\n\n"
                      );
                    };

                    // Process the buffered first event + remaining events
                    const processEvent = (event: any) => {
                      // Real event arrived — reset the heartbeat idle window.
                      lastActivity = Date.now();
                      if (event.type === "thinking_start") {
                        const block = event.partial?.content?.[event.contentIndex];
                        if (block?.type === "thinking" && block.redactedContent) {
                          closeActiveBlock();
                          activeBlockType = "redacted_thinking";
                          enqueue(
                            "event: content_block_start\ndata: " +
                            JSON.stringify({
                              type: "content_block_start",
                              index: contentBlockIndex++,
                              content_block: {
                                type: "redacted_thinking",
                                data: block.redactedContent,
                              },
                            }) + "\n\n"
                          );
                        }
                      } else if (event.type === "thinking_delta") {
                        ensureBlockStarted("thinking");
                        enqueue(
                          "event: content_block_delta\ndata: " +
                          JSON.stringify({
                            type: "content_block_delta",
                            index: contentBlockIndex - 1,
                            delta: {
                              type: "thinking_delta",
                              thinking: event.delta
                            }
                          }) + "\n\n"
                        );
                      } else if (event.type === "thinking_signature") {
                        ensureBlockStarted("thinking");
                        enqueue(
                          "event: content_block_delta\ndata: " +
                          JSON.stringify({
                            type: "content_block_delta",
                            index: contentBlockIndex - 1,
                            delta: {
                              type: "signature_delta",
                              signature: event.signature,
                            },
                          }) + "\n\n"
                        );
                      } else if (event.type === "thinking_end") {
                        if (activeBlockType === "thinking" || activeBlockType === "redacted_thinking") {
                          closeActiveBlock();
                        }
                      } else if (event.type === "text_delta") {
                        ensureBlockStarted("text");
                        if (isTitleTurn) {
                          // Buffer instead of streaming: we can only strip
                          // wrapping markdown (**Title**) once we have the
                          // whole title. Flushed in finalizeTitleBlock().
                          titleTextBuffer += event.delta;
                          return;
                        }
                        enqueue(
                          "event: content_block_delta\ndata: " +
                          JSON.stringify({
                            type: "content_block_delta",
                            index: contentBlockIndex - 1,
                            delta: {
                              type: "text_delta",
                              text: event.delta
                            }
                          }) + "\n\n"
                        );
                      } else if (event.type === "toolcall_start") {
                        closeActiveBlock();

                        const tc = event.partial.content[event.contentIndex];
                        if (tc && tc.type === "toolCall") {
                          activeBlockType = "tool_use";
                          enqueue(
                            "event: content_block_start\ndata: " +
                            JSON.stringify({
                              type: "content_block_start",
                              index: contentBlockIndex++,
                              content_block: {
                                type: "tool_use",
                                id: tc.id,
                                name: tc.name,
                                input: {}
                              }
                            }) + "\n\n"
                          );
                        }
                      } else if (event.type === "toolcall_delta") {
                        enqueue(
                          "event: content_block_delta\ndata: " +
                          JSON.stringify({
                            type: "content_block_delta",
                            index: contentBlockIndex - 1,
                            delta: {
                              type: "input_json_delta",
                              partial_json: event.delta
                            }
                          }) + "\n\n"
                        );
                      }
                    };

                    // Replay all buffered events
                    for (const ev of bufferedEvents) {
                      await waitForCapacity();
                      processEvent(ev);
                    }

                    // Continue with remaining events
                    for await (const event of { [Symbol.asyncIterator]: () => iter }) {
                      await waitForCapacity();
                      processEvent(event);
                    }

                    // Flush the buffered title (markdown-stripped) as a single
                    // text delta before closing the block. Only set on title
                    // turns; normal chat streamed its deltas live above.
                    if (isTitleTurn && titleTextBuffer.length > 0) {
                      const cleanTitle = stripTitleMarkdown(titleTextBuffer);
                      await waitForCapacity();
                      enqueue(
                        "event: content_block_delta\ndata: " +
                        JSON.stringify({
                          type: "content_block_delta",
                          index: contentBlockIndex - 1,
                          delta: { type: "text_delta", text: cleanTitle }
                        }) + "\n\n"
                      );
                    }

                    closeActiveBlock();

                    const finalMsg = await safeKiroStreamResult(kiroStream);
                    // Surface a stream-level error that occurred AFTER the
                    // initial buffering (e.g. failure after MAX_RETRIES). Any
                    // partial content was already streamed, so emit an Anthropic
                    // `error` SSE event instead of a silent `end_turn`.
                    if (finalMsg.stopReason === "error" || finalMsg.errorMessage) {
                      await waitForCapacity();
                      enqueue(
                        "event: error\ndata: " +
                        JSON.stringify({
                          type: "error",
                          error: {
                            type: "api_error",
                            message: formatKiroErrorDetail(finalMsg.errorMessage) || "Kiro stream error",
                          },
                        }) + "\n\n",
                      );
                      controller.close();
                      return;
                    }
                    const finishReason = anthropicStopReason(finalMsg);

                    const inputTokens = finalMsg.usage?.input ?? 0;
                    const outputTokens = finalMsg.usage?.output ?? 0;
                    const credits = finalMsg.usage?.cost?.total ?? 0;
                    stats.recordRequest({
                      id: msgId,
                      model: anthropicModelId,
                      inputTokens,
                      outputTokens,
                      credits,
                      stream: true,
                      effort: nativeEffort,
                    });

                    // NOTE (protocol deviation, kept on purpose) — Anthropic
                    // normally reports input_tokens in message_start. Kiro can't:
                    // it only reveals input-token usage at end-of-stream (via
                    // contextUsage/metering frames), so message_start above
                    // necessarily sent input_tokens: 0 and we report the real
                    // input_tokens here in message_delta. Anthropic clients read
                    // final cumulative usage from message_delta, so this is safe.
                    // Do NOT "fix" this by moving it back to message_start — the
                    // count isn't known yet there. Left documented in case a
                    // strict client ever expects input_tokens up front.
                    await waitForCapacity();
                    enqueue(
                      "event: message_delta\ndata: " +
                      JSON.stringify({
                        type: "message_delta",
                        delta: {
                          stop_reason: finishReason,
                          stop_sequence: null
                        },
                        usage: {
                          input_tokens: inputTokens,
                          output_tokens: outputTokens
                        }
                      }) + "\n\n"
                    );

                    enqueue("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
                    controller.close();
                  } catch (err) {
                    log.error("[gateway] Stream error:", err);
                    upstreamController.abort(err);
                    if (!sseCancelled) {
                      try {
                        enqueue(
                          "event: error\ndata: " +
                          JSON.stringify({
                            type: "error",
                            error: {
                              type: "api_error",
                              message: err instanceof Error ? err.message : String(err)
                            }
                          }) + "\n\n"
                        );
                        controller.close();
                      } catch {
                        // The client already disconnected; cancellation owns cleanup.
                      }
                    }
                  } finally {
                    // Always tear down the heartbeat — on success, error, or
                    // client disconnect — so the interval can't outlive the stream.
                    stopHeartbeat();
                  }
                  })();
                },
                pull() {
                  wakeBackpressure();
                },
                async cancel(reason) {
                  sseCancelled = true;
                  stopSseHeartbeat();
                  wakeBackpressure();
                  const abortError = reason instanceof Error
                    ? reason
                    : new Error(reason === undefined ? "SSE client disconnected" : String(reason));
                  upstreamController.abort(abortError);
                  await iter.return?.().catch(() => undefined);
                },
              }, { highWaterMark: 1 });

              return new Response(streamResponse, {
                headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  "Connection": "keep-alive",
                  "Access-Control-Allow-Origin": "*",
                }
              });
            } else {
              const finalMsg = await safeKiroStreamResult(kiroStream);
              // Surface stream-level errors instead of returning an empty,
              // successful-looking message.
              if (finalMsg.stopReason === "error" || finalMsg.errorMessage) {
                return anthropicError(502, "api_error", `Kiro: ${formatKiroErrorDetail(finalMsg.errorMessage)}`);
              }
              const contentParts = finalMsg.content;
              const anthropicContent: any[] = [];

              for (const part of contentParts) {
                if (part.type === "text") {
                  anthropicContent.push({
                    type: "text",
                    // Title turns: strip wrapping markdown (**Title**) the
                    // model adds despite the plain-text prompt.
                    text: isTitleTurn ? stripTitleMarkdown(part.text) : part.text,
                  });
                } else if (part.type === "thinking") {
                  if (part.redactedContent) {
                    anthropicContent.push({
                      type: "redacted_thinking",
                      data: part.redactedContent,
                    });
                  } else {
                    anthropicContent.push({
                      type: "thinking",
                      thinking: part.thinking,
                      ...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}),
                    });
                  }
                } else if (part.type === "toolCall") {
                  anthropicContent.push({
                    type: "tool_use",
                    id: part.id,
                    name: part.name,
                    input: typeof part.arguments === "string" ? JSON.parse(part.arguments) : part.arguments,
                  });
                }
              }

              const finishReason = anthropicStopReason(finalMsg);

              const msgId = `msg_${crypto.randomUUID()}`;
              
              const inputTokens = finalMsg.usage?.input ?? 0;
              const outputTokens = finalMsg.usage?.output ?? 0;
              const credits = finalMsg.usage?.cost?.total ?? 0;
              stats.recordRequest({
                id: msgId,
                model: anthropicModelId,
                inputTokens,
                outputTokens,
                credits,
                stream: false,
                effort: nativeEffort,
              });

              const responseBody = {
                id: msgId,
                type: "message",
                role: "assistant",
                content: anthropicContent,
                model: anthropicModelId,
                stop_reason: finishReason,
                stop_sequence: null,
                usage: {
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                }
              };

              return new Response(JSON.stringify(responseBody), {
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                }
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error("[gateway] Completions error:", msg);
            return anthropicError(500, "api_error", `Kiro gateway: ${msg}`);
          }
        }

        return anthropicError(404, "not_found_error", `Not Found: ${url.pathname}`);
      }
    });

    log.info(`Gateway server started on port ${server.port}`);
    resolve(server);
  });
}

function translateAnthropicToPi(messages: any[]): Message[] {
  const piMessages: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        piMessages.push({
          role: "user",
          content: msg.content,
          timestamp: Date.now(),
        });
      } else if (Array.isArray(msg.content)) {
        // Preserve the original ordering of tool_result vs text/image parts.
        // Anthropic normally puts tool_result first, but don't assume it —
        // emitting pi messages in declaration order keeps a tool_result that
        // follows text from being hoisted ahead of it.
        let pendingUserParts: any[] = [];
        const flushUserParts = () => {
          if (pendingUserParts.length > 0) {
            piMessages.push({
              role: "user",
              content: pendingUserParts as any,
              timestamp: Date.now(),
            });
            pendingUserParts = [];
          }
        };
        for (const part of msg.content) {
          if (part.type === "tool_result") {
            flushUserParts();
            piMessages.push({
              role: "toolResult",
              toolCallId: part.tool_use_id,
              content: typeof part.content === "string" ? part.content : (Array.isArray(part.content) ? part.content.map((c: any) => c.text ?? "").join("\n") : ""),
              isError: part.is_error || false,
              timestamp: Date.now(),
            } as any);
          } else if (part.type === "text") {
            pendingUserParts.push({ type: "text", text: part.text });
          } else if (part.type === "image" && part.source?.type === "base64") {
            pendingUserParts.push({ type: "image", mimeType: part.source.media_type, data: part.source.data });
          }
        }
        flushUserParts();
      }
    } else if (msg.role === "assistant") {
      const contentParts: any[] = [];
      if (typeof msg.content === "string") {
        contentParts.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            contentParts.push({ type: "text", text: part.text });
          } else if (part.type === "thinking") {
            contentParts.push({
              type: "thinking",
              thinking: part.thinking,
              ...(part.signature ? { thinkingSignature: part.signature } : {}),
            });
          } else if (part.type === "redacted_thinking") {
            contentParts.push({
              type: "thinking",
              thinking: "",
              redacted: true,
              redactedContent: part.data,
            });
          } else if (part.type === "tool_use") {
            contentParts.push({
              type: "toolCall",
              id: part.id,
              name: part.name,
              arguments: part.input,
            });
          }
        }
      }

      piMessages.push({
        role: "assistant",
        content: contentParts,
        stopReason: contentParts.some(p => p.type === "toolCall") ? "toolCalls" : "stop",
        timestamp: Date.now(),
      } as any);
    }
  }

  return piMessages;
}

function translateAnthropicToolsToPi(tools: any[]): any[] {
  return tools.map(t => {
    return {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    };
  });
}
