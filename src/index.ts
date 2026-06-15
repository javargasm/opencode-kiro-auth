import type { Plugin, Hooks } from "@opencode-ai/plugin";
import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
import { startGatewayServer } from "./server";
import { log } from "./debug";
import { 
  BUILDER_ID_START_URL, 
  BUILDER_ID_REGION, 
  IDC_PROBE_REGIONS,
  EXPIRES_BUFFER_MS,
  tryRegisterAndAuthorize, 
  pollForToken, 
  refreshKiroToken 
} from "./oauth";
import { 
  kiroModels, 
  resolveApiRegion, 
  fetchAvailableModels, 
  buildModelsFromApi,
  type KiroModelDef 
} from "./models";

// Global server instance to manage lifecycle across reloads
let gatewayServer: any = null;

export const KiroPlugin: Plugin = async (input) => {
  const client = input.client;

  // Start the gateway server on a dynamic port
  try {
    if (gatewayServer) {
      log.info("[opencode-kiro] Stopping existing gateway server...");
      await gatewayServer.stop(true);
    }
    gatewayServer = await startGatewayServer(0);
    log.info(`[opencode-kiro] Gateway server active on http://127.0.0.1:${gatewayServer.port}`);
  } catch (err) {
    log.error("[opencode-kiro] Failed to start local gateway server", err);
  }

  const localPort = gatewayServer ? gatewayServer.port : 7438;

  const hooks: Hooks = {
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
            let access = auth.access;
            let refresh = auth.refresh;
            let expires = auth.expires;
            const region = auth.metadata?.region || "us-east-1";
            const authMethod = auth.metadata?.authMethod || "idc";

            // If token has expired or is about to expire, refresh it
            if (Date.now() >= expires) {
              log.info("[opencode-kiro] Access token expired. Refreshing...");
              try {
                const refreshed = await refreshKiroToken(refresh, region, authMethod);
                access = refreshed.access;
                refresh = refreshed.refresh;
                expires = refreshed.expires;

                // Update the token in OpenCode's persistent storage
                await client.auth.set({
                  path: { id: "kiro" },
                  body: {
                    type: "oauth",
                    access,
                    refresh,
                    expires,
                    metadata: {
                      region,
                      authMethod
                    }
                  } as any
                });
                log.info("[opencode-kiro] Persisted refreshed tokens successfully");
              } catch (refreshErr) {
                log.error("[opencode-kiro] Failed token refresh inside loader", refreshErr);
              }
            }

            return {
              headers: {
                Authorization: `Bearer ${access}`,
              },
              apiKey: access,
            };
          }
        } catch (e) {
          log.error("[opencode-kiro] Error resolving auth credentials in loader", e);
        }
        return {};
      },
      methods: [
        {
          type: "oauth",
          label: "Kiro (Builder ID / IAM Identity Center)",
          prompts: [
            {
              type: "text",
              key: "sso_url",
              message: "IAM Identity Center Start URL (press Enter for Builder ID):",
              placeholder: "https://mycompany.awsapps.com/start",
            },
            {
              type: "text",
              key: "sso_region",
              message: "OIDC/SSO Region (optional):",
              placeholder: "us-east-1",
              when: { key: "sso_url", op: "neq", value: "" }
            }
          ],
          authorize: async (inputs = {}) => {
            const ssoUrl = inputs.sso_url?.trim() || BUILDER_ID_START_URL;
            const ssoRegion = inputs.sso_region?.trim() || (ssoUrl === BUILDER_ID_START_URL ? BUILDER_ID_REGION : "");
            const regions = ssoRegion ? [ssoRegion] : IDC_PROBE_REGIONS;
            const authMethod = ssoUrl === BUILDER_ID_START_URL ? "builder-id" : "idc";

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

                return {
                  type: "success",
                  access: tok.accessToken,
                  refresh: `${tok.refreshToken}|${result.clientId}|${result.clientSecret}|${authMethod}`,
                  expires: Date.now() + (tok.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
                  metadata: {
                    region: detectedRegion,
                    authMethod
                  }
                };
              }
            };
          }
        }
      ]
    },

    provider: {
      id: "kiro",
      models: async (provider, ctx) => {
        if (ctx.auth && ctx.auth.type === "oauth" && ctx.auth.access) {
          try {
            const region = (ctx.auth as any).metadata?.region || "us-east-1";
            const apiRegion = resolveApiRegion(region);
            const apiModels = await fetchAvailableModels(ctx.auth.access, apiRegion);
            const dynamicDefs = buildModelsFromApi(apiModels);
            return mapDefsToOpenCodeModels(dynamicDefs, localPort);
          } catch (err) {
            log.warn(`[opencode-kiro] Failed to fetch dynamic models, using static fallback: ${err}`);
          }
        }
        return mapDefsToOpenCodeModels(kiroModels, localPort);
      }
    }
  };

  return hooks;
};

function mapDefsToOpenCodeModels(defs: KiroModelDef[], localPort: number): Record<string, ModelV2> {
  const result: Record<string, ModelV2> = {};
  for (const m of defs) {
    result[m.id] = {
      id: m.id,
      providerID: "kiro",
      name: m.name,
      api: {
        id: "anthropic",
        url: `http://127.0.0.1:${localPort}/v1`,
        npm: "@ai-sdk/anthropic",
      },
      capabilities: {
        temperature: true,
        reasoning: m.reasoning,
        attachment: m.input.includes("image"),
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: m.input.includes("image"),
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: {
        context: m.contextWindow,
        output: m.maxTokens,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-06-15",
    };
  }
  return result;
}

export default KiroPlugin;
