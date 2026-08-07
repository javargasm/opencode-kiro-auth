# @javargasm/opencode-kiro-auth

## 8.2.2

### Patch Changes

- Add gateway restart endpoints, improve stream error formatting, and harden SQLite resource cleanup.

  Gateway server & lifecycle:

  - Add authenticated POST `/v1/restart` and `/dashboard/api/restart` endpoints triggering an `onRestart` callback to support gateway hot-restarting.
  - Wrap stream result processing with `safeKiroStreamResult` to gracefully catch and log stream initialization/result failures in non-streaming and streaming modes.
  - Parse nested JSON error strings from Kiro upstream responses in `formatKiroErrorDetail` for human-readable error messages.

  Streaming & timeouts:

  - Enforce mid-stream idle timeouts on `reader.read()` after the first token, cancelling the reader on timeout to prevent hanging connections when upstream stalls.
  - Expand capacity error detection to handle `MODEL_TEMPORARILY_UNAVAILABLE` alongside `INSUFFICIENT_MODEL_CAPACITY`.

  Kiro CLI sync:

  - Wrap SQLite prepared statement execution in `saveKiroCliCredentials` to guarantee statement disposal even if database queries fail or throw.

## 8.2.1

### Patch Changes

- Improve dashboard telemetry access and account credit reporting.

  Dashboard:

  - Remove the manual gateway-token prompt and authenticate same-origin telemetry with a short-lived, opaque `HttpOnly` session cookie without embedding the gateway secret in the HTML.
  - Add a compact responsive footer bar showing consumed credits, total credits, percentage used, plan status, and color thresholds for normal, warning, and critical usage.

  Usage cache:

  - Refresh account usage immediately and every 20 seconds in the owned gateway process while serving dashboard and TUI reads from the shared cache.
  - Stop background refresh on gateway disposal, prevent duplicate refreshes for shared gateway attachments, and cache failure responses for the same interval.

## 8.2.0

### Minor Changes

- Harden the local gateway, publish a loadable TUI artifact, and make long-running Kiro streams recover without duplicating consumer-visible output.

  Gateway security and lifecycle:

  - Bind protocol-v5 request HMACs to the HTTP method and complete path/query, retain accepted nonces for the full replay window, and verify gateway ownership with constant-time challenge proofs.
  - Repair weak or partial gateway-token files under a bounded cross-process lock, reject tokens shorter than 32 characters, and recover safely when the current port owner exits during attachment.
  - Enforce loopback Host and browser Origin checks, protect dashboard telemetry routes, remove the gateway OAuth-start endpoint, and bind the IdC verification page to OAuth state.
  - Bound gateway JSON, catalog, nonce, request-body, incomplete-frame, and event-queue resources while preserving graceful shared-owner takeover.

  Streaming and tool calls:

  - Retry first-token, idle, transport, and retryable post-output service failures with semantic replay: already-emitted text, reasoning metadata, and canonical tool calls are suppressed while only the new suffix reaches consumers.
  - Remove the model-visible `[tool calling continues]` history marker and preserve tool-only turns as empty assistant content with their structured tool metadata intact.
  - Preserve request timestamps, compacted context, reasoning signatures, and terminal metadata across retries; divergent retries now fail instead of duplicating or corrupting output.
  - Reserve capacity for parser bursts and terminal events, enqueue terminal events before settling stream results, and propagate cancellation/backpressure through the gateway SSE bridge.
  - Normalize Anthropic stop reasons for max-token and tool-use turns and keep completed tool calls recoverable without accepting incomplete trailing tools.

  Models, OAuth, and request contracts:

  - Keep direct-OAuth model catalogs scoped to the active OpenCode account without replacing the shared gateway owner's catalog; persist region and profile scope across refresh-token rotation.
  - Fetch request-scoped catalog metadata for attaching accounts so effort variants, output limits, and timeout policy come from the correct credentials.
  - Validate Anthropic model and `max_tokens` inputs before credential refresh or upstream dispatch. Send `max_tokens` only when the live catalog advertises that field, preserving compatibility with Claude Haiku 4.5 while clamping supported models to their catalog maximum.
  - Reject owner aliases with incompatible profile or region metadata and avoid caching request-scoped profile data globally.

  Dashboard, diagnostics, and packaging:

  - Render dashboard telemetry with DOM text nodes instead of `innerHTML`, use a per-response nonce CSP, and keep the prompted gateway token in memory only.
  - Keep file logging explicitly opt-in, route diagnostics by session, serialize writes asynchronously, and create private log/token files where supported.
  - Bundle the TUI as `dist/tui.js`, publish matching declarations, declare Bun as the runtime, and verify package exports with an artifact test.
  - Run the same complete `bun run check` pipeline in CI and release workflows, including typecheck, Vitest, Bun gateway tests, production builds, and package-artifact validation.

