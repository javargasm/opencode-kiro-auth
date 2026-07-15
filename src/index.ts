// Route ALL logs to a file — keeps OpenCode status bar clean.
// Every Kiro file log lives under /tmp/kiro-logs/ and carries a session id in
// its name. Per-request logs route to session-{id}.log (via AsyncLocalStorage,
// see file-logger.ts); logs with no request context (startup, auth refresh)
// fall back here, to the "gateway" pseudo-session.
process.env.KIRO_LOG = process.env.KIRO_LOG || "debug";
process.env.KIRO_LOG_FILE = process.env.KIRO_LOG_FILE || "/tmp/kiro-logs/session-gateway.log";

import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, Hooks, PluginModule } from "@opencode-ai/plugin";
import {
  GATEWAY_AUTH_HEADER,
  GATEWAY_AUTH_NONCE_HEADER,
  GATEWAY_AUTH_TIMESTAMP_HEADER,
  GATEWAY_CAPABILITIES,
  GATEWAY_CHALLENGE_HEADER,
  GATEWAY_PROTOCOL_VERSION,
  gatewayChallengeProof,
  gatewayRequestSignature,
  initGatewayAuth,
  OPENCODE_CWD_HEADER,
  OPENCODE_EFFORT_HEADER,
  OPENCODE_PROFILE_ARN_HEADER,
  OPENCODE_REGION_HEADER,
  startGatewayServer,
} from "./server";
import { log } from "./debug";
import { 
  BUILDER_ID_START_URL, 
  BUILDER_ID_REGION, 
  IDC_PROBE_REGIONS,
  EXPIRES_BUFFER_MS,
  tryRegisterAndAuthorize, 
  pollForToken, 
  refreshKiroToken,
  startSocialLogin,
} from "./oauth";
import {
  kiroModels, 
  getCachedDynamicModels,
  findKiroModel,
  fetchAvailableModels,
  resolveProfileArn,
  buildModelsFromApi,
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

// Module-level state is shared by every workspace loaded in one OpenCode process.
let gatewayServer: GatewayServer | null = null;
let gatewayMode: GatewayMode = "stopped";
let gatewayStarting: Promise<void> | null = null;
let gatewayConsumers = 0;
let gatewayTokenPromise: Promise<string> | null = null;

async function repairGatewayToken(tokenPath: string): Promise<string> {
  const lockPath = `${tokenPath}.repair.lock`;
  const ownerPath = `${lockPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(ownerPath, String(process.pid), { encoding: "utf8", flag: "wx", mode: 0o600 });
  let ownsLock = false;
  try {
    await link(ownerPath, lockPath);
    ownsLock = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(ownerPath).catch(() => undefined);
  }

  if (!ownsLock) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const token = await readFile(tokenPath, "utf8").then((value) => value.trim()).catch(() => "");
      if (token.length >= 32) return token;

      const ownerPid = Number(await readFile(lockPath, "utf8").catch(() => ""));
      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            throw new Error(`Stale gateway token repair lock from PID ${ownerPid}: ${lockPath}`);
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Gateway token repair is held by another active process: ${lockPath}`);
  }

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
    await unlink(lockPath).catch(() => undefined);
  }
}

async function loadGatewayToken(): Promise<string> {
  const override = process.env.KIRO_GATEWAY_TOKEN?.trim();
  if (override) return override;

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

export function gatewayRequestHeaders(gatewayToken: string): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  return {
    [GATEWAY_AUTH_HEADER]: gatewayRequestSignature(gatewayToken, timestamp, nonce),
    [GATEWAY_AUTH_TIMESTAMP_HEADER]: timestamp,
    [GATEWAY_AUTH_NONCE_HEADER]: nonce,
  };
}

