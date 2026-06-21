// Route ALL logs to a file — keeps OpenCode status bar clean.
// Every Kiro file log lives under /tmp/kiro-logs/ and carries a session id in
// its name. Per-request logs route to session-{id}.log (via AsyncLocalStorage,
// see file-logger.ts); logs with no request context (startup, auth refresh)
// fall back here, to the "gateway" pseudo-session.
process.env.KIRO_LOG = process.env.KIRO_LOG || "debug";
process.env.KIRO_LOG_FILE = process.env.KIRO_LOG_FILE || "/tmp/kiro-logs/session-gateway.log";

import type { Plugin, Hooks, PluginModule } from "@opencode-ai/plugin";
import { startGatewayServer, initGatewayAuth, getAuthRegion } from "./server";
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
  fetchAvailableModels,
  resolveProfileArn,
  buildModelsFromApi,
  resolveApiRegion,
  setCachedDynamicModels
} from "./models";

// Global server instance to manage lifecycle across reloads
let gatewayServer: any = null;

/**
 * Headers injected into every model request so the gateway can tie the Kiro
 * `conversationId` (and its log-file grouping) to OpenCode's STABLE session id.
 *
 * The gateway derives the conversationId from the `x-session-id` header (see
 * `deriveLogSessionId` in server.ts). OpenCode's session id is stable for the
 * life of a conversation AND survives a restart (`opencode -s <id>` resumes the
 * same id), so the conversationId stays constant across turns and restarts —
 * matching the real Kiro CLI. Without this the gateway fell back to an
 * ephemeral header / first-message fingerprint, so the id changed on every
 * restart and the logs scattered across files.
 *
 * Exported for testing. Returns `{}` when no session id is available.
 */
export function kiroSessionHeaders(sessionID: string | undefined): Record<string, string> {
  return typeof sessionID === "string" && sessionID.trim().length > 0
    ? { "x-session-id": sessionID.trim() }
    : {};
}

export const KiroPlugin: Plugin = async (input) => {
  const client = input.client;

  // Start the gateway server on a fixed port
  const GATEWAY_PORT = 7438;
  try {
    if (gatewayServer) {
      log.info("[opencode-kiro] Stopping existing gateway server...");
      await gatewayServer.stop(true);
    }
    gatewayServer = await startGatewayServer(GATEWAY_PORT);
    log.info(`[opencode-kiro] Gateway server active on http://127.0.0.1:${gatewayServer.port}`);
  } catch (err) {
    log.error("[opencode-kiro] Failed to start local gateway server", err);
  }

  // Initialize gateway auth — imports credentials from Kiro CLI and
  // manages token refresh. Must run before any API requests.
  await initGatewayAuth();

  const localPort = gatewayServer ? gatewayServer.port : GATEWAY_PORT;

  const hooks: Hooks = {
    // Bind every model request to its OpenCode session id (as `x-session-id`).
    // The gateway uses it to derive a stable Kiro conversationId — one per
    // session, constant across turns and across restarts (`opencode -s <id>`).
    "chat.headers": async (input, output) => {
      const headers = kiroSessionHeaders(input?.sessionID);
      if (output && output.headers) {
        Object.assign(output.headers, headers);
      }
    },

    // Shutdown the server when plugin is disposed
    dispose: async () => {
      if (gatewayServer) {
        log.info("[opencode-kiro] Shutting down gateway server...");
        await gatewayServer.stop(true);
        gatewayServer = null;
      }
    },

    auth: {
      provider: "kiro",
      loader: async (getAuth, provider) => {
        try {
          const auth = await getAuth() as any;
          if (auth && auth.type === "oauth" && auth.access) {
            // The gateway handles actual Kiro auth (token refresh, region, etc).
            // We return the stored token so OpenCode's SDK doesn't reject the request,
            // but the gateway ignores it and uses its own credential store.
            return {
              headers: { Authorization: `Bearer ${auth.access}` },
              apiKey: auth.access,
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
      cfg.provider = cfg.provider ?? {};
      cfg.provider.kiro = cfg.provider.kiro ?? {};
      const kiro = cfg.provider.kiro;
      kiro.name = kiro.name ?? "Kiro AWS";
      kiro.npm = kiro.npm ?? "@ai-sdk/anthropic";
      kiro.api = kiro.api ?? `http://127.0.0.1:${localPort}/v1`;
      kiro.models = kiro.models ?? {};

      // Inject dynamic models if available, otherwise fallback to static models.
      const allModels = getCachedDynamicModels() || kiroModels;
      for (const m of allModels) {
        if (kiro.models[m.id]) continue; // don't overwrite user customizations
        kiro.models[m.id] = {
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          temperature: true,
          tool_call: true,
          attachment: m.input.includes("image"),
          modalities: {
            input: m.input.includes("image") ? ["text", "image"] : ["text"],
            output: ["text"],
          },
          cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          limit: { context: m.contextWindow, output: m.maxTokens },
          status: "active",
          release_date: "2026-06-15",
          provider: {
            npm: "@ai-sdk/anthropic",
            api: `http://127.0.0.1:${localPort}/v1`,
          },
        };
      }
    },
  };

  return hooks;
};

export default {
  id: "opencode-kiro",
  server: KiroPlugin,
} satisfies PluginModule;
