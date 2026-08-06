import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, Hooks, PluginModule } from "@opencode-ai/plugin";
import {
  initGatewayAuth,
  OPENCODE_CWD_HEADER,
  OPENCODE_EFFORT_HEADER,
  OPENCODE_PROFILE_ARN_HEADER,
  OPENCODE_REGION_HEADER,
  stopGatewayUsageRefresh,
  startGatewayServer,
} from "./server";
import {
  GATEWAY_CAPABILITIES,
  GATEWAY_CHALLENGE_HEADER,
  GATEWAY_PROTOCOL_VERSION,
  gatewayRequestHeaders,
  readGatewayJson,
  verifyGatewayChallengeProof,
} from "./gateway-auth";
export { gatewayRequestHeaders } from "./gateway-auth";
import { log } from "./debug";
import { 
  BUILDER_ID_START_URL, 
  BUILDER_ID_REGION, 
  IDC_PROBE_REGIONS,
  EXPIRES_BUFFER_MS,
  getKiroCredentialScope,
  tryRegisterAndAuthorize, 
  pollForToken, 
  refreshKiroToken,
  startSocialLogin,
  withKiroCredentialScope,
} from "./oauth";
import {
  kiroModels, 
  getCachedDynamicModels,
  findKiroModel,
  resolveProfileArn,
  resolveApiRegion,
  setCachedDynamicModels,
  formatModelName,
  type KiroModel,
  validateNativeKiroEffort,
} from "./models";
import {
  matchesPackedKiroCredential,
  type KiroCliCredentials,
} from "./kiro-cli-sync";

export const GATEWAY_PORT = 7438;

type GatewayServer = Awaited<ReturnType<typeof startGatewayServer>>;
type GatewayMode = "stopped" | "owned" | "shared";
type GatewayProbeStatus = "ready" | "starting" | "unavailable" | "incompatible";

interface GatewayRecoveryOptions {
  timeoutMs?: number;
  probeTimeoutMs?: number;
  retryIntervalMs?: number;
}

const GATEWAY_RECOVERY_TIMEOUT_MS = 30_000;
const GATEWAY_PROBE_TIMEOUT_MS = 1_500;
const GATEWAY_RETRY_INTERVAL_MS = 100;
const GATEWAY_CONFIG_CATALOG_TIMEOUT_MS = 5_000;

// Module-level state is shared by every workspace loaded in one OpenCode process.
let gatewayServer: GatewayServer | null = null;
let gatewayMode: GatewayMode = "stopped";
let gatewayStarting: Promise<void> | null = null;
let gatewayStopping: Promise<void> | null = null;
let gatewayConsumers = 0;
let gatewayTokenPromise: Promise<string> | null = null;

const GATEWAY_REPAIR_LOCK_STALE_MS = 30_000;

interface GatewayRepairLockOwner {
  raw: string;
  pid: number | null;
  createdAt: number;
}

async function tryAcquireGatewayTokenRepairLock(lockPath: string): Promise<string | null> {
  const owner = JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    nonce: randomBytes(16).toString("hex"),
  });
  try {
    await writeFile(lockPath, owner, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return null;
  }
}