## 8.1.1

### Patch Changes

- Finalize a fully parsed tool turn when Kiro emits its generic retryable `ServiceException` immediately after the completed tool call, while continuing to surface genuine partial-text and incomplete-tool failures.

## 8.1.0

### Minor Changes

- Improve shared-gateway and Kiro stream reliability across concurrent OpenCode processes.

  Gateway ownership:

  - Recognize rotated owner credentials by stable Kiro profile and region, allowing long-lived clients with an older bearer to use the gateway's current access token.
  - Preserve account-specific catalog isolation for attaching clients while avoiding stale-token owner catalog refreshes.

  Streaming:

  - Preserve tuned timeout policy when static models are replaced by the dynamic account catalog, including the 230-second first-token and idle timeouts for GPT 5.6.
  - Count growth of a parser-recognized incomplete frame as stream progress without allowing arbitrary keepalive bytes to suppress idle timeouts.
  - Finalize completed turns when the transport closes after authoritative Kiro terminal metadata, while retaining errors for genuine mid-output truncation.
  - Retry socket closures that only buffered an incomplete tool call which had not yet reached the consumer.

  Gateway responsiveness:

  - Replace synchronous per-event diagnostic writes with ordered asynchronous batches.
  - Yield between large parsed-event batches so health probes and concurrent clients remain responsive during high-volume model output.

## 0.8.0

### Minor Changes

- Allow standard Anthropic clients to authenticate to the local gateway with its secret through `x-api-key` or `Authorization: Bearer`, while retaining nonce-bound HMAC authentication for OpenCode. Also keep probing and retrying takeover when the shared gateway port is occupied but its health endpoint is temporarily unavailable.

## 0.7.3

### Patch Changes

- Update Kiro model catalog static definitions and User-Agent headers to match official Kiro CLI client responses and requests.

  Models:

  - Add static catalog entry for `Claude Opus 5` and configure `effortRequestField: "output_config"` and `supportsMaxTokens: true` for all Claude reasoning models.
  - Update cost estimation pricing in `dashboard-stats.ts` for `claude-opus-5` and the GPT 5.6 series (`gpt-5-6-sol`, `gpt-5-6-terra`, `gpt-5-6-luna`).
  - Update `README.md` supported models table and reasoning effort documentation.

  Headers:

  - Bump Kiro CLI `appVersion` in User-Agent and X-Amz-User-Agent strings from `2.12.2` to `2.15.0`.

## 0.7.0

### Minor Changes

- 46167e8: Shared gateway (protocol v3), account-specific model catalog, native Kiro effort levels, reasoning replay, and Kiro request-body validation fixes.

  Gateway:

  - Share one compatible local gateway across OpenCode processes while isolating each request's workspace via the `x-opencode-cwd` header, so concurrent clients no longer clobber each other's working directory.
  - Add domain-separated gateway auth (protocol v3): HMAC challenge/response and per-request signatures over token, timestamp, and nonce, advertised through capability negotiation.
  - Add `probeGateway` / `startOrAttachGateway` so a new process attaches to a compatible running gateway instead of failing to bind the port.

  Models:

  - Load the account-specific Kiro model catalog before OpenCode builds its provider list, and refresh it per credential set (`loadGatewayModels`, `fetchGatewayModelsForCredentials`, `refreshGatewayModels`).
  - Pass through per-request region and profile ARN via dedicated headers instead of relying on process-global state.

  Reasoning and efforts:

  - Support native Kiro effort levels (`none`, `low`, `medium`, `high`, `xhigh`, `max`) with validation and a dedicated effort header.
  - Replay assistant reasoning to Bedrock: text reasoning is replayed only with a valid signature (avoids `THINKING_SIGNATURE_INVALID`), and redacted reasoning is replayed through its opaque `redactedContent` field, keyed by a deterministic per-message UUID.

  Fixes:

  - Fix `REQUEST_BODY_INVALID`: tool results are only sent as Kiro `json` blocks when the payload is a plain object; top-level arrays and scalars now use bounded text.
  - Stop replaying images inside historical user messages (Kiro returns `IMAGE_FORMAT_UNSUPPORTED` for history images) while preserving images on the current message.
  - Deduplicate concurrent owner-token refreshes and clear stale credentials to fix token rotation.

