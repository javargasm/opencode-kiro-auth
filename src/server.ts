import type { Server } from "bun";
import type { Message, Model, Api, Context } from "./types";
import { streamKiro } from "./stream";
import { log } from "./debug";
import { KIRO_MODEL_IDS, fetchAvailableModels, buildModelsFromApi, setCachedDynamicModels, seedProfileArn } from "./models";
import { resolveKiroModel, resolveApiRegion } from "./models";
import { refreshKiroToken, startSocialLogin, BUILDER_ID_REGION } from "./oauth";
import { stats } from "./dashboard-stats";
import { getDashboardHtml } from "./dashboard-ui";

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
    ];

    _creds = {
      accessToken: imported.accessToken,
      refreshPacked: packParts.join("|"),
      region: imported.region,
      authMethod: imported.authMethod,
      profileArn: imported.profileArn,
      expiresAt: Date.now() + 3500 * 1000, // assume ~1h validity
    };

    log.info(`[gateway-auth] Initialized (method=${imported.authMethod}, region=${imported.region})`);

    let activeAccessToken = imported.accessToken;

    if (imported.refreshToken) {
      try {
        log.info("[gateway-auth] Refreshing token at startup…");
        const refreshed = await refreshKiroToken(
          _creds.refreshPacked,
          _creds.region,
          _creds.authMethod as any
        );
        _creds.accessToken = refreshed.access;
        _creds.refreshPacked = refreshed.refresh;
        _creds.expiresAt = refreshed.expires;
        activeAccessToken = refreshed.access;
        log.info("[gateway-auth] Token refreshed on startup successfully");
      } catch (err) {
        log.warn("[gateway-auth] Startup token refresh failed, trying with existing token", err);
      }
    }

    // Fetch available models from the backend to ensure dynamic models are used
    try {
      if (imported.profileArn) {
        const apiModels = await fetchAvailableModels(activeAccessToken, imported.region, imported.profileArn);
        const built = buildModelsFromApi(apiModels);
        setCachedDynamicModels(built);
        log.info(`[kiro-models.fetched] Found ${built.length} available models`);
      } else {
        log.info(`[kiro-models.fetched] Skipping fetch, no profileArn available`);
      }
    } catch (err) {
      log.warn("[gateway-auth] Failed to fetch dynamic models (will fallback to static list)", err);
    }
  } catch (err) {
    log.error("[gateway-auth] Init failed", err);
  }
}

/** Get a fresh access token, refreshing if expired. */
async function getAccessToken(): Promise<string> {
  if (!_creds) throw new Error("Kiro credentials not initialized — run /login kiro");

  if (Date.now() >= _creds.expiresAt) {
    log.info("[gateway-auth] Token expired, refreshing...");
    const refreshed = await refreshKiroToken(
      _creds.refreshPacked,
      _creds.region,
      _creds.authMethod,
    );
    _creds.accessToken = refreshed.access;
    _creds.refreshPacked = refreshed.refresh;
    _creds.expiresAt = refreshed.expires;
    log.info("[gateway-auth] Token refreshed successfully");
  }

  return _creds.accessToken;
}