export async function probeGateway(port: number, gatewayToken?: string): Promise<GatewayProbeStatus> {
  try {
    const challenge = crypto.randomUUID();
    const response = await fetch(`${gatewayOrigin(port)}/health`, {
      headers: { [GATEWAY_CHALLENGE_HEADER]: challenge },
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return "unavailable";
    const body = await response.json() as {
      service?: string;
      protocolVersion?: number;
      capabilities?: string[];
      ready?: boolean;
      proof?: string;
    };
    const compatible =
      body.service === "opencode-kiro-gateway" &&
      body.protocolVersion === GATEWAY_PROTOCOL_VERSION &&
      GATEWAY_CAPABILITIES.every((capability) => body.capabilities?.includes(capability)) &&
      (!gatewayToken || body.proof === gatewayChallengeProof(gatewayToken, challenge));
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
): Promise<{ mode: Exclude<GatewayMode, "stopped">; server: GatewayServer | null }> {
  let ready = false;
  let server: GatewayServer;
  try {
    server = await startGatewayServer(port, { isReady: () => ready, gatewayToken });
  } catch (startError) {
    if (await waitForCompatibleGateway(port, gatewayToken)) {
      return { mode: "shared", server: null };
    }
    try {
      server = await startGatewayServer(port, { isReady: () => ready, gatewayToken });
    } catch (retryError) {
      const detail = retryError instanceof Error ? retryError.message : String(retryError);
      const initialDetail = startError instanceof Error ? startError.message : String(startError);
      throw new Error(`Cannot start or attach to the local gateway on port ${port}: ${detail} (${initialDetail})`);
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
  return {
    accessToken: auth.access,
    region: metadata.region || BUILDER_ID_REGION,
    profileArn: metadata.profileArn,
  };
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
): Promise<KiroModel[] | null> {
  try {
    const headers: Record<string, string> = {};
    if (gatewayToken) Object.assign(headers, gatewayRequestHeaders(gatewayToken));
    if (credentials) {
      headers.Authorization = `Bearer ${credentials.accessToken}`;
      headers[OPENCODE_REGION_HEADER] = credentials.region;
      if (credentials.profileArn) headers[OPENCODE_PROFILE_ARN_HEADER] = credentials.profileArn;
    }
    const response = await fetch(`${gatewayOrigin(port)}/v1/models?refresh=1`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { data?: KiroModel[]; source?: "dynamic" | "static" };
    const models = Array.isArray(body.data)
      ? body.data.filter((model) => model && typeof model.id === "string" && typeof model.name === "string")
      : [];
    if (body.source !== "dynamic") return null;
    setCachedDynamicModels(models);
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
export function kiroEffortHeader(input: any): Record<string, string> {
  const selectedModel = input?.message?.model;
  const modelId = selectedModel?.modelID ?? selectedModel?.id ?? input?.model?.id;
  const effort = validateNativeKiroEffort(
    typeof modelId === "string" ? findKiroModel(modelId) : undefined,
    selectedModel?.variant,
  );
  return effort ? { [OPENCODE_EFFORT_HEADER]: effort } : {};
}

export const KiroPlugin: Plugin = async (input) => {
  const workingDirectory = input.directory;
  let disposed = false;
  gatewayConsumers++;

  async function ensureGateway(): Promise<void> {
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
        ...kiroEffortHeader(input),
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
      if (gatewayMode === "owned" && gatewayServer) {
        log.info("[opencode-kiro] Shutting down owned gateway server...");
        await gatewayServer.stop(true);
        gatewayServer = null;
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
          let imported: KiroCliCredentials | null = null;
          if (auth?.type === "oauth" && typeof auth.refresh === "string") {
            const { importFromKiroCli } = await import("./kiro-cli-sync");
            imported = await importFromKiroCli();
          }
          const credentials = resolveKiroLoaderCredentials(auth, imported);
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
                if (arn) {
                  try {
                    const models = await fetchAvailableModels(tok.accessToken, apiRegion, arn);
                    setCachedDynamicModels(buildModelsFromApi(models));
                  } catch (e) { log.warn("Failed to precache models", e); }
                }

                return {
                  type: "success",
                  access: tok.accessToken,
                  refresh: `${tok.refreshToken}|${result.clientId}|${result.clientSecret}|idc||`,
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
                    refresh: packParts.join("|"),
                    expires: Date.now() + 3600 * 1000 - EXPIRES_BUFFER_MS,
                    metadata: { region, authMethod, profileArn: imported.profileArn }
                  };
                }

                // Otherwise try to refresh
                try {
                  const refreshed = await refreshKiroToken(
                    packParts.join("|"),
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
            const packed = `${refreshToken}|||desktop||`;

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
      let models = cachedModels ?? kiroModels;
      const configuredApi = cfg.provider?.kiro?.api as string | undefined;
      const usesLocalGateway = !configuredApi || configuredApi.startsWith(`${gatewayOrigin(GATEWAY_PORT)}/`);
      if (usesLocalGateway) {
        try {
          await ensureGateway();
          if (cachedModels === null) {
            const catalogCredentials = await loadLocalCatalogCredentials();
            const loadedModels = gatewayMode === "owned" || catalogCredentials
              ? await loadGatewayModels(GATEWAY_PORT, await getGatewayToken(), catalogCredentials ?? undefined)
              : null;
            if (loadedModels !== null) models = loadedModels;
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