## 0.6.1

### Patch Changes

- af645dd: Retry transient Kiro transport failures with exponential backoff.

  - Retry `fetch()` socket/proxy disconnects before an HTTP response is received.
  - Retry response-stream transport failures before the first assistant token.
  - Keep the no-retry behavior after partial output to avoid duplicating already-sent SSE deltas.
  - Document model rate multipliers, retry behavior, and release flow in the README.
  - Add regression tests for fetch socket closures, pre-token stream transport errors, and post-partial-output no-retry behavior.

- 6571fe1: Add a tag-based GitHub Actions release workflow that runs checks, builds, and publishes to npm with provenance.

## 0.6.0

### Minor Changes

- 53e7337: Update Kiro CLI compatibility and model catalog metadata.

  - Align Kiro management `ListAvailableModels`/`ListAvailableProfiles` headers with Kiro CLI 2.10.0 while keeping `X-Amz-Target` method-specific.
  - Send the captured `ListAvailableModels` body with `origin` and `profileArn`.
  - Add newer Kiro models (`claude-sonnet-5`, `deepseek-3.2`, `glm-5`) to the fallback catalog.
  - Show each model's `rateMultiplier` next to its display name for both dynamic endpoint models and fallback models.
  - Add direct regression tests for catalog rate multipliers and management request headers/body.

## 0.5.0

### Minor Changes

- 16b6dd0: Stable session headers and opt-in file logging

  - Inject `x-session-id` header via the `chat.headers` hook so the gateway derives a stable Kiro `conversationId` from OpenCode's session id — one per conversation, constant across turns and restarts (`opencode -s <id>`)
  - Make structured file logging opt-in via `KIRO_FILE_LOG` environment variable (previously always-on). Accepted values: `1`, `true`, `yes`, `on`
  - Fix `stream.ts` to gate the `.last-request.json` dump on `isFileLoggingEnabled()` instead of `log.isDebug()`
  - Add tests for file-logger, oauth, and kiro-cli protocol sync

## 0.4.0

### Minor Changes

- Stream reliability + gateway hardening from the audit pass:

  - **event-parser**: surface AWS Event Stream exception frames (type lives in the `:exception-type` header, not the JSON payload) as `error` events instead of treating a truncated stream as a clean finish; emit a `metadata` event carrying Kiro's authoritative `stopReason`.
  - **stream**: prefer Kiro's `metadataEvent` stopReason over heuristics; deterministic per-session `conversationId` (v5 UUID, stable across restarts) matching the Kiro CLI; forward clamped `max_tokens` for thinking-config models; stop blindly deduping identical content frames; skip signature-only reasoning frames that would emit an empty thinking block; never reset-and-retry after partial output reached the consumer (avoids duplicated SSE); resolve `firstTokenTimeout` from dynamic models; UA bump to appVersion 2.8.1.
  - **server**: single-flight token refresh (parallel refreshes invalidate rotating tokens); reject cross-origin browser requests + localhost-only CORS; SSE keepalive heartbeat; surface stream-level errors as HTTP 502 / SSE `error`; preserve tool_result vs text ordering within a user message; per-session log routing.
  - **transform**: normalize image MIME → Kiro format (`jpg`→`jpeg`), omit unsupported subtypes (e.g. `image/svg+xml`) instead of sending a bogus `format`.
  - **thinking-parser**: append late thinking blocks instead of splicing (splice corrupted already-emitted content indices).
  - **types**: `EventStream.result()` rejects instead of hanging when the stream ends with no terminal event.
  - **models**: `max_tokens` normalized to 64000; Fable 5 marked disabled; Auto context window to 1M.