/** @internal — test helper to inject credentials without Kiro CLI */
export function _seedCredentials(token: string, region = "us-east-1") {
  _creds = {
    accessToken: token,
    refreshPacked: "",
    region,
    authMethod: "idc",
    expiresAt: Date.now() + 3600_000,
  };
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

export function startGatewayServer(port: number = 0): Promise<Server<any>> {
  return new Promise((resolve) => {
    const server = Bun.serve({
      port,
      // Reasoning models can take 30-60s before emitting the first token
      // while thinking. Bun's default 10s idle timeout is far too short.
      idleTimeout: 255,
      async fetch(req) {
        // Handle CORS preflight
        if (req.method === "OPTIONS") {
          return new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          });
        }

        const url = new URL(req.url);

        // Dashboard endpoints
        if (url.pathname === "/dashboard") {
          return new Response(getDashboardHtml(), {
            headers: { "Content-Type": "text/html" },
          });
        }
        if (url.pathname === "/dashboard/api/stats") {
          return new Response(JSON.stringify(stats.getStats()), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Health check endpoint
        if (url.pathname === "/health" || url.pathname === "/") {
          return new Response(JSON.stringify({ status: "healthy", service: "opencode-kiro-gateway" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // ── Social sign-in (Builder ID) via PKCE ────────────────────
        // GET /auth/login → starts the PKCE flow, redirects to app.kiro.dev.
        // The localhost:49153 callback server handles the OAuth redirect and
        // exchanges the authorization code for tokens asynchronously.
        if (url.pathname === "/auth/login" && req.method === "GET") {
          try {
            const { signInUrl, waitForCredentials } = await startSocialLogin();
            log.info("[gateway] Social login initiated, redirecting to Kiro sign-in");

            // Fire-and-forget: wait for the callback to complete in the background
            // and update the credential store when it does.
            waitForCredentials()
              .then((creds) => {
                _creds = {
                  accessToken: creds.accessToken,
                  refreshPacked: creds.refreshPacked,
                  region: creds.region,
                  authMethod: creds.authMethod,
                  profileArn: creds.profileArn,
                  expiresAt: creds.expiresAt,
                };
                if (creds.profileArn) {
                  seedProfileArn(creds.profileArn);
                }
                log.info(`[gateway] Login completed (${creds.authMethod}) — credentials updated`);
              })
              .catch((err) => {
                log.error("[gateway] Login failed:", err);
              });

            // Redirect the browser to the Kiro sign-in portal
            return new Response(null, {
              status: 302,
              headers: { Location: signInUrl },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error("[gateway] Failed to start social login:", msg);
            return anthropicError(500, "api_error", `Failed to start login: ${msg}`);
          }
        }

        // Anthropic Messages endpoint
        if ((url.pathname === "/v1/messages" || url.pathname === "/messages") && req.method === "POST") {
          // Gateway owns auth — get a fresh token from the credential store.
          // OpenCode still sends a token in headers (for its own bookkeeping)
          // but we ignore it and use our own.
          let accessToken: string;
          try {
            accessToken = await getAccessToken();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return anthropicError(401, "authentication_error", `Kiro: ${msg}`);
          }
          let body: any;
          try {
            body = await req.json();
          } catch (e) {
            return anthropicError(400, "invalid_request_error", "Bad Request: Invalid JSON body");
          }

          const anthropicModelId = body.model;
          const anthropicMessages = body.messages || [];
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
          const temperature = body.temperature ?? 0.5;

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

            // Region and endpoint come from the credential store
            const apiRegion = resolveApiRegion(_creds!.region);
            const kiroEndpoint = `https://runtime.${apiRegion}.kiro.dev`;

            const piModel: Model<Api> = {
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

            // OpenCode sends effort in `output_config.effort` (Anthropic extended thinking format)
            // or fallback to `reasoning_effort` (standard Anthropic field).
            const reasoningEffort = body.output_config?.effort
              ?? body.reasoning_effort
              ?? undefined;

            log.info(`[gateway] → ${kiroEndpoint} model=${anthropicModelId} region=${apiRegion} stream=${streamRequested}`);

            // Seed profileArn from the credential store (already imported at init)
            if (_creds!.profileArn) {
              seedProfileArn(_creds!.profileArn);
            }

            const kiroStream = streamKiro(piModel, context, {
              apiKey: accessToken,
              reasoning: reasoningEffort,
              temperature,
            });

            if (streamRequested) {
              // Buffer first event: if the stream fails immediately (auth, profileArn, etc.)
              // return a clean HTTP error instead of a broken SSE stream.
              const iter = kiroStream[Symbol.asyncIterator]();
              let firstResult: IteratorResult<any>;
              try {
                firstResult = await iter.next();
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.error("[gateway] Stream failed before first event:", msg);
                return anthropicError(502, "api_error", `Kiro: ${msg}`);
              }

              if (firstResult.done) {
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
                  const msg = err instanceof Error ? err.message : String(err);
                  log.error("[gateway] Stream failed during buffering:", msg);
                  return anthropicError(502, "api_error", `Kiro: ${msg}`);
                }
              }

              // If any buffered event is an error, return HTTP error
              const errorEvent = bufferedEvents.find((e) => e.type === "error");
              if (errorEvent) {
                const errMsg = errorEvent.error?.errorMessage || errorEvent.reason || "Unknown Kiro error";
                log.error("[gateway] Kiro stream error:", errMsg);
                return anthropicError(502, "api_error", `Kiro: ${errMsg}`);
              }

              const streamResponse = new ReadableStream({
                async start(controller) {
                  try {
                    const msgId = `msg_${crypto.randomUUID()}`;
                    controller.enqueue(
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

                    let contentBlockIndex = 0;
                    let activeBlockType: "thinking" | "text" | "tool_use" | null = null;

                    const closeActiveBlock = () => {
                      if (activeBlockType !== null) {
                        controller.enqueue(
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
                      controller.enqueue(
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
                      if (event.type === "thinking_delta") {
                        ensureBlockStarted("thinking");
                        controller.enqueue(
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
                      } else if (event.type === "text_delta") {
                        ensureBlockStarted("text");
                        controller.enqueue(
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
                          controller.enqueue(
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
                        controller.enqueue(
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
                      processEvent(ev);
                    }

                    // Continue with remaining events
                    for await (const event of { [Symbol.asyncIterator]: () => iter }) {
                      processEvent(event);
                    }

                    closeActiveBlock();

                    let finishReason = "end_turn";
                    const finalMsg = await kiroStream.result();
                    if (finalMsg.content.some((b: any) => b.type === "toolCall")) {
                      finishReason = "tool_use";
                    }

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
                      effort: reasoningEffort,
                    });

                    controller.enqueue(
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

                    controller.enqueue("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
                    controller.close();
                  } catch (err) {
                    log.error("[gateway] Stream error:", err);
                    controller.enqueue(
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
                  }
                }
              });

              return new Response(streamResponse, {
                headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  "Connection": "keep-alive",
                  "Access-Control-Allow-Origin": "*",
                }
              });
            } else {
              const finalMsg = await kiroStream.result();
              const contentParts = finalMsg.content;
              const anthropicContent: any[] = [];

              for (const part of contentParts) {
                if (part.type === "text") {
                  anthropicContent.push({
                    type: "text",
                    text: part.text,
                  });
                } else if (part.type === "thinking") {
                  anthropicContent.push({
                    type: "thinking",
                    thinking: part.thinking,
                  });
                } else if (part.type === "toolCall") {
                  anthropicContent.push({
                    type: "tool_use",
                    id: part.id,
                    name: part.name,
                    input: typeof part.arguments === "string" ? JSON.parse(part.arguments) : part.arguments,
                  });
                }
              }

              let finishReason = "end_turn";
              if (finalMsg.content.some((b: any) => b.type === "toolCall")) {
                finishReason = "tool_use";
              }

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
                effort: reasoningEffort,
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
        const toolResultParts = msg.content.filter((part: any) => part.type === "tool_result");
        if (toolResultParts.length > 0) {
          for (const part of toolResultParts) {
            piMessages.push({
              role: "toolResult",
              toolCallId: part.tool_use_id,
              content: typeof part.content === "string" ? part.content : (Array.isArray(part.content) ? part.content.map((c: any) => c.text ?? "").join("\n") : ""),
              isError: part.is_error || false,
              timestamp: Date.now(),
            } as any);
          }
        }

        const otherParts = msg.content.map((part: any) => {
          if (part.type === "text") {
            return { type: "text", text: part.text };
          }
          if (part.type === "image" && part.source?.type === "base64") {
            return { type: "image", mimeType: part.source.media_type, data: part.source.data };
          }
          return null;
        }).filter(Boolean);

        if (otherParts.length > 0) {
          piMessages.push({
            role: "user",
            content: otherParts as any,
            timestamp: Date.now(),
          });
        }
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
            contentParts.push({ type: "thinking", thinking: part.thinking });
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
