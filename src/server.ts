import type { Server } from "bun";
import { createHash } from "node:crypto";
import type { Message, Model, Api, Context } from "./types";
import { streamKiro } from "./stream";
import { log } from "./debug";
import { enterSessionLog } from "./file-logger";
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

// Single-flight guard: concurrent requests that all observe an expired token
// must share ONE refresh, not fire N parallel refreshes. With rotating refresh
// tokens (the desktop endpoint), parallel refreshes invalidate each other and
// cause intermittent auth failures.
let _refreshInFlight: Promise<void> | null = null;

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

/** Get a fresh access token, refreshing if expired (single-flight). */
async function getAccessToken(): Promise<string> {
  if (!_creds) throw new Error("Kiro credentials not initialized — run /login kiro");

  if (Date.now() >= _creds.expiresAt) {
    // Coalesce concurrent refreshes into one in-flight promise so parallel
    // requests don't each rotate (and invalidate) the refresh token.
    if (!_refreshInFlight) {
      const creds = _creds;
      _refreshInFlight = (async () => {
        log.info("[gateway-auth] Token expired, refreshing...");
        const refreshed = await refreshKiroToken(
          creds.refreshPacked,
          creds.region,
          creds.authMethod,
        );
        creds.accessToken = refreshed.access;
        creds.refreshPacked = refreshed.refresh;
        creds.expiresAt = refreshed.expires;
        log.info("[gateway-auth] Token refreshed successfully");
      })().finally(() => {
        _refreshInFlight = null;
      });
    }
    await _refreshInFlight;
  }

  return _creds.accessToken;
}

/** @internal — test helper to inject credentials without Kiro CLI */
export function _seedCredentials(token: string, region = "us-east-1", expiresAt = Date.now() + 3600_000) {
  _creds = {
    accessToken: token,
    refreshPacked: "",
    region,
    authMethod: "idc",
    expiresAt,
  };
}

/**
 * Origin allow-list for the local gateway. Server-side callers (OpenCode,
 * curl) send NO Origin header and are always allowed. Browsers always send
 * Origin; only localhost origins are permitted, which blocks drive-by requests
 * from arbitrary websites to 127.0.0.1:7438 — the gateway proxies the user's
 * Kiro credentials, so an open CORS surface means credential/quota abuse.
 */
function isLocalhostOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
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

export function startGatewayServer(port: number = 0): Promise<Server<any>> {
  return new Promise((resolve) => {
    const server = Bun.serve({
      port,
      // Reasoning models can take 30-60s before emitting the first token
      // while thinking. Bun's default 10s idle timeout is far too short.
      idleTimeout: 255,
      async fetch(req) {
        // Handle CORS preflight. Reflect the Origin only for localhost so a
        // remote website's preflight fails and the browser never sends the
        // real cross-origin request. Non-browser callers don't preflight.
        if (req.method === "OPTIONS") {
          const origin = req.headers.get("origin");
          const headers: Record<string, string> = {
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          };
          if (origin && isLocalhostOrigin(origin)) {
            headers["Access-Control-Allow-Origin"] = origin;
            headers["Vary"] = "Origin";
          }
          return new Response(null, { headers });
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
          // Reject cross-origin browser requests: the gateway proxies the
          // user's Kiro credentials and must not be drivable from a web page.
          if (isDisallowedBrowserRequest(req)) {
            return anthropicError(403, "invalid_request_error", "Cross-origin requests are not allowed");
          }
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
          // Kiro/CodeWhisperer exposes no temperature knob — read for
          // logging/parity only; intentionally NOT forwarded to the API.
          const temperature = body.temperature ?? 0.5;
          // Anthropic requires max_tokens; forward it so streamKiro can pass it
          // through additionalModelRequestFields on models that accept it.
          const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : undefined;

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

            // Title-generation turns need wrapping markdown stripped from the
            // model's output (Kiro models return "**Title**" despite the prompt).
            const isTitleTurn = isTitleGenerationRequest(anthropicMessages);

            log.info(`[gateway] → ${kiroEndpoint} model=${anthropicModelId} region=${apiRegion} stream=${streamRequested}`);

            // Seed profileArn from the credential store (already imported at init)
            if (_creds!.profileArn) {
              seedProfileArn(_creds!.profileArn);
            }

            const kiroStream = streamKiro(piModel, context, {
              apiKey: accessToken,
              reasoning: reasoningEffort,
              temperature,
              maxTokens,
              // The log session id is a stable per-conversation key (survives
              // history growth). Reuse it as the Kiro `conversationId` source so
              // every turn of one conversation shares a single id, like Kiro CLI.
              sessionId: logSessionId,
              logSessionId,
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
                  const startHeartbeat = () => {
                    pingTimer = setInterval(() => {
                      // Only ping after a real gap — no noise during normal streaming.
                      if (Date.now() - lastActivity < PING_INTERVAL_MS) return;
                      try {
                        controller.enqueue("event: ping\ndata: {\"type\":\"ping\"}\n\n");
                      } catch {
                        // Controller already closed — stop pinging.
                        stopHeartbeat();
                      }
                    }, PING_INTERVAL_MS);
                  };
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

                    // Stream is live — begin the keepalive heartbeat.
                    startHeartbeat();

                    let contentBlockIndex = 0;
                    let activeBlockType: "thinking" | "text" | "tool_use" | null = null;
                    // For title turns we buffer text deltas and emit the
                    // markdown-stripped title once at the end, since wrapping
                    // like **Title** can't be detected from a single delta.
                    let titleTextBuffer = "";

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
                      // Real event arrived — reset the heartbeat idle window.
                      lastActivity = Date.now();
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
                        if (isTitleTurn) {
                          // Buffer instead of streaming: we can only strip
                          // wrapping markdown (**Title**) once we have the
                          // whole title. Flushed in finalizeTitleBlock().
                          titleTextBuffer += event.delta;
                          return;
                        }
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

                    // Flush the buffered title (markdown-stripped) as a single
                    // text delta before closing the block. Only set on title
                    // turns; normal chat streamed its deltas live above.
                    if (isTitleTurn && titleTextBuffer.length > 0) {
                      const cleanTitle = stripTitleMarkdown(titleTextBuffer);
                      controller.enqueue(
                        "event: content_block_delta\ndata: " +
                        JSON.stringify({
                          type: "content_block_delta",
                          index: contentBlockIndex - 1,
                          delta: { type: "text_delta", text: cleanTitle }
                        }) + "\n\n"
                      );
                    }

                    closeActiveBlock();

                    const finalMsg = await kiroStream.result();
                    // Surface a stream-level error that occurred AFTER the
                    // initial buffering (e.g. failure after MAX_RETRIES). Any
                    // partial content was already streamed, so emit an Anthropic
                    // `error` SSE event instead of a silent `end_turn`.
                    if (finalMsg.stopReason === "error" || finalMsg.errorMessage) {
                      controller.enqueue(
                        "event: error\ndata: " +
                        JSON.stringify({
                          type: "error",
                          error: {
                            type: "api_error",
                            message: finalMsg.errorMessage || "Kiro stream error",
                          },
                        }) + "\n\n",
                      );
                      controller.close();
                      return;
                    }
                    let finishReason = "end_turn";
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
                  } finally {
                    // Always tear down the heartbeat — on success, error, or
                    // client disconnect — so the interval can't outlive the stream.
                    stopHeartbeat();
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
              // Surface stream-level errors instead of returning an empty,
              // successful-looking message.
              if (finalMsg.stopReason === "error" || finalMsg.errorMessage) {
                return anthropicError(502, "api_error", `Kiro: ${finalMsg.errorMessage || "stream error"}`);
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