async function readGatewayTokenRepairLock(lockPath: string): Promise<GatewayRepairLockOwner | null> {
  try {
    const [raw, metadata] = await Promise.all([
      readFile(lockPath, "utf8").then((value) => value.trim()),
      lstat(lockPath),
    ]);
    let pid: number | null = null;
    let createdAt = metadata.mtimeMs;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        const record = parsed as { pid?: unknown; createdAt?: unknown };
        if (Number.isInteger(record.pid) && Number(record.pid) > 0) pid = Number(record.pid);
        if (typeof record.createdAt === "number" && Number.isFinite(record.createdAt)) {
          createdAt = record.createdAt;
        }
      } else {
        const legacyPid = Number(parsed);
        if (Number.isInteger(legacyPid) && legacyPid > 0) pid = legacyPid;
      }
    } catch {
      const legacyPid = Number(raw);
      if (Number.isInteger(legacyPid) && legacyPid > 0) pid = legacyPid;
    }
    return { raw, pid, createdAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function gatewayRepairLockIsStale(owner: GatewayRepairLockOwner): boolean {
  if (Date.now() - owner.createdAt > GATEWAY_REPAIR_LOCK_STALE_MS) return true;
  if (!owner.pid) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function removeGatewayTokenRepairLockIfUnchanged(
  lockPath: string,
  expectedOwner: string,
): Promise<boolean> {
  const quarantinePath = `${lockPath}.quarantine.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    await rename(lockPath, quarantinePath);
    const movedOwner = await readFile(quarantinePath, "utf8").then((value) => value.trim());
    if (movedOwner !== expectedOwner) {
      // The lock changed between observation and rename. Restore it only when
      // no newer contender has already acquired the canonical path.
      await link(quarantinePath, lockPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  } finally {
    await unlink(quarantinePath).catch(() => undefined);
  }
}

async function repairGatewayToken(tokenPath: string): Promise<string> {
  const lockPath = `${tokenPath}.repair.lock`;
  for (let attempt = 0; attempt < 200; attempt++) {
    const owner = await tryAcquireGatewayTokenRepairLock(lockPath);
    if (owner) {
      const generated = randomBytes(32).toString("hex");
      const temporaryPath = `${tokenPath}.${process.pid}.${randomBytes(8).toString("hex")}.repair.tmp`;
      try {
        const current = await readFile(tokenPath, "utf8").then((value) => value.trim()).catch(() => "");
        if (current.length >= 32) return current;
        await writeFile(temporaryPath, generated, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporaryPath, tokenPath);
        await chmod(tokenPath, 0o600).catch(() => undefined);
        return generated;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
        await removeGatewayTokenRepairLockIfUnchanged(lockPath, owner).catch(() => undefined);
      }
    }

    const token = await readFile(tokenPath, "utf8").then((value) => value.trim()).catch(() => "");
    if (token.length >= 32) return token;

    const observed = await readGatewayTokenRepairLock(lockPath);
    if (!observed) continue;
    if (gatewayRepairLockIsStale(observed)) {
      await removeGatewayTokenRepairLockIfUnchanged(lockPath, observed.raw);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 11)));
  }
  throw new Error(`Gateway token repair is held by another active process: ${lockPath}`);
}

/** @internal — deterministic regression seam for stale-lock recovery. */
export const _repairGatewayTokenForTest = repairGatewayToken;

async function loadGatewayToken(): Promise<string> {
  const configuredOverride = process.env.KIRO_GATEWAY_TOKEN;
  if (configuredOverride !== undefined) {
    const override = configuredOverride.trim();
    if (override.length < 32) {
      throw new Error("KIRO_GATEWAY_TOKEN must be at least 32 characters");
    }
    return override;
  }

  const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const directory = join(cacheRoot, "opencode-kiro");
  const tokenPath = join(directory, "gateway-token");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);

  const generated = randomBytes(32).toString("hex");
  const temporaryPath = `${tokenPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporaryPath, generated, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await link(temporaryPath, tokenPath);
    await chmod(tokenPath, 0o600).catch(() => undefined);
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }

  const token = await readFile(tokenPath, "utf8").then((value) => value.trim()).catch(() => "");
  if (token.length >= 32) {
    await chmod(tokenPath, 0o600).catch(() => undefined);
    return token;
  }

  return repairGatewayToken(tokenPath);
}

/** @internal — validates an explicit override without populating shared state. */
export const _loadGatewayTokenForTest = loadGatewayToken;

async function getGatewayToken(): Promise<string> {
  if (!gatewayTokenPromise) {
    gatewayTokenPromise = loadGatewayToken().catch((error) => {
      gatewayTokenPromise = null;
      throw error;
    });
  }
  return gatewayTokenPromise;
}

function gatewayOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function probeGateway(
  port: number,
  gatewayToken?: string,
  timeoutMs: number = GATEWAY_PROBE_TIMEOUT_MS,
): Promise<GatewayProbeStatus> {
  try {
    const challenge = crypto.randomUUID();
    const response = await fetch(`${gatewayOrigin(port)}/health`, {
      headers: { [GATEWAY_CHALLENGE_HEADER]: challenge },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return "unavailable";
    const body = await readGatewayJson<{
      service?: string;
      protocolVersion?: number;
      capabilities?: string[];
      ready?: boolean;
      proof?: string;
    }>(response);
    const compatible =
      body.service === "opencode-kiro-gateway" &&
      body.protocolVersion === GATEWAY_PROTOCOL_VERSION &&
      GATEWAY_CAPABILITIES.every((capability) => body.capabilities?.includes(capability)) &&
      (!gatewayToken || verifyGatewayChallengeProof(gatewayToken, challenge, body.proof));
    if (!compatible) return "incompatible";
    return body.ready === false ? "starting" : "ready";
  } catch {
    return "unavailable";
  }
}

async function waitForCompatibleGateway(
  port: number,
  gatewayToken: string | undefined,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const unavailableDeadline = Date.now() + 2_000;
  let sawStarting = false;
  while (Date.now() < deadline) {
    const status = await probeGateway(port, gatewayToken);
    if (status === "ready") return true;
    if (status === "incompatible") {
      throw new Error(`Port ${port} is owned by an incompatible local service`);
    }
    if (status === "starting") sawStarting = true;
    if (status === "unavailable" && (sawStarting || Date.now() >= unavailableDeadline)) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Start the gateway or attach to a compatible instance owned by another process. */
export async function startOrAttachGateway(
  port: number,
  initialize: () => Promise<void> = initGatewayAuth,
  gatewayToken?: string,
  recovery: GatewayRecoveryOptions = {},
): Promise<{ mode: Exclude<GatewayMode, "stopped">; server: GatewayServer | null }> {
  let ready = false;
  let server: GatewayServer | null = null;
  try {
    server = await startGatewayServer(port, { isReady: () => ready, gatewayToken });
  } catch (startError) {
    const timeoutMs = recovery.timeoutMs ?? GATEWAY_RECOVERY_TIMEOUT_MS;
    const probeTimeoutMs = recovery.probeTimeoutMs ?? GATEWAY_PROBE_TIMEOUT_MS;
    const retryIntervalMs = recovery.retryIntervalMs ?? GATEWAY_RETRY_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    let lastStartError: unknown = startError;
    let lastStatus: GatewayProbeStatus = "unavailable";

    // The current owner can be temporarily unable to answer /health while its
    // event loop is busy, or it can exit between our probe and bind attempt.
    // Keep alternating authenticated probes and takeover attempts until one
    // process wins instead of giving up after one failed rebind.
    while (Date.now() < deadline) {
      lastStatus = await probeGateway(port, gatewayToken, probeTimeoutMs);
      if (lastStatus === "ready") {
        return { mode: "shared", server: null };
      }
      if (lastStatus === "incompatible") {
        throw new Error(`Port ${port} is owned by an incompatible local service`);
      }

      if (lastStatus === "unavailable") {
        try {
          server = await startGatewayServer(port, { isReady: () => ready, gatewayToken });
          break;
        } catch (retryError) {
          lastStartError = retryError;
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(retryIntervalMs, remainingMs)));
      }
    }

    if (!server) {
      const detail = lastStartError instanceof Error ? lastStartError.message : String(lastStartError);
      const initialDetail = startError instanceof Error ? startError.message : String(startError);
      throw new Error(
        `Cannot start or attach to the local gateway on port ${port} after ${timeoutMs}ms `
        + `(last probe: ${lastStatus}): ${detail} (${initialDetail})`,
      );
    }
  }

  try {
    await initialize();
    ready = true;
    return { mode: "owned", server };
  } catch (error) {
    await server.stop(true);
    throw error;
  }
}

/** Fetch the gateway catalog after auth initialization and cache it in this process. */
interface GatewayCatalogCredentials {
  accessToken: string;
  region: string;
  profileArn?: string;
}

/** Prefer the live Kiro CLI token when OpenCode auth points at the same credential row. */
export function resolveKiroLoaderCredentials(
  auth: any,
  imported: KiroCliCredentials | null,
): GatewayCatalogCredentials | null {
  if (!auth || auth.type !== "oauth" || typeof auth.access !== "string" || !auth.access) return null;
  if (
    typeof auth.refresh === "string"
    && matchesPackedKiroCredential(auth.refresh, imported)
    && imported?.accessToken
  ) {
    return {
      accessToken: imported.accessToken,
      region: imported.region || BUILDER_ID_REGION,
      profileArn: imported.profileArn,
    };
  }

  const metadata = auth.metadata ?? {};
  const scope = typeof auth.refresh === "string"
    ? getKiroCredentialScope(auth.refresh)
    : {};
  return {
    accessToken: auth.access,
    region: metadata.region || scope.region || BUILDER_ID_REGION,
    profileArn: metadata.profileArn || scope.profileArn,
  };
}

async function resolveKiroAuthCredentials(auth: any): Promise<GatewayCatalogCredentials | null> {
  let imported: KiroCliCredentials | null = null;
  if (auth?.type === "oauth" && typeof auth.refresh === "string") {
    const { importFromKiroCli } = await import("./kiro-cli-sync");
    imported = await importFromKiroCli();
  }
  return resolveKiroLoaderCredentials(auth, imported);
}

async function loadOpenCodeKiroCredentials(): Promise<GatewayCatalogCredentials | null> {
  const parse = (raw: string): any => {
    const record = JSON.parse(raw) as Record<string, unknown>;
    return record?.kiro ?? record?.["kiro/"] ?? null;
  };

  let auth: any = null;
  const inline = process.env.OPENCODE_AUTH_CONTENT;
  if (inline) {
    try {
      auth = parse(inline);
    } catch {
      // Match OpenCode: malformed inline content falls back to auth.json.
    }
  }
  if (!auth) {
    try {
      const dataRoot = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
      auth = parse(await readFile(join(dataRoot, "opencode", "auth.json"), "utf8"));
    } catch {
      return null;
    }
  }
  return resolveKiroAuthCredentials(auth);
}

async function loadLocalCatalogCredentials(): Promise<GatewayCatalogCredentials | null> {
  try {
    const { importFromKiroCli } = await import("./kiro-cli-sync");
    const credentials = await importFromKiroCli();
    if (!credentials?.accessToken) return null;
    return {
      accessToken: credentials.accessToken,
      region: credentials.region || BUILDER_ID_REGION,
      profileArn: credentials.profileArn,
    };
  } catch (error) {
    log.warn("[opencode-kiro] Failed to load local credentials for model discovery", error);
    return null;
  }
}

export async function loadGatewayModels(
  port: number,
  gatewayToken?: string,
  credentials?: GatewayCatalogCredentials,
  timeoutMs = 30_000,
  cacheModels = true,
): Promise<KiroModel[] | null> {
  try {
    const headers: Record<string, string> = {};
    if (gatewayToken) {
      Object.assign(headers, gatewayRequestHeaders(gatewayToken, "GET", "/v1/models?refresh=1"));
    }
    if (credentials) {
      headers.Authorization = `Bearer ${credentials.accessToken}`;
      headers[OPENCODE_REGION_HEADER] = credentials.region;
      if (credentials.profileArn) headers[OPENCODE_PROFILE_ARN_HEADER] = credentials.profileArn;
    }
    const response = await fetch(`${gatewayOrigin(port)}/v1/models?refresh=1`, {
      headers,
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    if (!response.ok) return null;
    const body = await readGatewayJson<{ data?: KiroModel[]; source?: "dynamic" | "static" }>(
      response,
      1024 * 1024,
    );
    const models = Array.isArray(body.data)
      ? body.data.filter((model) => model && typeof model.id === "string" && typeof model.name === "string")
      : [];
    if (body.source !== "dynamic") return null;
    if (cacheModels) setCachedDynamicModels(models);
    return models;
  } catch (error) {
    log.warn("[opencode-kiro] Failed to load gateway model catalog", error);
    return null;
  }
}

const ANTHROPIC_DEFAULT_EFFORT_VARIANTS = ["high", "max"] as const;

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function mergeCatalogVariants(model: KiroModel, configuredVariants: unknown): Record<string, any> | undefined {
  const configured = asRecord(configuredVariants);
  const variants: Record<string, any> = {};
  const nativeEfforts = model.nativeEfforts ?? [];
  if (!model.reasoning && nativeEfforts.length === 0 && Object.keys(configured).length === 0) return undefined;

  for (const effort of nativeEfforts) {
    const configuredEffort = asRecord(configured[effort]);
    if (effort === "none") {
      variants[effort] = {
        ...configuredEffort,
        thinking: { ...asRecord(configuredEffort.thinking), type: "disabled" },
      };
      continue;
    }
    // `effort` is passed through @ai-sdk/anthropic as output_config.effort.
    variants[effort] = { ...configuredEffort, effort };
  }

  for (const [name, variant] of Object.entries(configured)) {
    if (!(name in variants)) variants[name] = variant;
  }

  // OpenCode otherwise creates Anthropic's high/max defaults. Disable only
  // unconfigured defaults that the catalog did not advertise.
  for (const effort of ANTHROPIC_DEFAULT_EFFORT_VARIANTS) {
    if (!nativeEfforts.includes(effort) && !(effort in variants)) {
      variants[effort] = { disabled: true };
    }
  }
  return variants;
}

/** @internal Exported for focused provider-configuration tests. */
export function applyKiroProviderConfig(
  cfg: any,
  models: KiroModel[],
  port: number = GATEWAY_PORT,
): void {
  cfg.provider = cfg.provider ?? {};
  cfg.provider.kiro = cfg.provider.kiro ?? {};
  const kiro = cfg.provider.kiro;
  const api = kiro.api ?? `${gatewayOrigin(port)}/v1`;
  kiro.name = kiro.name ?? "Kiro AWS";
  kiro.npm = kiro.npm ?? "@ai-sdk/anthropic";
  kiro.api = api;
  kiro.models = kiro.models ?? {};

  for (const model of models) {
    const existingModel = asRecord(kiro.models[model.id]);
    const hasCatalogEfforts = (model.nativeEfforts?.length ?? 0) > 0;
    const generatedModel = {
      id: model.id,
      name: formatModelName(model),
      // Catalog variants are authoritative. Disabling transport-derived
      // reasoning presets prevents OpenCode from prepending Anthropic's
      // high/max defaults to Bedrock-backed Kiro models.
      reasoning: hasCatalogEfforts ? false : model.reasoning,
      temperature: true,
      tool_call: true,
      attachment: model.input.includes("image"),
      modalities: {
        input: model.input.includes("image") ? ["text", "image"] : ["text"],
        output: ["text"],
      },
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      limit: { context: model.contextWindow, output: model.maxTokens },
      status: "active",
      release_date: "2026-06-15",
      provider: { npm: "@ai-sdk/anthropic", api },
    };
    const variants = mergeCatalogVariants(model, existingModel.variants);
    kiro.models[model.id] = {
      ...generatedModel,
      ...existingModel,
      reasoning: hasCatalogEfforts ? false : existingModel.reasoning ?? generatedModel.reasoning,
      cost: { ...generatedModel.cost, ...asRecord(existingModel.cost) },
      limit: { ...generatedModel.limit, ...asRecord(existingModel.limit) },
      modalities: { ...generatedModel.modalities, ...asRecord(existingModel.modalities) },
      provider: { ...generatedModel.provider, ...asRecord(existingModel.provider) },
      ...(variants ? { variants } : {}),
    };
  }
}

/**
 * Headers injected into every model request so the gateway receives both the
 * stable OpenCode session id and the workspace owned by this plugin process.
 *
 * The gateway derives the conversationId from the `x-session-id` header (see
 * `deriveLogSessionId` in server.ts). OpenCode's session id is stable for the
 * life of a conversation AND survives a restart (`opencode -s <id>` resumes the
 * same id), so the conversationId stays constant across turns and restarts —
 * matching the real Kiro CLI. Without this the gateway fell back to an
 * ephemeral header / first-message fingerprint, so the id changed on every
 * restart and the logs scattered across files.
 *
 * Exported for testing. Blank values are omitted.
 */
export function kiroSessionHeaders(
  sessionID: string | undefined,
  workingDirectory?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof sessionID === "string" && sessionID.trim().length > 0) {
    headers["x-session-id"] = sessionID.trim();
  }
  if (typeof workingDirectory === "string" && workingDirectory.trim().length > 0) {
    headers[OPENCODE_CWD_HEADER] = workingDirectory.trim();
  }
  return headers;
}

/** Return a local-only effort header for a catalog-valid OpenCode variant. */
export function kiroEffortHeader(
  input: any,
  scopedModels?: KiroModel[],
): Record<string, string> {
  const selectedModel = input?.message?.model;
  const modelId = selectedModel?.modelID ?? selectedModel?.id ?? input?.model?.id;
  const model = typeof modelId === "string"
    ? scopedModels === undefined
      ? findKiroModel(modelId)
      : scopedModels.find((entry) => entry.id === modelId)
    : undefined;
  const effort = validateNativeKiroEffort(
    model,
    selectedModel?.variant,
  );
  return effort ? { [OPENCODE_EFFORT_HEADER]: effort } : {};
}

export const KiroPlugin: Plugin = async (input) => {
  const workingDirectory = input.directory;
  let disposed = false;
  let accountCatalogModels: KiroModel[] | undefined;
  gatewayConsumers++;

  async function ensureGateway(): Promise<void> {
    if (gatewayStopping) {
      await gatewayStopping.catch((error) => {
        log.warn("[opencode-kiro] Previous gateway shutdown failed", error);
      });
    }
    if (gatewayStarting) return gatewayStarting;
    if (gatewayMode === "owned" && gatewayServer) return;
    const gatewayToken = await getGatewayToken();
    if (gatewayMode === "shared") {
      const status = await probeGateway(GATEWAY_PORT, gatewayToken);
      if (status === "ready") return;
      if (status === "starting" && await waitForCompatibleGateway(GATEWAY_PORT, gatewayToken)) return;
      gatewayMode = "stopped";
    }
    // Another caller may have won startup while this one awaited the shared probe.
    if (gatewayStarting) return gatewayStarting;
    if (gatewayMode === "owned" && gatewayServer) return;

    gatewayStarting = (async () => {
      try {
        const connection = await startOrAttachGateway(GATEWAY_PORT, initGatewayAuth, gatewayToken);
        gatewayMode = connection.mode;
        gatewayServer = connection.server;
        log.info(
          connection.mode === "owned"
            ? `[opencode-kiro] Gateway server active on ${gatewayOrigin(GATEWAY_PORT)}`
            : `[opencode-kiro] Attached to shared gateway on ${gatewayOrigin(GATEWAY_PORT)}`,
        );
      } catch (err) {
        log.error("[opencode-kiro] Failed to start gateway", err);
        gatewayServer = null;
        gatewayMode = "stopped";
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`[opencode-kiro] Cannot establish the local gateway: ${detail}`);
      } finally {
        gatewayStarting = null;
      }
    })();
    return gatewayStarting;
  }

  const hooks: Hooks = {
    // Bind every model request to its OpenCode session id (as `x-session-id`),
    // and verify the local gateway before the request is sent.
    "chat.headers": async (input, output) => {
      const provider = input?.provider as any;
      const pid = provider?.id ?? provider?.info?.id;
      if (pid !== "kiro") return;
      const modelApi = (input?.model as any)?.api?.url as string | undefined;
      if (modelApi && !modelApi.startsWith(`${gatewayOrigin(GATEWAY_PORT)}/`)) return;
      await ensureGateway();
      Object.assign(output.headers, {
        ...kiroSessionHeaders(input?.sessionID, workingDirectory),
        ...kiroEffortHeader(input, accountCatalogModels),
        ...gatewayRequestHeaders(await getGatewayToken()),
      });
    },

    // Only the owning process can stop the listener; shared processes leave it alone.
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      gatewayConsumers = Math.max(0, gatewayConsumers - 1);
      if (gatewayConsumers > 0) return;
      if (gatewayStarting) await gatewayStarting.catch(() => undefined);
      // A workspace may have attached while startup was settling.
      if (gatewayConsumers > 0) return;
      if (gatewayMode === "owned" && gatewayServer) {
        const server = gatewayServer;
        gatewayServer = null;
        gatewayMode = "stopped";
        stopGatewayUsageRefresh();
        log.info("[opencode-kiro] Shutting down owned gateway server...");
        const stopping = server.stop(true);
        gatewayStopping = stopping;
        try {
          await stopping;
        } finally {
          if (gatewayStopping === stopping) gatewayStopping = null;
        }
      }
      gatewayMode = "stopped";
    },

    auth: {
      provider: "kiro",
      loader: async (getAuth, provider) => {
        // El gateway arranca en chat.headers (no aquí — el auth.loader corre al
        // startup para todos los providers).
        try {
          const auth = await getAuth() as any;
          const credentials = await resolveKiroAuthCredentials(auth);
          if (credentials) {
            return {
              headers: {
                Authorization: `Bearer ${credentials.accessToken}`,
                [OPENCODE_REGION_HEADER]: credentials.region,
                ...(credentials.profileArn ? { [OPENCODE_PROFILE_ARN_HEADER]: credentials.profileArn } : {}),
              },
              apiKey: credentials.accessToken,
            };
          }
        } catch (e) {
          log.error("[opencode-kiro] Error in auth loader", e);
        }
        return {};
      },
      methods: [
        // ── 1. AWS Builder ID (Social PKCE) ────────────────────────
        {
          type: "oauth",
          label: "AWS Builder ID (personal account)",
          prompts: [],
          authorize: async () => {
            const { signInUrl, waitForCredentials } = await startSocialLogin();

            return {
              url: signInUrl,
              instructions: "Complete sign-in in your browser. OpenCode will continue automatically.",
              method: "auto",
              callback: async () => {
                try {
                  const creds = await waitForCredentials();

                  return {
                    type: "success" as const,
                    access: creds.accessToken,
                    refresh: creds.refreshPacked,
                    expires: creds.expiresAt,
                    metadata: {
                      region: creds.region,
                      authMethod: creds.authMethod,
                      profileArn: creds.profileArn
                    }
                  };
                } catch {
                  return { type: "failed" as const };
                }
              }
            };
          }
        },
        // ── 2. IAM Identity Center ─────────────────────────────────
        {
          type: "oauth",
          label: "IAM Identity Center (enterprise SSO)",
          prompts: [
            {
              type: "text" as const,
              key: "sso_url",
              message: "Paste your IAM Identity Center start URL:",
              placeholder: "https://mycompany.awsapps.com/start",
            },
            {
              type: "text" as const,
              key: "sso_region",
              message: "Identity Center region (optional, blank to auto-detect):",
              placeholder: "us-east-1",
            }
          ],
          authorize: async (inputs = {}) => {
            const ssoUrl = inputs.sso_url?.trim();
            if (!ssoUrl || !ssoUrl.startsWith("http")) {
              throw new Error(`Invalid start URL "${ssoUrl ?? ""}" — expected https://…`);
            }

            const ssoRegion = inputs.sso_region?.trim();
            const regions = ssoRegion ? [ssoRegion] : IDC_PROBE_REGIONS;

            let result: any = null;
            let detectedRegion = "";
            for (const region of regions) {
              result = await tryRegisterAndAuthorize(ssoUrl, region);
              if (result) {
                detectedRegion = region;
                break;
              }
            }

            if (!result || !detectedRegion) {
              throw new Error(`Could not authorize ${ssoUrl} in ${regions.join(", ")}.`);
            }

            return {
              url: result.devAuth.verificationUriComplete,
              instructions: `AWS Verification Code: ${result.devAuth.userCode}\nComplete authorization in your browser, then OpenCode will continue automatically.`,
              method: "auto",
              callback: async () => {
                const tok = await pollForToken(
                  result.oidcEndpoint,
                  result.clientId,
                  result.clientSecret,
                  result.devAuth,
                  undefined
                );

                if (!tok.accessToken || !tok.refreshToken) {
                  return { type: "failed" };
                }

                const apiRegion = resolveApiRegion(detectedRegion);
                const arn = await resolveProfileArn(tok.accessToken, apiRegion);

                return {
                  type: "success",
                  access: tok.accessToken,
                  refresh: withKiroCredentialScope(
                    `${tok.refreshToken}|${result.clientId}|${result.clientSecret}|idc||`,
                    detectedRegion,
                    arn ?? undefined,
                  ),
                  expires: Date.now() + (tok.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
                  metadata: {
                    region: detectedRegion,
                    authMethod: "idc",
                    profileArn: arn
                  }
                };
              }
            };
          }
        },
        // ── 3. Import from Kiro CLI/IDE ────────────────────────────
        {
          type: "oauth",
          label: "Import from Kiro CLI/IDE (auto-sync)",
          prompts: [],
          authorize: async () => {
            const { importFromKiroCli } = await import("./kiro-cli-sync");
            const imported = await importFromKiroCli();

            if (!imported || (!imported.accessToken && !imported.refreshToken)) {
              throw new Error(
                "No Kiro CLI/IDE credentials found.\n" +
                "Make sure Kiro CLI or IDE is installed and you're logged in, then try again."
              );
            }

            const authMethod = imported.authMethod || "desktop";
            const region = imported.region || "us-east-1";
            const packParts = [
              imported.refreshToken,
              imported.clientId || "",
              imported.clientSecret || "",
              authMethod,
              imported.source || "",
              imported.tokenKey || "",
            ];
            const packedCredential = withKiroCredentialScope(
              packParts.join("|"),
              region,
              imported.profileArn,
            );

            return {
              url: "",
              method: "auto" as const,
              instructions: `Imported from Kiro ${imported.email ? `(${imported.email}, ` : "("}${authMethod}, ${region})`,
              callback: async () => {
                // If access token looks valid, use it directly
                if (imported.accessToken) {
                  return {
                    type: "success" as const,
                    access: imported.accessToken,
                    refresh: packedCredential,
                    expires: Date.now() + 3600 * 1000 - EXPIRES_BUFFER_MS,
                    metadata: { region, authMethod, profileArn: imported.profileArn }
                  };
                }

                // Otherwise try to refresh
                try {
                  const refreshed = await refreshKiroToken(
                    packedCredential,
                    region,
                    authMethod as any
                  );
                  return {
                    type: "success" as const,
                    access: refreshed.access,
                    refresh: refreshed.refresh,
                    expires: refreshed.expires,
                    metadata: { region, authMethod, profileArn: imported.profileArn }
                  };
                } catch {
                  return { type: "failed" as const };
                }
              }
            };
          }
        },
        // ── 4. Desktop refresh token (manual) ──────────────────────
        {
          type: "oauth",
          label: "Desktop refresh token (manual)",
          prompts: [
            {
              type: "text" as const,
              key: "refresh_token",
              message: "Paste your Kiro desktop refresh token\n(find it in ~/.kiro/db or ~/.aws/sso/cache/):",
              placeholder: "refresh-token",
            },
            {
              type: "text" as const,
              key: "region",
              message: "Kiro region:",
              placeholder: "us-east-1",
            }
          ],
          authorize: async (inputs = {}) => {
            const refreshToken = inputs.refresh_token?.trim();
            if (!refreshToken) {
              throw new Error("No refresh token provided.");
            }

            const region = inputs.region?.trim() || "us-east-1";
            const packed = withKiroCredentialScope(`${refreshToken}|||desktop||`, region);

            return {
              url: "",
              method: "auto" as const,
              instructions: "Exchanging refresh token…",
              callback: async () => {
                try {
                  const refreshed = await refreshKiroToken(packed, region, "desktop");
                  return {
                    type: "success" as const,
                    access: refreshed.access,
                    refresh: refreshed.refresh,
                    expires: refreshed.expires,
                    metadata: { region, authMethod: "desktop" }
                  };
                } catch (err) {
                  throw new Error(`Desktop token refresh failed: ${err}`);
                }
              }
            };
          }
        }
      ]
    },

    // Inject kiro provider + models into config.
    // OpenCode's plugin models hook only works for providers already in modelsDev.
    // For new providers like kiro, we must inject via config mutation before
    // cfg.provider is read by the config providers loop.
    config: async (cfg: any) => {
      const cachedModels = getCachedDynamicModels();
      const activeCredentials = await loadOpenCodeKiroCredentials();
      let models = activeCredentials ? kiroModels : cachedModels ?? kiroModels;
      const configuredApi = cfg.provider?.kiro?.api as string | undefined;
      const usesLocalGateway = !configuredApi || configuredApi.startsWith(`${gatewayOrigin(GATEWAY_PORT)}/`);
      if (usesLocalGateway) {
        try {
          await ensureGateway();
          if (activeCredentials) {
            const loadedModels = await loadGatewayModels(
              GATEWAY_PORT,
              await getGatewayToken(),
              activeCredentials,
              GATEWAY_CONFIG_CATALOG_TIMEOUT_MS,
              false,
            );
            if (loadedModels !== null) {
              models = loadedModels;
              accountCatalogModels = loadedModels;
            }
          } else if (cachedModels === null) {
            const catalogCredentials = await loadLocalCatalogCredentials();
            const loadedModels = gatewayMode === "owned" || catalogCredentials
              ? await loadGatewayModels(
                  GATEWAY_PORT,
                  await getGatewayToken(),
                  catalogCredentials ?? undefined,
                  GATEWAY_CONFIG_CATALOG_TIMEOUT_MS,
                  !catalogCredentials,
                )
              : null;
            if (loadedModels !== null) {
              models = loadedModels;
              if (catalogCredentials) accountCatalogModels = loadedModels;
            }
          }
        } catch (error) {
          log.warn("[opencode-kiro] Gateway unavailable during config; using fallback models", error);
        }
      }
      applyKiroProviderConfig(cfg, models, GATEWAY_PORT);
    },
  };

  return hooks;
};

export default {
  id: "opencode-kiro",
  server: KiroPlugin,
} satisfies PluginModule;