## 0.3.1

### Patch Changes

- fix(server): strip wrapping markdown from generated session titles.

  Kiro models return titles wrapped in bold (`**Title**`), quotes, backticks, or with a leading heading/list marker, despite OpenCode's title prompt asking for plain text. The gateway now detects the title-generation turn and strips the wrapping, so titles like `**Debugging CodeGraph Configuration**` render as plain text. Normal chat responses keep their markdown intact.

## 0.3.0

### Minor Changes

- Tool-call reliability fixes, dashboard cost telemetry, and dependency cleanup.

  - fix(transform): preserve tool parameter names during schema sanitization. Keys under `properties` are parameter names (query, command, filePath), not JSON Schema keywords, so they must not be filtered against the allowlist. The previous behavior dropped every parameter while `required` still referenced them, causing MCP tools to fail with "query must be a non-empty string".
  - fix(stream): inject a placeholder toolConfig when replayed history contains toolUse/toolResult blocks but the current turn supplies no tools. Prevents Bedrock TOOL_CONFIG_MISSING 400 loops on auxiliary turns (title generation, summarization, compaction).
  - fix(stream): stop leaking the internal `__tool_use_purpose` field in `toolcall_delta` — emit cleaned args so delta and toolcall_end agree.
  - fix(event-parser): don't emit a bogus usage event for metering frames (`{"unit":"credit","usage":<number>}`); accept capitalized `Usage`/`Error` keys from the Kiro stream.
  - feat(dashboard): add USD cost estimation (official Anthropic per-MTok rates) and per-request reasoning-effort telemetry, with a credits/USD toggle.
  - chore: drop stale static model ids now resolved dynamically; gitignore npm's package-lock.json (project uses bun); bump vitest to ^4.

## 0.2.2

### Patch Changes

- 9123de1: fix: sanitize history to prevent Bedrock TOOL_DUPLICATE and TOOL_USE_RESULT_MISMATCH errors

  Added `sanitizeHistory` defense-in-depth pass that runs after `collapseAgenticLoops`:

  - Deduplicates toolUseIds within each assistant message (prevents TOOL_DUPLICATE)
  - Removes orphan toolUses without matching toolResults (prevents TOOL_USE_RESULT_MISMATCH)
  - Removes orphan toolResults without matching toolUses

  These errors surfaced during retry loops where the same assistant message
  with tool calls could be re-injected into the history.

## 0.2.1

### Patch Changes

- fix: use reasoningContent with signature for thinking history instead of inline XML tags

  Bedrock rejects replayed history with THINKING_SIGNATURE_INVALID when thinking
  blocks use inline `<thinking>` XML tags without the cryptographic signature.
  Now accumulates thinking text and signature from upstream content blocks and
  sends them as proper `reasoningContent.reasoningText` with `text` + `signature`.
  Silently drops reasoning when the signature is missing rather than crashing.

  Also adds opt-in file-based debug logging (KIRO_FILE_LOG) for API interactions.

## 0.1.2

### Patch Changes

- fix: use vitest runner for CI-compatible stream tests

  Switched test runner from `bun test` to `vitest run` for stream tests
  so `vi.spyOn(globalThis, 'fetch')` works reliably in CI (Ubuntu/Node).
  Gateway tests (Bun.serve) remain under `bun test` and run locally.

## 0.1.1

### Patch Changes

- fix: align streaming HTTP headers with real Kiro CLI 2.7.1

  Updated all HTTP headers sent to the CodeWhisperer streaming endpoint to
  match the real Kiro CLI captured via Charles proxy:

  - Corrected `user-agent` format and SDK versions (1.3.15, 0.1.16551, 2.7.1)
  - Set `x-amz-user-agent` to its own value (`m/F` instead of `md/appVersion`)
  - Changed `Accept` from `application/json` to `*/*`
  - Changed `amz-sdk-request` from `max=1` to `max=3`
  - Added `Accept-Encoding: gzip`, `Pragma: no-cache`, `Cache-Control: no-cache`
  - Removed `x-amzn-kiro-agent-mode` (not present in real client)
  - Added stream test suite with 15 tests covering header fidelity
