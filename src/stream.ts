// Kiro streaming orchestrator. Builds the CodeWhisperer request, enforces
// retry/timeout policies, and translates Kiro's JSON event stream into pi's
// AssistantMessageEvent protocol.

import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  KiroNativeEffort,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "./types";
import { AssistantMessageEventStream, calculateCost } from "./types";
import { log, previewChunk } from "./debug";
import { parseKiroEvents } from "./event-parser";
import { isPermanentError } from "./health";
import type { KiroModel } from "./models";
import { createHash } from "node:crypto";
import { findKiroModel, resolveKiroModel, resolveProfileArn, resetProfileArnCache, seedProfileArn, DEFAULT_PROFILE_ARN } from "./models";
import { ThinkingTagParser } from "./thinking-parser";
import { countTokens } from "./tokenizer";
import { abortableDelay } from "./oauth";
import { createSessionLogger, ensureLogDir, isFileLoggingEnabled, LOG_DIR } from "./file-logger";

import {
  buildHistory,
  convertToolResultContent,
  convertImagesToKiro,
  convertToolsToKiro,
  extractImages,
  getContentText,
  historyHasToolBlocks,
  KIRO_PLACEHOLDER_TOOL,
  type KiroEnvState,
  type KiroHistoryEntry,
  type KiroImage,
  type KiroToolResult,
  type KiroToolSpec,
  type KiroUserInputMessage,
  normalizeMessages,
  parseToolArgs,
  resolveKiroAssistantMessageId,
  toKiroToolUseId,
} from "./transform";
import {
  COMPACTION_THRESHOLD_PCT,
  resolveOS,
  SYSTEM_SEED_ACK,
  SYSTEM_SEED_INSTRUCTION,
} from "./kiro-defaults";

// ---- Retry / timeout constants -----------------------------------------

const FIRST_TOKEN_TIMEOUT_DEFAULT_MS = 90_000;
const IDLE_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_DEFAULT_MS = 10 * 60_000;
export const ERROR_BODY_TIMEOUT_MS = 10_000;
export const MAX_ERROR_BODY_BYTES = 256 * 1024;
export const MAX_INCOMPLETE_FRAME_CHARS = 8 * 1024 * 1024;
export const MAX_STREAM_RESPONSE_BYTES = 64 * 1024 * 1024;
const STREAM_EVENT_YIELD_INTERVAL = 128;
const STREAM_EVENT_QUEUE_SIZE = 256;
// One content frame can synchronously emit seven parser events. Reserve room
// for that burst plus tool/parser finalization and the terminal events.
const STREAM_EVENT_PUSH_RESERVE = 16;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 10_000;

const CAPACITY_MAX_RETRIES = 3;
const CAPACITY_BASE_DELAY_MS = 5_000;
const CAPACITY_MAX_DELAY_MS = 30_000;

const TRANSIENT_MAX_RETRIES = 3;
const TRANSIENT_BASE_DELAY_MS = 2_000;
const TRANSIENT_MAX_DELAY_MS = 15_000;

const CONTEXT_TRUNCATION_MAX_RETRIES = 3;
const CONTEXT_TRUNCATION_DROP_RATIO = 0.3;
const CONTEXT_TRUNCATION_SEED_ENTRIES = 2;
const CONTEXT_TRUNCATION_RECENT_ENTRIES = 2;
const TOOL_RESULT_RETRY_SHRINK_RATIO = 0.5;
const TOOL_RESULT_RETRY_MIN_CHARS = 512;

const TOO_BIG_PATTERNS = ["CONTENT_LENGTH_EXCEEDS_THRESHOLD", "Input is too long"];
const NON_RETRYABLE_BODY_PATTERNS = ["MONTHLY_REQUEST_COUNT", "Improperly formed"];
const CAPACITY_PATTERN = "INSUFFICIENT_MODEL_CAPACITY";
const RECOVERABLE_POST_OUTPUT_SERVICE_EXCEPTION =
  "ServiceException: Encountered an unexpected error when processing the request, please try again.";
const RECOVERABLE_POST_OUTPUT_STREAM_ERROR_TYPES = new Set([
  "ServiceException",
  "ThrottlingException",
  "InternalServerException",
  "RequestTimeoutException",
  "ModelStreamErrorException",
]);

function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

function isTooBigError(status: number, body: string): boolean {
  return status === 413 || (status === 400 && TOO_BIG_PATTERNS.some((p) => body.includes(p)));
}

function isNonRetryableBodyError(body: string): boolean {
  return NON_RETRYABLE_BODY_PATTERNS.some((p) => body.includes(p));
}

function isCapacityError(body: string): boolean {
  return body.includes("INSUFFICIENT_MODEL_CAPACITY") || body.includes("MODEL_TEMPORARILY_UNAVAILABLE");
}

function isTransientError(status: number): boolean {
  return status === 429 || status >= 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function readWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function readResponseTextLimited(
  response: Response,
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
): Promise<string> {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? ERROR_BODY_TIMEOUT_MS));
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const maxBytes = Math.max(1, options.maxBytes ?? MAX_ERROR_BODY_BYTES);
  const reader = response.body?.getReader();

  // Test doubles and synthetic responses may expose text() without a body.
  if (!reader) {
    const text = await readWithSignal(response.text(), signal);
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`Kiro API error body exceeded ${maxBytes} bytes`);
    }
    return text;
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await readWithSignal(reader.read(), signal);
      if (done) return text + decoder.decode();
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`Kiro API error body exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function isRecoverablePostOutputServiceException(error: string | null): boolean {
  return error === RECOVERABLE_POST_OUTPUT_SERVICE_EXCEPTION;
}

function isRecoverablePostOutputStreamError(error: string | null): boolean {
  if (!error) return false;
  const separator = error.indexOf(":");
  const type = separator >= 0 ? error.slice(0, separator) : error;
  return RECOVERABLE_POST_OUTPUT_STREAM_ERROR_TYPES.has(type.trim());
}

/**
 * Drop complete old user/assistant turns without removing Kiro's mandatory
 * synthetic seed pair or the most recent turn. The recent assistant entry can
 * own tool uses whose results live in currentMessage, so dropping it would turn
 * an otherwise oversized request into REQUEST_BODY_INVALID.
 */
function dropOldestHistoryTurnsForRetry(history: KiroHistoryEntry[]): number {
  const removable = history.length
    - CONTEXT_TRUNCATION_SEED_ENTRIES
    - CONTEXT_TRUNCATION_RECENT_ENTRIES;
  const maxEvenRemovable = removable - (removable % 2);
  if (maxEvenRemovable < 2) return 0;

  const desired = Math.max(2, Math.floor(removable * CONTEXT_TRUNCATION_DROP_RATIO));
  const completeTurnCount = Math.ceil(desired / 2) * 2;
  const dropCount = Math.min(maxEvenRemovable, completeTurnCount);
  history.splice(CONTEXT_TRUNCATION_SEED_ENTRIES, dropCount);

  // The first retained user entry can contain toolResults for the assistant
  // entry immediately before the removed range. That assistant no longer
  // exists, so retaining those results makes the retry malformed. Keep the
  // user/assistant alternation but turn this boundary entry into a continuity
  // marker with no orphan result ids.
  const boundaryUser = history[CONTEXT_TRUNCATION_SEED_ENTRIES]?.userInputMessage;
  const boundaryContext = boundaryUser?.userInputMessageContext;
  if (boundaryContext?.toolResults?.length) {
    delete boundaryContext.toolResults;
    if (Object.keys(boundaryContext).length === 0) {
      delete boundaryUser!.userInputMessageContext;
    }
    if (boundaryUser!.content.trim() === "Tool results provided.") {
      boundaryUser!.content = "Earlier tool interaction omitted during context truncation.";
    }
  }
  return dropCount;
}

function toolResultContentText(result: KiroToolResult): string {
  return result.content
    .map((block) => "text" in block ? block.text : JSON.stringify(block.json))
    .join("\n");
}

function truncateToolResultForRetry(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n... [TRUNCATED FOR CONTEXT RETRY] ...\n";
  if (limit <= marker.length) return text.slice(0, limit);
  const retained = limit - marker.length;
  const start = Math.ceil(retained / 2);
  const end = Math.floor(retained / 2);
  return `${text.slice(0, start)}${marker}${text.slice(text.length - end)}`;
}

/** Preserve every tool-result id while progressively reducing bulky payloads. */
function compactCurrentToolResultsForRetry(
  toolResults: KiroToolResult[],
): { beforeChars: number; afterChars: number } {
  const texts = toolResults.map(toolResultContentText);
  const beforeChars = texts.reduce((sum, text) => sum + text.length, 0);
  if (beforeChars === 0 || toolResults.length === 0) {
    return { beforeChars, afterChars: beforeChars };
  }

  const targetTotal = Math.max(
    toolResults.length * TOOL_RESULT_RETRY_MIN_CHARS,
    Math.floor(beforeChars * TOOL_RESULT_RETRY_SHRINK_RATIO),
  );
  const perResultLimit = Math.max(
    TOOL_RESULT_RETRY_MIN_CHARS,
    Math.floor(targetTotal / toolResults.length),
  );

  for (let i = 0; i < toolResults.length; i++) {
    const text = texts[i]!;
    if (text.length <= perResultLimit) continue;
    toolResults[i]!.content = [{ text: truncateToolResultForRetry(text, perResultLimit) }];
  }

  const afterChars = toolResults.reduce(
    (sum, result) => sum + toolResultContentText(result).length,
    0,
  );
  return { beforeChars, afterChars };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function findModel(modelId: string): KiroModel | undefined {
  return findKiroModel(modelId);
}

export function firstTokenTimeoutForModel(modelId: string, scopedModel?: KiroModel): number {
  return scopedModel?.firstTokenTimeout
    ?? findModel(modelId)?.firstTokenTimeout
    ?? FIRST_TOKEN_TIMEOUT_DEFAULT_MS;
}

export function idleTimeoutForModel(modelId: string, scopedModel?: KiroModel): number {
  return scopedModel?.idleTimeout ?? findModel(modelId)?.idleTimeout ?? IDLE_TIMEOUT_MS;
}

/**
 * Extract the Kiro API region from a runtime/management base URL such as
 * `https://runtime.us-east-1.kiro.dev`. resolveProfileArn() expects a region
 * (e.g. "us-east-1"), NOT a full URL — passing the URL would build a malformed
 * `https://management.https://…kiro.dev/` endpoint. Falls back to us-east-1.
 */
export function regionFromEndpoint(endpoint: string): string {
  const m = endpoint.match(/(?:runtime|management)\.([a-z0-9-]+)\.kiro\.dev/i);
  return m?.[1] ?? "us-east-1";
}

/**
 * Map Kiro's authoritative metadataEvent stopReason (real wire values:
 * TOOL_USE / END_TURN / MAX_TOKENS, occasionally STOP_SEQUENCE) onto the
 * internal stop reason. Returns null for unknown/absent values so the caller
 * can fall back to heuristics.
 */
export function mapKiroStopReason(raw: string | null | undefined): "stop" | "length" | "toolUse" | null {
  switch (raw?.toUpperCase()) {
    case "TOOL_USE":
      return "toolUse";
    case "MAX_TOKENS":
      return "length";
    case "END_TURN":
    case "STOP_SEQUENCE":
    case "COMPLETE":
    case "FINISHED":
      return "stop";
    default:
      return null;
  }
}

/**
 * Placeholder surfaced to downstream UIs during the deliberation window
 * on models that hide reasoning (e.g. Claude Opus 4.7 with
 * adaptive-thinking `display: "omitted"`). Emitted as a `thinking_delta`
 * only after the countdown elapses without any real output — fast
 * responses produce no delta at all. Clients drop the block at
 * `thinking_end` either via the empty-text predicate (zero-delta fast
 * path) or via a known-placeholder predicate (slow path).
 */
const HIDDEN_REASONING_PLACEHOLDER = "Reasoning hidden by provider";

/**
 * How long to wait after `start` before emitting the lazy
 * hidden-reasoning breadcrumb. Short enough that the marker appears
 * exactly when a wait starts feeling palpable, long enough that fast
 * responses never flash it. Content / tool-call events cancel the
 * timer, so the breadcrumb only fires when nothing else arrives in
 * time.
 */
export const HIDDEN_REASONING_COUNTDOWN_MS = 2000;

/**
 * Emit a complete hidden-reasoning breadcrumb as a single flush:
 * `thinking_start` + `thinking_delta(marker)` + `thinking_end`. The
 * block carries `redacted: true` so downstream UIs can drop it by
 * placeholder or marker predicate — Inkstone drops it via its
 * `REDACTED_THINKING_PLACEHOLDERS` filter.
 *
 * Called only from the slow-path countdown timer: content and tool
 * events cancel the timer so this never fires when real output
 * arrived in time.
 */
function emitHiddenReasoningLate(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): ThinkingContent {
	const contentIndex = output.content.length;
	const block: ThinkingContent = {
		type: "thinking",
		thinking: HIDDEN_REASONING_PLACEHOLDER,
		redacted: true,
	};
	output.content.push(block);
	stream.push({ type: "thinking_start", contentIndex, partial: output });
	stream.push({
		type: "thinking_delta",
		contentIndex,
		delta: HIDDEN_REASONING_PLACEHOLDER,
		partial: output,
	});
	stream.push({
		type: "thinking_end",
		contentIndex,
		content: "",
		partial: output,
	});
	return block;
}

// ---- profileArn cache moved to models.ts -------------------------------

// ---- Request body shape ------------------------------------------------

interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    agentTaskType: "vibe";
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
  profileArn: string;
  additionalModelRequestFields?: {
    output_config?: { effort?: string };
    reasoning?: { effort?: string };
    thinking?: { type: "adaptive" | "disabled"; display?: "summarized" | "omitted" };
    max_tokens?: number;

  };
}

interface KiroToolCallState {
  toolUseId: string;
  name: string;
  input: string;
}

function parseToolCall(state: KiroToolCallState): ToolCall | null {
  if (!state.input.trim()) state.input = "{}";

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(state.input) as Record<string, unknown>;
    if (args && typeof args === "object" && "__tool_use_purpose" in args) {
      delete args.__tool_use_purpose;
    }
  } catch (e) {
    log.info(
      `failed to parse tool input for "${state.name}" (${state.toolUseId}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }

  return { type: "toolCall", id: state.toolUseId, name: state.name, arguments: args };
}

function emitToolCall(
  toolCall: ToolCall,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  const contentIndex = output.content.length;
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
}

type ReplaySegmentType =
  | "content"
  | "reasoning"
  | "reasoningSignature"
  | "redactedReasoning"
  | "toolCall";

interface ReplaySegment {
  type: ReplaySegmentType;
  data: string;
}

function appendReplayText(
  transcript: ReplaySegment[],
  type: "content" | "reasoning",
  data: string,
): void {
  if (!data) return;
  const last = transcript[transcript.length - 1];
  if (last?.type === type) {
    last.data += data;
  } else {
    transcript.push({ type, data });
  }
}

function appendReplayAtomic(
  transcript: ReplaySegment[],
  type: Exclude<ReplaySegmentType, "content" | "reasoning">,
  data: string,
): void {
  // Tool calls are semantic and must match exactly (after canonicalization).
  // Signatures and redacted blobs are opaque, generation-specific values: only
  // their position/type participates in replay matching. Keeping them out of
  // the transcript also avoids retaining an unnecessary second copy.
  transcript.push({ type, data: type === "toolCall" ? data : "" });
}

function canonicalReplayValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalReplayValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalReplayValue(entry)]),
    );
  }
  return value;
}

function toolCallReplayKey(toolCall: ToolCall): string {
  return JSON.stringify(canonicalReplayValue({
    name: toolCall.name,
    arguments: toolCall.arguments,
  }));
}

/**
 * Verifies that a retried response first replays the semantic prefix already
 * delivered to the consumer. Matching prefix data is suppressed; only a
 * suffix beyond that prefix may be emitted. This is deliberately stricter
 * than blind string deduplication: a divergent retry fails instead of
 * corrupting the response with duplicated or reordered blocks.
 */
class SemanticReplayGate {
  private segmentIndex = 0;
  private charOffset = 0;

  constructor(private readonly expected: ReplaySegment[]) {}

  isComplete(): boolean {
    return this.segmentIndex >= this.expected.length;
  }

  pendingDescription(): string {
    const segment = this.expected[this.segmentIndex];
    return segment
      ? `${segment.type} segment ${this.segmentIndex + 1}/${this.expected.length}`
      : "none";
  }

  consumeText(type: "content" | "reasoning", data: string): string {
    let remaining = data;
    while (remaining.length > 0 && !this.isComplete()) {
      const segment = this.expected[this.segmentIndex]!;
      if (segment.type !== type) this.throwDivergence(type, segment);

      const expectedRemainder = segment.data.slice(this.charOffset);
      const compareLength = Math.min(remaining.length, expectedRemainder.length);
      if (remaining.slice(0, compareLength) !== expectedRemainder.slice(0, compareLength)) {
        this.throwDivergence(type, segment);
      }

      remaining = remaining.slice(compareLength);
      this.charOffset += compareLength;
      if (this.charOffset === segment.data.length) {
        this.segmentIndex++;
        this.charOffset = 0;
      }

      // A single semantic event cannot validly cross a different event type in
      // the recorded transcript. Treat that as divergence rather than emit a
      // potentially duplicated/reordered suffix.
      if (remaining.length > 0 && !this.isComplete()) {
        const next = this.expected[this.segmentIndex]!;
        if (next.type !== type) this.throwDivergence(type, next);
      }
    }
    return remaining;
  }

  /** Returns true when this is new suffix data that should be emitted. */
  consumeAtomic(type: Exclude<ReplaySegmentType, "content" | "reasoning">, data: string): boolean {
    if (this.isComplete()) return true;
    const segment = this.expected[this.segmentIndex]!;
    const semanticValueMismatch = type === "toolCall" && segment.data !== data;
    if (this.charOffset !== 0 || segment.type !== type || semanticValueMismatch) {
      this.throwDivergence(type, segment);
    }
    this.segmentIndex++;
    return false;
  }

  private throwDivergence(type: ReplaySegmentType, expected: ReplaySegment): never {
    throw new Error(
      `Kiro retry response diverged while replaying partial output: expected ${expected.type}, received ${type}` +
      ` (segment ${this.segmentIndex + 1}/${this.expected.length}, offset ${this.charOffset})`,
    );
  }
}

// ---- conversationId stability -----------------------------------------

/**
 * The real Kiro CLI keeps ONE `conversationId` for an entire session — every
 * turn of a conversation reuses the same id, and it stays the same even after
 * the CLI is restarted and the session is resumed.
 *
 * We reproduce both properties by deriving the conversationId DETERMINISTICALLY
 * from the gateway's stable per-conversation session key (see
 * `deriveLogSessionId` — first-message fingerprint / session header / user id,
 * all of which survive a restart because OpenCode re-sends the full history).
 * A random UUID + in-memory cache would reset every time the gateway process
 * restarts (e.g. closing OpenCode and reopening with `opencode -s <id>`),
 * minting a brand-new conversationId mid-conversation — the bug this fixes.
 *
 * The value is a v5-style (name-based) UUID: pure function of the key, so the
 * same conversation always maps to the same id across process restarts, with
 * no shared mutable state. Requests with no session key fall back to a random
 * one-off UUID.
 */
const CONVERSATION_ID_NAMESPACE = "opencode-kiro/conversation";

function deterministicConversationId(key: string): string {
  // SHA-1 over namespace + key, first 16 bytes, with RFC-4122 version (5) and
  // variant bits set — a valid, stable name-based UUID.
  const digest = createHash("sha1").update(`${CONVERSATION_ID_NAMESPACE}\u0000${key}`).digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function resolveConversationId(sessionId: string | undefined): string {
  if (!sessionId) return crypto.randomUUID();
  return deterministicConversationId(sessionId);
}

// ---- Main entry --------------------------------------------------------

export function streamKiro(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream(STREAM_EVENT_QUEUE_SIZE);
  const deadlineSignal = AbortSignal.timeout(
    Math.max(1, options?.requestTimeoutMs ?? REQUEST_TIMEOUT_DEFAULT_MS),
  );
  const signal = options?.signal
    ? AbortSignal.any([options.signal, deadlineSignal])
    : deadlineSignal;
  // One log file per session — groups every turn (request/response/error)
  // regardless of which client (OpenCode, Claude Code, …) drove it.
  const fileLog = createSessionLogger(options?.logSessionId ?? options?.sessionId);
  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    // Hidden-reasoning breadcrumb timer. Armed on `start` (for
    // `reasoningHidden` models), cancelled as soon as any content or
    // tool-call event arrives. If the timer fires before anything
    // else, `emitHiddenReasoningLate` pushes a complete shim block
    // in one flush. Hoisted above the try/catch so the terminal
    // error path can cancel it, preventing a stray late shim from
    // firing after the stream ended.
    let hiddenShimTimer: ReturnType<typeof setTimeout> | null = null;
    let hiddenShimBlock: ThinkingContent | null = null;
    let startEmitted = false;

    try {
      const accessToken = options?.apiKey;
      if (!accessToken) {
        throw new Error("Kiro credentials not set. Run /login kiro.");
      }

      const endpoint = model.baseUrl || "https://runtime.us-east-1.kiro.dev";
      const profileArn = options?.profileArn ?? (await resolveProfileArn(
        accessToken,
        regionFromEndpoint(endpoint),
        options?.cacheProfileArn !== false,
        signal,
      )) ?? DEFAULT_PROFILE_ARN;
      const kiroModelId = resolveKiroModel(model.id);
      const nativeEffort = options?.nativeEffort;
      const thinkingEnabled = nativeEffort === "none"
        ? false
        : Boolean(nativeEffort) || !!options?.reasoning || model.reasoning;
      // Kiro models where upstream hides reasoning entirely (no `<thinking>`
      // tags in the text stream, no native reasoning event). We surface a
      // redacted ThinkingContent shim so downstream UIs can show a
      // "reasoning hidden" marker via the standard event stream contract.
      const reasoningHidden = !!(model as KiroModel).reasoningHidden;

      log.debug("request.init", {
        endpoint,
        model: model.id,
        kiroModelId,
        contextWindow: model.contextWindow,
        thinkingEnabled,
        reasoningHidden,
        reasoning: options?.reasoning,
        nativeEffort,
        messageCount: context.messages.length,
        toolCount: context.tools?.length ?? 0,
        hasSystemPrompt: !!context.systemPrompt,
        profileArn,
        sessionId: options?.sessionId,
      });

      let systemPrompt = context.systemPrompt ?? "";
      // Inject `<thinking_mode>` directive into the system prompt when
      // reasoning is enabled. This triggers Kiro to stream `reasoningContentEvent`
      // frames. The directive goes in the seed prompt content (first userInputMessage),
      // NOT in additionalModelRequestFields. Matches the real Kiro CLI behavior.
      if (thinkingEnabled && !reasoningHidden) {
        const reasoningLevel = nativeEffort ?? String(options?.reasoning ?? "");
        const budget =
          reasoningLevel === "xhigh" || reasoningLevel === "max"
            ? 50000
            : reasoningLevel === "high"
              ? 30000
              : reasoningLevel === "medium"
                ? 20000
                : 10000;
        systemPrompt = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>${
          systemPrompt ? `\n${systemPrompt}` : ""
        }`;
      }

      // A shared gateway may belong to a different OpenCode process, so prefer
      // the workspace attached to this request over the gateway process cwd.
      const envState: KiroEnvState = {
        operatingSystem: resolveOS(),
        currentWorkingDirectory: options?.workingDirectory ?? process.cwd(),
      };

      // Stable per-session conversationId (matches Kiro CLI: one id for the
      // whole session). Falls back to a fresh UUID only when no sessionId is
      // available. Computed ONCE here so retries of this turn — and every
      // later turn of the same conversation — reuse the same id.
      const conversationId = resolveConversationId(options?.sessionId);
      // A retry must send the same model-visible prompt. In particular, do not
      // regenerate the context timestamp after a long partial-output timeout:
      // semantic replay depends on asking Kiro the exact same question.
      const requestTimestamp = new Date();
      let retryCount = 0;
      const replayTranscript: ReplaySegment[] = [];
      let replayGate: SemanticReplayGate | null = null;
      let retainedCompactedHistory: KiroHistoryEntry[] | undefined;
      let retainedCompactedToolResults: KiroToolResult[] | undefined;
      let retainedContextTruncationAttempt = 0;
      let thinkingParser = thinkingEnabled
        ? new ThinkingTagParser(output, stream)
        : null;
      let textBlockIndex: number | null = null;

      while (retryCount <= MAX_RETRIES) {
        if (signal.aborted) throw abortReason(signal);

        const normalized = normalizeMessages(context.messages);
        // NOTE: systemPrompt is NOT passed to buildHistory. It contains the
        // <thinking_mode>enabled</thinking_mode> directive which, when replayed
        // in history, causes Bedrock to expect a reasoningContent.signature on
        // the following assistant response — triggering THINKING_SIGNATURE_INVALID.
        // The thinking directive only belongs in the current message (or seed).
        const {
          history: rebuiltHistory,
          systemPrepended: _systemPrepended,
          currentMsgStartIdx,
        } = buildHistory(normalized, kiroModelId);
        const history: KiroHistoryEntry[] = retainedCompactedHistory ?? rebuiltHistory;

        // Inject the synthetic system seed pair at the start of history.
        // The real Kiro CLI always sends this as the first history entries.
        if (!retainedCompactedHistory) {
          const seedInstruction = SYSTEM_SEED_INSTRUCTION.replace("{{modelId}}", kiroModelId);
          const seedPair: KiroHistoryEntry[] = [
            { userInputMessage: { content: seedInstruction, origin: "KIRO_CLI" } },
            { assistantResponseMessage: { content: SYSTEM_SEED_ACK } },
          ];
          history.unshift(...seedPair);
        }

        const currentMessages = normalized.slice(currentMsgStartIdx);
        const firstMsg = currentMessages[0];
        let currentContent = "";
        const currentToolResults: KiroToolResult[] = retainedCompactedToolResults ?? [];
        const rebuildCurrentToolResults = retainedCompactedToolResults === undefined;
        let currentImages: KiroImage[] | undefined;

        if (firstMsg?.role === "assistant") {
          const am = firstMsg;
          let armContent = "";
          let armReasoningText = "";
          let armReasoningSignature = "";
          let armRedactedContent: string | undefined;
          const armToolUses: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }> = [];
          if (Array.isArray(am.content)) {
            for (const b of am.content) {
              if (b.type === "text") {
                armContent += (b as TextContent).text;
              } else if (b.type === "thinking") {
                // Accumulate thinking text + signature for the reasoningContent field.
                // The real Kiro CLI uses a structured field, NOT <thinking> XML tags.
                const tb = b as unknown as { thinking: string; thinkingSignature?: string };
                const redactedContent = (b as ThinkingContent).redactedContent;
                const redacted = (b as ThinkingContent).redacted;
                if (redactedContent !== undefined) {
                  armRedactedContent = redactedContent;
                } else if (!redacted) {
                  armReasoningText += tb.thinking;
                }
                if (tb.thinkingSignature) armReasoningSignature = tb.thinkingSignature;
              } else if (b.type === "toolCall") {
                const tc = b as ToolCall;
                armToolUses.push({
                  name: tc.name,
                  toolUseId: toKiroToolUseId(tc.id),
                  input: parseToolArgs(tc.arguments),
                });
              }
            }
          }
          const hasReasoning = armReasoningText.length > 0 || armRedactedContent !== undefined;
          if (
            retainedCompactedHistory === undefined
            && (armContent || armToolUses.length > 0 || hasReasoning)
          ) {
            const last = history[history.length - 1];
            const reasoningContent = armRedactedContent !== undefined
              ? { redactedContent: armRedactedContent }
              : armReasoningText.length > 0 && armReasoningSignature
                ? { reasoningText: { text: armReasoningText, signature: armReasoningSignature } }
                : undefined;
            const messageId = reasoningContent ? resolveKiroAssistantMessageId(am) : undefined;
            if (last && !last.userInputMessage && last.assistantResponseMessage) {
              last.assistantResponseMessage.content += `\n\n${armContent}`;
              if (messageId) last.assistantResponseMessage.messageId = messageId;
              if (armToolUses.length > 0) {
                last.assistantResponseMessage.toolUses = [
                  ...(last.assistantResponseMessage.toolUses ?? []),
                  ...armToolUses,
                ];
              }
              if (reasoningContent) {
                last.assistantResponseMessage.reasoningContent = reasoningContent;
              }
            } else {
              history.push({
                assistantResponseMessage: {
                  content: armContent,
                  ...(messageId ? { messageId } : {}),
                  ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
                  ...(reasoningContent ? { reasoningContent } : {}),
                },
              });
            }
          }

          const toolResultImages: ImageContent[] = [];
          for (let i = 1; i < currentMessages.length; i++) {
            const m = currentMessages[i];
            if (m?.role === "toolResult") {
              const trm = m as ToolResultMessage;
              if (rebuildCurrentToolResults) {
                currentToolResults.push({
                  content: [convertToolResultContent(getContentText(m))],
                  status: trm.isError ? "error" : "success",
                  toolUseId: toKiroToolUseId(trm.toolCallId),
                });
              }
              if (Array.isArray(trm.content)) {
                for (const c of trm.content) {
                  if (c.type === "image") toolResultImages.push(c as ImageContent);
                }
              }
            }
          }
          if (toolResultImages.length > 0) {
            const { images: converted, omitted } = convertImagesToKiro(toolResultImages);
            if (omitted > 0) log.info(`${omitted} tool-result image(s) omitted (size/count limit)`);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          currentContent = currentToolResults.length > 0 ? "Tool results provided." : "Please proceed with the task.";
        } else if (firstMsg?.role === "toolResult") {
          const toolResultImages: ImageContent[] = [];
          for (const m of currentMessages) {
            if (m?.role === "toolResult") {
              const trm = m as ToolResultMessage;
              if (rebuildCurrentToolResults) {
                currentToolResults.push({
                  content: [convertToolResultContent(getContentText(m))],
                  status: trm.isError ? "error" : "success",
                  toolUseId: toKiroToolUseId(trm.toolCallId),
                });
              }
              if (Array.isArray(trm.content)) {
                for (const c of trm.content) {
                  if (c.type === "image") toolResultImages.push(c as ImageContent);
                }
              }
            }
          }
          if (toolResultImages.length > 0) {
            const { images: converted, omitted } = convertImagesToKiro(toolResultImages);
            if (omitted > 0) log.info(`${omitted} tool-result image(s) omitted (size/count limit)`);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          currentContent = "Tool results provided.";
        } else if (firstMsg?.role === "user") {
          currentContent = typeof firstMsg.content === "string" ? firstMsg.content : getContentText(firstMsg);
          if (systemPrompt) {
            currentContent = `${systemPrompt}\n\n${currentContent}`;
          }
        }

        // Wrap content in the Kiro CLI format: context entry + user message.
        const now = requestTimestamp;
        const tzOffset = -now.getTimezoneOffset();
        const tzSign = tzOffset >= 0 ? "+" : "-";
        const tzH = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, "0");
        const tzM = String(Math.abs(tzOffset) % 60).padStart(2, "0");
        const isoLocal = now.getFullYear() + "-" +
          String(now.getMonth() + 1).padStart(2, "0") + "-" +
          String(now.getDate()).padStart(2, "0") + "T" +
          String(now.getHours()).padStart(2, "0") + ":" +
          String(now.getMinutes()).padStart(2, "0") + ":" +
          String(now.getSeconds()).padStart(2, "0") + "." +
          String(now.getMilliseconds()).padStart(3, "0") +
          tzSign + tzH + ":" + tzM;
        const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
        currentContent =
          `--- CONTEXT ENTRY BEGIN ---\n` +
          `Current time: ${weekday}, ${isoLocal}\n` +
          `--- CONTEXT ENTRY END ---\n\n` +
          `--- USER MESSAGE BEGIN ---\n` +
          `${currentContent}\n` +
          `--- USER MESSAGE END ---`;

        // Always include envState in userInputMessageContext (real client does).
        let uimc: { envState: KiroEnvState; toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] } = {
          envState,
        };
        if (currentToolResults.length > 0) uimc.toolResults = currentToolResults;
        if (context.tools?.length) {
          uimc.tools = convertToolsToKiro(context.tools);
        } else if (historyHasToolBlocks(history) || currentToolResults.length > 0) {
          // Bedrock rejects a request with TOOL_CONFIG_MISSING when the
          // conversation contains toolUse/toolResult blocks but no toolConfig
          // is defined. opencode sends auxiliary turns (title generation,
          // summarization, compaction) WITHOUT tools, yet the replayed history
          // still carries tool blocks from earlier turns — so the request 400s
          // and retries identically in a loop. When tool blocks are present but
          // no tools were supplied, inject a minimal placeholder tool so
          // toolConfig exists. The model won't call it on these auxiliary turns.
          uimc.tools = [KIRO_PLACEHOLDER_TOOL];
        }

        if (firstMsg?.role === "user") {
          const imgs = extractImages(firstMsg);
          if (imgs.length > 0) {
            const { images: converted, omitted } = convertImagesToKiro(imgs);
            if (omitted > 0) log.info(`${omitted} user image(s) omitted (size/count limit)`);
            currentImages = converted;
          }
        }

        const request: KiroRequest = {
          conversationState: {
            chatTriggerType: "MANUAL",
            agentTaskType: "vibe",
            conversationId,
            currentMessage: {
              userInputMessage: {
                content: currentContent,
                modelId: kiroModelId,
                origin: "KIRO_CLI",
                ...(currentImages ? { images: currentImages } : {}),
                userInputMessageContext: uimc,
              },
            },
            ...(history.length > 0 ? { history } : {}),
          },
          profileArn: profileArn || DEFAULT_PROFILE_ARN,
        };

        // Native effort is reserved for validated gateway values. Existing
        // direct callers continue using Pi's normalized ThinkingLevel mapping.
        const modelMetadata = options?.modelMetadata ?? findKiroModel(model.id) ?? (model as KiroModel);
        const nativeEfforts = modelMetadata.nativeEfforts;
        const supportedEfforts = modelMetadata?.supportedEfforts;
        const effortRequestField = modelMetadata?.effortRequestField;
        const supportsMaxTokens = modelMetadata?.supportsMaxTokens;
        const piToKiroEffort: Record<string, KiroNativeEffort> = {
          minimal: "low",
          low: "medium",
          medium: "high",
          high: "xhigh",
          xhigh: "max",
        };
        if (nativeEffort && nativeEfforts?.includes(nativeEffort)) {
          request.additionalModelRequestFields = request.additionalModelRequestFields || {};
          request.additionalModelRequestFields[effortRequestField ?? "output_config"] = { effort: nativeEffort };
          log.debug("effort.set", { effort: nativeEffort, model: model.id, source: "native" });
        } else if (supportedEfforts && supportedEfforts.length > 0 && options?.reasoning && typeof options.reasoning === "string") {
          const effort = piToKiroEffort[options.reasoning];
          const supported = nativeEfforts
            ? effort !== undefined && nativeEfforts.includes(effort)
            : supportedEfforts.includes(options.reasoning as typeof supportedEfforts[number]);
          if (effort && supported) {
            request.additionalModelRequestFields = request.additionalModelRequestFields || {};
            request.additionalModelRequestFields[effortRequestField ?? "output_config"] = { effort };
            log.debug("effort.set", { effort, model: model.id, source: "normalized" });
          }
        }

        // The live catalog is authoritative: only models that advertise the
        // top-level field accept it. Others (notably Claude Haiku 4.5) reject
        // the field but work normally when it is omitted.
        if (options?.maxTokens !== undefined) {
          if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) {
            throw new Error("maxTokens must be a positive integer");
          }
          const modelOutputLimit = Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0
            ? model.maxTokens
            : undefined;
          if (supportsMaxTokens) {
            const bounded = modelOutputLimit
              ? Math.min(options.maxTokens, modelOutputLimit)
              : options.maxTokens;
            request.additionalModelRequestFields = request.additionalModelRequestFields || {};
            request.additionalModelRequestFields.max_tokens = bounded;
            log.debug("maxTokens.set", { maxTokens: bounded, model: model.id });
          } else {
            log.debug("maxTokens.omitted", { maxTokens: options.maxTokens, model: model.id });
          }
        }

        // NOTE: Do NOT set additionalModelRequestFields.thinking here.
        // The real Kiro CLI never sends a thinking config — reasoning is
        // enabled by default when output_config.effort is present.
        // Setting thinking.type: "adaptive" explicitly was SUPPRESSING
        // reasoning for simpler prompts (the model would decide not to
        // think). Without it, Kiro streams reasoningContentEvent frames
        // unconditionally when effort ≥ "high".

        // -- HTTP request with capacity-retry inner loop -----------------
        // Emit `start` and arm the hidden-reasoning countdown. The
        // shim is deferred: if content or a tool call arrives within
        // HIDDEN_REASONING_COUNTDOWN_MS, the timer is cancelled and
        // no shim is emitted. If nothing arrives in time, the timer
        // fires a complete shim (start + delta + end) in one flush.
        // This covers the 25-30s server-side deliberation window on
        // Claude 4.7 without polluting fast responses with an empty
        // thinking block.
        if (!startEmitted) {
          stream.push({ type: "start", partial: output });
          startEmitted = true;
        }
        if (reasoningHidden && thinkingEnabled && hiddenShimTimer === null && hiddenShimBlock === null) {
          hiddenShimTimer = setTimeout(() => {
            hiddenShimTimer = null;
            hiddenShimBlock = emitHiddenReasoningLate(output, stream);
          }, HIDDEN_REASONING_COUNTDOWN_MS);
        }

        let response!: Response;
        let capacityRetryCount = 0;
        let transientRetryCount = 0;
        let contextTruncationAttempt: number = retainedContextTruncationAttempt;
        while (true) {
          await stream.waitForCapacity(STREAM_EVENT_PUSH_RESERVE, signal);
          const osName = resolveOS();
          const ua = `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/${osName} lang/rust/1.92.0 md/appVersion-2.19.1 app/AmazonQ-For-CLI`;
          const xAmzUa = `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/${osName} lang/rust/1.92.0 m/F,C app/AmazonQ-For-CLI`;
          const requestBody = JSON.stringify(request);


          log.debug("request.send", {
            attempt: retryCount,
            capacityAttempt: capacityRetryCount,
            historyLen: history.length,
            currentContentLen: currentContent.length,
            hasImages: !!currentImages,
            toolResultCount: currentToolResults.length,
            requestJsonChars: requestBody.length,
          });

          // Dump request body for debugging (debug level, file always written).
          // Per-session filename so it carries the session id like the .log file
          // and never clobbers another session's dump.
          log.debug(`[stream] req=${requestBody.length}c hist=${history.length} content=${currentContent.length}c profileArn=${!!profileArn}`);
          if (isFileLoggingEnabled()) {
            try {
              ensureLogDir();
              require("fs").writeFileSync(
                `${LOG_DIR}/session-${fileLog.sessionId}.last-request.json`,
                requestBody,
                { mode: 0o600 },
              );
            } catch {}
          }

          // File-based request logging (KIRO_FILE_LOG=1)
          fileLog.logRequest({
            endpoint,
            model: model.id,
            historyLength: history.length,
            requestBodyChars: requestBody.length,
            attempt: retryCount,
            conversationId,
          }, requestBody);

          try {
            response = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-amz-json-1.0",
                Accept: "*/*",
                "Accept-Encoding": "gzip",
                Authorization: `Bearer ${accessToken}`,
                "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
                "x-amzn-codewhisperer-optout": "true",
                "amz-sdk-invocation-id": crypto.randomUUID(),
                "amz-sdk-request": "attempt=1; max=3",
                "user-agent": ua,
                "x-amz-user-agent": xAmzUa,
                Pragma: "no-cache",
                "Cache-Control": "no-cache",
              },
              body: requestBody,
              signal,
            });
          } catch (error) {
            if (signal.aborted) throw abortReason(signal);

            const message = errorMessage(error);
            if (retryCount < MAX_RETRIES) {
              retryCount++;
              const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY_MS);
              fileLog.logStreamError({
                error: message,
                context: "fetch_retry",
                model: model.id,
                attempt: retryCount,
              });
              log.info(
                `network error before response: ${message} — retrying in ${delayMs}ms ` +
                `(${retryCount}/${MAX_RETRIES})`,
              );
              await abortableDelay(delayMs, signal);
              continue;
            }

            throw new Error(`Kiro API network error after max retries: ${message}`);
          }

          if (response.ok) break;

          let errText = "";
          try {
            errText = await readResponseTextLimited(response, {
              signal,
              timeoutMs: options?.errorBodyTimeoutMs,
            });
          } catch (error) {
            if (signal.aborted) throw abortReason(signal);
            errText = `[error body unavailable: ${errorMessage(error)}]`;
          }
          log.debug("response.error", {
            status: response.status,
            body: errText,
          });

          // File-based error logging (KIRO_FILE_LOG=1)
          fileLog.logHttpError({
            status: response.status,
            statusText: response.statusText,
            body: errText,
            endpoint,
            model: model.id,
            attempt: retryCount,
            historyLength: history.length,
          });

          if (isCapacityError(errText) && capacityRetryCount < CAPACITY_MAX_RETRIES) {
            capacityRetryCount++;
            const delayMs = exponentialBackoff(
              capacityRetryCount - 1,
              CAPACITY_BASE_DELAY_MS,
              CAPACITY_MAX_DELAY_MS,
            );
            log.info(
              `INSUFFICIENT_MODEL_CAPACITY — retrying in ${delayMs}ms (${capacityRetryCount}/${CAPACITY_MAX_RETRIES})`,
            );
            await abortableDelay(delayMs, signal);
            continue;
          }

          if (isNonRetryableBodyError(errText) || isCapacityError(errText)) {
            throw new Error(`Kiro API error: ${errText || response.statusText}`);
          }
          if (isTooBigError(response.status, errText)) {
            if (contextTruncationAttempt < CONTEXT_TRUNCATION_MAX_RETRIES) {
              const before = history.length;
              const droppedEntries = dropOldestHistoryTurnsForRetry(history);
              const compactedResults = compactCurrentToolResultsForRetry(currentToolResults);
              const resultsCompacted = compactedResults.afterChars < compactedResults.beforeChars;
              if (droppedEntries === 0 && !resultsCompacted) {
                throw new Error(`Kiro API error: context_length_exceeded (${response.status} ${errText})`);
              }

              contextTruncationAttempt++;
              retainedCompactedHistory = history;
              retainedCompactedToolResults = currentToolResults;
              retainedContextTruncationAttempt = contextTruncationAttempt;
              log.info(
                `context too large — truncated history from ${before} to ${history.length} entries ` +
                `(preserved seed/recent turns; dropped ${droppedEntries}), compacted current tool results ` +
                `from ${compactedResults.beforeChars} to ${compactedResults.afterChars} chars ` +
                `(attempt ${contextTruncationAttempt}/${CONTEXT_TRUNCATION_MAX_RETRIES})`,
              );
              // The request references both arrays, so their in-place changes
              // are reflected when requestBody is rebuilt on the next loop.
              request.conversationState.history = history.length > 0 ? history : undefined;
              continue;
            }
            throw new Error(`Kiro API error: context_length_exceeded (${response.status} ${errText})`);
          }
          if (isTransientError(response.status) && transientRetryCount < TRANSIENT_MAX_RETRIES) {
            transientRetryCount++;
            const jitter = Math.floor(Math.random() * 1000);
            const delayMs = exponentialBackoff(
              transientRetryCount - 1,
              TRANSIENT_BASE_DELAY_MS,
              TRANSIENT_MAX_DELAY_MS,
            ) + jitter;
            log.info(
              `transient error ${response.status} — retrying in ${delayMs}ms ` +
              `(${transientRetryCount}/${TRANSIENT_MAX_RETRIES})`,
            );
            await abortableDelay(delayMs, signal);
            continue;
          }
          if (response.status === 401) {
            const permanent = isPermanentError(errText);
            if (permanent) {
              resetProfileArnCache();
              throw new Error(
                `Kiro API error: credentials permanently invalid — run /login kiro to re-authenticate. ${errText}`,
              );
            }
            // Non-permanent 401 falls through to the generic throw below
          }
          if (response.status === 403) {
            // Access token was accepted earlier (profileArn resolved) but is
            // now rejected — drift, revocation, or server-side invalidation.
            // Bust the profileArn cache so the next attempt re-resolves with
            // a fresh token, and surface a clear re-login hint.
            resetProfileArnCache();
            throw new Error(
              `Kiro API error: access token rejected (403) — run /login kiro to re-authenticate. ${errText}`,
            );
          }
          throw new Error(`Kiro API error: ${response.status} ${response.statusText} ${errText}`);
        }

        if (capacityRetryCount > 0) {
          log.info(`recovered from capacity pressure after ${capacityRetryCount} retries`);
        }
        if (transientRetryCount > 0) {
          log.info(`recovered from transient error after ${transientRetryCount} retries`);
        }
        if (contextTruncationAttempt > 0) {
          log.info(`recovered after ${contextTruncationAttempt} context truncation(s)`);
        }

        // -- Consume response stream -------------------------------------
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";
        let totalContent = "";
        let usageEvent: { inputTokens?: number; outputTokens?: number } | null = null;
        let meteringCredits: number | undefined;
        let receivedContextUsage = false;
        let serverStopReason: string | null = null;
        let chunkSeq = 0;
        let eventSeq = 0;
        let totalResponseBytes = 0;
        const maxResponseBytes = Math.max(1, options?.maxResponseBytes ?? MAX_STREAM_RESPONSE_BYTES);
        const maxIncompleteFrameChars = Math.max(
          1,
          options?.maxIncompleteFrameChars ?? MAX_INCOMPLETE_FRAME_CHARS,
        );

        // ThinkingTagParser and textBlockIndex intentionally live across outer
        // retries. When a post-output retry replays the raw prefix, the replay
        // gate suppresses it and only the new suffix enters this retained parser
        // state. This also preserves an inline thinking tag split by a timeout.
        let emittedToolCalls = output.content.filter((block) => block.type === "toolCall").length;
        let sawAnyToolCalls = emittedToolCalls > 0;
        let currentToolCall: KiroToolCallState | null = null;
        let endedAtCompletedToolUse = false;
        const consumeReplayText = (type: "content" | "reasoning", data: string): string => {
          if (!replayGate) return data;
          const suffix = replayGate.consumeText(type, data);
          if (replayGate.isComplete()) replayGate = null;
          return suffix;
        };
        const consumeReplayAtomic = (
          type: Exclude<ReplaySegmentType, "content" | "reasoning">,
          data: string,
        ): boolean => {
          if (!replayGate) return true;
          const shouldEmit = replayGate.consumeAtomic(type, data);
          if (replayGate.isComplete()) replayGate = null;
          return shouldEmit;
        };
        const flushToolCall = (): boolean => {
          if (!currentToolCall) return false;
          const state = currentToolCall;
          currentToolCall = null;
          const toolCall = parseToolCall(state);
          if (!toolCall) return false;
          const replayKey = toolCallReplayKey(toolCall);
          if (consumeReplayAtomic("toolCall", replayKey)) {
            emitToolCall(toolCall, output, stream);
            appendReplayAtomic(replayTranscript, "toolCall", replayKey);
            emittedToolCalls++;
          }
          return true;
        };

        /**
         * Cancel the hidden-reasoning countdown timer. Called on the
         * first content / tool-call event so the shim is suppressed
         * when real output arrives in time. No-op once the timer
         * has already fired (the shim is self-contained and complete
         * by then, or was never armed for non-reasoningHidden models).
         */
        const cancelHiddenShim = () => {
          if (hiddenShimTimer) {
            clearTimeout(hiddenShimTimer);
            hiddenShimTimer = null;
          }
        };

        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let idleCancelled = false;
        const idleTimeoutMs = idleTimeoutForModel(model.id, options?.modelMetadata);
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleCancelled = true;
            void reader.cancel().catch(() => {});
          }, idleTimeoutMs);
        };

        let gotFirstToken = false;
        let firstTokenTimedOut = false;
        let streamError: string | null = null;
        let transportError: string | null = null;
        const FIRST_TOKEN_SENTINEL = Symbol("firstTokenTimeout");
        type ReadResult = { done: boolean; value?: Uint8Array };

        try {
        while (true) {
          let readResult: ReadResult;
          try {
            if (!gotFirstToken) {
              const readPromise = reader.read() as Promise<ReadResult>;
              let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
              const result = await Promise.race([
                readPromise,
                new Promise<typeof FIRST_TOKEN_SENTINEL>((resolve) => {
                  firstTokenTimer = setTimeout(
                    () => resolve(FIRST_TOKEN_SENTINEL),
                    firstTokenTimeoutForModel(model.id, options?.modelMetadata),
                  );
                }),
              ]);
              // Always clear the timer — otherwise the happy path keeps the
              // event loop alive for firstTokenTimeout ms after the stream
              // ends, which for opus-4-7 (180s) is user-visible as a hang
              // before a short-lived CLI exits.
              if (firstTokenTimer) clearTimeout(firstTokenTimer);
              if (result === FIRST_TOKEN_SENTINEL) {
                readPromise.catch(() => {});
                void reader.cancel().catch(() => {});
                firstTokenTimedOut = true;
                break;
              }
              readResult = result as ReadResult;
              gotFirstToken = true;
              resetIdle();
            } else {
              const readPromise = reader.read() as Promise<ReadResult>;
              let chunkTimer: ReturnType<typeof setTimeout> | null = null;
              const IDLE_SENTINEL = Symbol("idleTimeout");
              const result = await Promise.race([
                readPromise,
                new Promise<typeof IDLE_SENTINEL>((resolve) => {
                  chunkTimer = setTimeout(
                    () => resolve(IDLE_SENTINEL),
                    idleTimeoutMs,
                  );
                }),
              ]);
              if (chunkTimer) clearTimeout(chunkTimer);
              if (result === IDLE_SENTINEL) {
                readPromise.catch(() => {});
                idleCancelled = true;
                void reader.cancel().catch(() => {});
                break;
              }
              readResult = result as ReadResult;
            }
          } catch (error) {
            if (signal.aborted) throw abortReason(signal);
            if (idleCancelled) break;

            transportError = errorMessage(error);
            fileLog.logStreamError({
              error: transportError,
              context: "read_transport",
              model: model.id,
              attempt: retryCount,
            });
            void reader.cancel().catch(() => {});
            break;
          }

          const { done, value } = readResult;
          totalResponseBytes += value?.byteLength ?? 0;
          if (totalResponseBytes > maxResponseBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`Kiro API response exceeded ${maxResponseBytes} bytes`);
          }
          const bufferedBeforeRead = buffer.length;
          const decoded = done ? decoder.decode() : decoder.decode(value, { stream: true });
          buffer += decoded;
          if (!done && log.isDebug()) {
            log.debug("stream.chunk", {
              seq: chunkSeq++,
              bytes: value?.byteLength ?? 0,
              decodedLen: decoded.length,
              // Printable preview of the decoded chunk — control chars shown as \xNN.
              preview: previewChunk(decoded),
            });
          }
          const { events, remaining } = parseKiroEvents(buffer);
          buffer = remaining;
          if (buffer.length > maxIncompleteFrameChars) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`Kiro API incomplete event frame exceeded ${maxIncompleteFrameChars} characters`);
          }

          // Reset on complete events or growth of a parser-retained incomplete
          // event. Arbitrary framing/keepalive bytes are discarded by the
          // parser and therefore cannot keep a dead stream alive, while a
          // large tool-use frame split across reads still counts as progress.
          const retainedFrameProgress = !done
            && decoded.length > 0
            && remaining.length > bufferedBeforeRead;
          if (events.length > 0 || retainedFrameProgress) resetIdle();

          const debugEvents = log.isDebug();
          for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
            await stream.waitForCapacity(STREAM_EVENT_PUSH_RESERVE, signal);
            const event = events[eventIndex]!;
            const sequence = eventSeq++;
            if (debugEvents) log.debug("stream.event", { seq: sequence, event });
            fileLog.logResponseEvent({ type: event.type, data: event.data, eventSeq: sequence });
            if (event.type !== "toolUseStop" && event.type !== "error") {
              endedAtCompletedToolUse = false;
            }
            switch (event.type) {
              case "contextUsage": {
                const pct = event.data.contextUsagePercentage;
                // Force overflow detection when context nears capacity.
                // Pi's isContextOverflow() triggers compaction when
                // usage.input > contextWindow.
                output.usage.input = pct >= COMPACTION_THRESHOLD_PCT
                  ? model.contextWindow + 1
                  : Math.round((pct / 100) * model.contextWindow);
                receivedContextUsage = true;
                log.debug("contextUsage", { pct, threshold: COMPACTION_THRESHOLD_PCT, willCompact: pct >= COMPACTION_THRESHOLD_PCT });
                break;
              }
              case "reasoning": {
                // Native reasoning event from Kiro (Opus 4.7+).
                // Accumulate chunks into a single Pi thinking block.
                cancelHiddenShim();
                if (!output.responseId) output.responseId = crypto.randomUUID();
                if (event.data.redactedContent !== undefined) {
                  if (!consumeReplayAtomic("redactedReasoning", event.data.redactedContent)) break;
                  appendReplayAtomic(replayTranscript, "redactedReasoning", event.data.redactedContent);
                  const contentIndex = output.content.length;
                  const block: ThinkingContent = {
                    type: "thinking",
                    thinking: "",
                    redacted: true,
                    redactedContent: event.data.redactedContent,
                  };
                  output.content.push(block);
                  stream.push({ type: "thinking_start", contentIndex, partial: output });
                  stream.push({ type: "thinking_end", contentIndex, content: "", partial: output });
                  break;
                }
                const hadThinkingBlock =
                  output.content.length > 0 &&
                  output.content[output.content.length - 1]?.type === "thinking";
                // A signature-only frame (no reasoning text) with no open
                // thinking block has nothing to attach to — skip it instead of
                // emitting a stray empty thinking block.
                let reasoningSuffix = "";
                if (event.data.text) {
                  totalContent += event.data.text;
                  reasoningSuffix = consumeReplayText("reasoning", event.data.text);
                  if (reasoningSuffix) appendReplayText(replayTranscript, "reasoning", reasoningSuffix);
                }
                // A signature-only frame normally requires an existing native
                // thinking block. During semantic replay the block may no
                // longer be last (text from the first attempt follows it), but
                // the signature still has to pass through the replay gate so
                // the subsequent content segment stays aligned.
                const canProcessSignature = replayGate !== null
                  || hadThinkingBlock
                  || reasoningSuffix.length > 0;
                const emitSignature = event.data.signature && canProcessSignature
                  ? consumeReplayAtomic("reasoningSignature", event.data.signature)
                  : false;
                if (emitSignature && event.data.signature) {
                  appendReplayAtomic(replayTranscript, "reasoningSignature", event.data.signature);
                }
                if (!reasoningSuffix && !emitSignature) break;

                const lastIsThinking =
                  output.content.length > 0 &&
                  output.content[output.content.length - 1]?.type === "thinking";
                if (!lastIsThinking) {
                  output.content.push({ type: "thinking", thinking: "" });
                  stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
                }
                const contentIndex = output.content.length - 1;
                const tc = output.content[contentIndex] as ThinkingContent;
                if (reasoningSuffix) {
                  tc.thinking += reasoningSuffix;
                  stream.push({ type: "thinking_delta", contentIndex, delta: reasoningSuffix, partial: output });
                }
                if (emitSignature && event.data.signature) {
                  tc.thinkingSignature = event.data.signature;
                  stream.push({
                    type: "thinking_signature",
                    contentIndex,
                    signature: event.data.signature,
                    partial: output,
                  });
                }
                break;
              }
              case "content": {
                // NOTE: do NOT dedup identical consecutive content frames.
                // The event parser consumes the buffer without re-emitting, so
                // identical back-to-back chunks ("\n\n", repeated indentation,
                // repeated tokens in generated code) are legitimate model
                // output and must be preserved, not silently dropped.
                totalContent += event.data;
                // Cancel the deferred shim — real content arrived in
                // time, no breadcrumb needed.
                cancelHiddenShim();
                const contentSuffix = consumeReplayText("content", event.data);
                if (!contentSuffix) break;
                if (thinkingParser) {
                  thinkingParser.processChunk(contentSuffix);
                } else {
                  if (textBlockIndex === null) {
                    textBlockIndex = output.content.length;
                    output.content.push({ type: "text", text: "" });
                    stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
                  }
                  const block = output.content[textBlockIndex] as TextContent | undefined;
                  if (block) {
                    block.text += contentSuffix;
                    stream.push({
                      type: "text_delta",
                      contentIndex: textBlockIndex,
                      delta: contentSuffix,
                      partial: output,
                    });
                  }
                }
                appendReplayText(replayTranscript, "content", contentSuffix);
                break;
              }
              case "toolUse": {
                const tc = event.data;
                // Cancel the deferred shim — a tool call arrived in
                // time, no breadcrumb needed.
                cancelHiddenShim();
                sawAnyToolCalls = true;
                if (!currentToolCall || currentToolCall.toolUseId !== tc.toolUseId) {
                  flushToolCall();
                  currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: "" };
                }
                currentToolCall.input += tc.input || "";
                if (tc.input) totalContent += tc.input;
                if (tc.stop) {
                  endedAtCompletedToolUse = flushToolCall();
                }
                break;
              }
              case "toolUseInput": {
                if (currentToolCall) currentToolCall.input += event.data.input || "";
                if (event.data.input) totalContent += event.data.input;
                break;
              }
              case "toolUseStop": {
                if (event.data.stop) {
                  endedAtCompletedToolUse = flushToolCall() || endedAtCompletedToolUse;
                }
                break;
              }
              case "usage": {
                usageEvent = event.data;
                break;
              }
              case "metering": {
                meteringCredits = event.data.usage;
                break;
              }
              case "metadata": {
                // Authoritative stop reason from Kiro's metadataEvent.
                if (event.data.stopReason) serverStopReason = event.data.stopReason;
                break;
              }
              case "error": {
                streamError = event.data.message
                  ? `${event.data.error}: ${event.data.message}`
                  : event.data.error;
                fileLog.logStreamError({
                  error: streamError,
                  context: "stream_event",
                  model: model.id,
                  attempt: retryCount,
                });
                void reader.cancel().catch(() => {});
                break;
              }
            }
            if (streamError) break;
            if ((eventIndex + 1) % STREAM_EVENT_YIELD_INTERVAL === 0) {
              // A single 256 KiB read can contain tens of thousands of tiny
              // events. Yield between bounded batches so this process can
              // continue serving gateway health checks and concurrent clients.
              await yieldToEventLoop();
            }
          }
          if (done) break;
        }
        } finally {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        }

        // A clean EOF is also a valid boundary for a complete tool frame. Flush
        // it before checking whether a retry reproduced the prior prefix. Error
        // paths intentionally retain the old behavior and never publish a tool
        // whose stop boundary was not observed.
        if (!firstTokenTimedOut && !idleCancelled && !streamError && !transportError && currentToolCall) {
          await stream.waitForCapacity(STREAM_EVENT_PUSH_RESERVE, signal);
          endedAtCompletedToolUse = flushToolCall() || endedAtCompletedToolUse;
        }

        if (replayGate && !replayGate.isComplete() && !streamError && !transportError) {
          transportError = `retry ended before replaying ${replayGate.pendingDescription()}`;
        }

        const authoritativeStopReason = mapKiroStopReason(serverStopReason);
        const terminalOutputIsComplete = replayGate === null
          && authoritativeStopReason !== null
          && currentToolCall === null
          && (authoritativeStopReason !== "toolUse" || emittedToolCalls > 0);
        if ((transportError || idleCancelled) && terminalOutputIsComplete) {
          // Kiro sometimes closes the HTTP body after sending its authoritative
          // terminal metadata but before fetch observes a clean EOF. At that
          // point the turn is complete; surfacing the later socket reset would
          // incorrectly replace a valid answer with an API error.
          log.info("stream transport closed after terminal metadata — finalizing completed turn", {
            error: transportError,
            stopReason: serverStopReason,
          });
          transportError = null;
          idleCancelled = false;
        }

        if (isRecoverablePostOutputServiceException(streamError)) {
          if (terminalOutputIsComplete) {
            log.info("stream ServiceException arrived after terminal metadata — finalizing completed turn", {
              stopReason: serverStopReason,
            });
            streamError = null;
          } else if (
            endedAtCompletedToolUse
            && currentToolCall === null
            && emittedToolCalls > 0
          ) {
            // The generic retryable ServiceException can be emitted immediately
            // after a fully parsed tool call, before Kiro sends metadata. The
            // tool block is already complete and consumer-visible, so retries
            // would duplicate it; finalize this turn as TOOL_USE instead.
            log.info("stream ServiceException arrived after completed tool call — finalizing tool turn");
            serverStopReason = "TOOL_USE";
            streamError = null;
          }
        }

        if (firstTokenTimedOut || idleCancelled || streamError || transportError) {
          const alreadyStreamed = output.content.some((block) => block !== hiddenShimBlock);
          const recoverableAfterPartial = firstTokenTimedOut
            || idleCancelled
            || transportError !== null
            || isRecoverablePostOutputStreamError(streamError);
          if ((!alreadyStreamed || recoverableAfterPartial) && retryCount < MAX_RETRIES) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY_MS);
            const streamErrDesc = firstTokenTimedOut
              ? "first-token timed out"
              : idleCancelled
                ? "idle timed out"
                : transportError
                  ? `network error: ${transportError}`
                  : `error: ${streamError}`;
            fileLog.logStreamError({
              error: streamErrDesc,
              context: "retry",
              model: model.id,
              attempt: retryCount,
            });
            log.info(
              `stream ${streamErrDesc} — retrying${alreadyStreamed ? " with semantic replay" : ""} ` +
              `(${retryCount}/${MAX_RETRIES})`,
            );
            // Cancel the pending shim BEFORE the backoff delay so
            // the timer can't fire mid-wait (exponential backoff
            // compounds to multi-second delays, easily exceeding
            // HIDDEN_REASONING_COUNTDOWN_MS). The retry re-arms a
            // fresh timer on the next `start`.
            cancelHiddenShim();
            await abortableDelay(delayMs, signal);
            if (alreadyStreamed) {
              // Snapshot every semantic segment already accepted. The next
              // attempt must replay this prefix exactly; matching events are
              // suppressed and only a new suffix reaches the consumer.
              replayGate = new SemanticReplayGate(
                replayTranscript.map((segment) => ({ ...segment })),
              );
            } else {
              // Nothing semantic reached the consumer, so discard any parser
              // buffer (for example a split `<thinking` prefix) and restart.
              output.content = hiddenShimBlock ? [hiddenShimBlock] : [];
              textBlockIndex = null;
              replayTranscript.length = 0;
              replayGate = null;
              thinkingParser = thinkingEnabled
                ? new ThinkingTagParser(output, stream)
                : null;
            }
            continue;
          }
          // Either we already streamed partial output (can't retract) or we're
          // out of retries.
          if (streamError || transportError) {
            // Surface the error. With partial content already streamed, the
            // consumer sees the partial output followed by the error — better
            // than silently truncating or duplicating.
            const finalError = streamError ?? transportError;
            throw new Error(
              `Kiro API stream error${alreadyStreamed ? " after partial output" : " after max retries"}: ${finalError}`,
            );
          }
          if (!alreadyStreamed) {
            throw new Error(
              `Kiro API error: ${firstTokenTimedOut ? "first token" : "idle"} timeout after max retries`,
            );
          }
          if (idleCancelled) {
            throw new Error("Kiro API idle timeout after partial output");
          }
          // Preserve the existing first-token fallback. In practice this path
          // cannot have streamed output because the first read never completed.
          log.info("stream first-token timeout after partial output — finalizing with partial content");
        }

        // Stream ended cleanly. Cancel the deferred shim before either retrying
        // or finalizing so it cannot fire during backoff or after `done`.
        cancelHiddenShim();

        if (currentToolCall) {
          await stream.waitForCapacity(STREAM_EVENT_PUSH_RESERVE, signal);
          flushToolCall();
        }
        const hasText = output.content.some((block) => block.type === "text" && block.text.length > 0);
        if (!hasText && !sawAnyToolCalls) {
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY_MS);
            const alreadyStreamed = output.content.some((block) => block !== hiddenShimBlock);
            log.info(
              `empty response — retrying${alreadyStreamed ? " with semantic replay" : ""} ` +
              `(${retryCount}/${MAX_RETRIES})`,
            );
            await abortableDelay(delayMs, signal);
            if (alreadyStreamed) {
              // Reasoning-only output is consumer-visible, not semantically
              // empty. Preserve output/parser state and gate the retried prefix
              // exactly like a retry after a transport failure.
              replayGate = new SemanticReplayGate(
                replayTranscript.map((segment) => ({ ...segment })),
              );
            } else {
              output.content = hiddenShimBlock ? [hiddenShimBlock] : [];
              textBlockIndex = null;
              replayTranscript.length = 0;
              replayGate = null;
              thinkingParser = thinkingEnabled
                ? new ThinkingTagParser(output, stream)
                : null;
            }
            continue;
          }
          log.info(`empty response persisted after ${MAX_RETRIES} retries`);
        }

        // Finalize inline reasoning only after deciding not to retry. Finalizing
        // an unterminated tag emits thinking_end, after which a retry must not
        // append further deltas to that block.
        if (thinkingParser) {
          await stream.waitForCapacity(STREAM_EVENT_PUSH_RESERVE, signal);
          thinkingParser.finalize();
          textBlockIndex = thinkingParser.getTextBlockIndex();
        }

        if (textBlockIndex !== null) {
          const block = output.content[textBlockIndex] as TextContent | undefined;
          if (block) {
            await stream.waitForCapacity(2, signal);
            stream.push({
              type: "text_end",
              contentIndex: textBlockIndex,
              content: block.text,
              partial: output,
            });
          }
        }

        if (usageEvent?.inputTokens !== undefined) output.usage.input = usageEvent.inputTokens;
        output.usage.output = usageEvent?.outputTokens ?? countTokens(totalContent);
        output.usage.totalTokens = output.usage.input + output.usage.output;
        try {
          calculateCost(model, output.usage);
        } catch {
          output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        }
        if (meteringCredits !== undefined) {
          if (!output.usage.cost) output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
          output.usage.cost.total = meteringCredits;
        }

        // Stop reason classification.
        // Prefer Kiro's authoritative metadataEvent — the real wire format
        // sends {"stopReason":"TOOL_USE"|"END_TURN"|"MAX_TOKENS"} as its own
        // event-stream frame (confirmed from a captured CLI response) — and
        // only fall back to heuristics when the server didn't send one.
        // Heuristic fallback (audit #10): toolUse when tools were called;
        // "length" when no contextUsage event arrived AND no tool calls
        // (treated as a truncation signal); "stop" otherwise. The Anthropic
        // gateway recomputes finishReason from message content anyway, so the
        // heuristic "length" never reaches end users.
        const mappedServerStop = mapKiroStopReason(serverStopReason);
        if (mappedServerStop) {
          output.stopReason = mappedServerStop;
        } else if (!receivedContextUsage && emittedToolCalls === 0) {
          output.stopReason = "length";
        } else {
          output.stopReason = emittedToolCalls > 0 ? "toolUse" : "stop";
        }

        await stream.waitForCapacity(1, signal);
        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
        log.debug("response.done", {
          stopReason: output.stopReason,
          emittedToolCalls,
          sawAnyToolCalls,
          usage: output.usage,
        });

        // File-based response done logging (KIRO_FILE_LOG=1)
        fileLog.logResponseDone({
          stopReason: output.stopReason,
          emittedToolCalls,
          usage: output.usage,
          contentBlocks: output.content.length,
          model: model.id,
        });

        stream.end();
        return;
      }
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      log.debug("response.caught", { stopReason: output.stopReason, error: output.errorMessage });

      // File-based caught error logging (KIRO_FILE_LOG=1)
      fileLog.logCaughtError({
        stopReason: output.stopReason,
        errorMessage: output.errorMessage,
        model: model.id,
      }, error);
      // Cancel the pending shim timer so no stray shim fires after
      // the error event. Nothing to close — the shim is self-
      // contained when it fires, and if the timer is still armed
      // here the shim simply never existed.
      if (hiddenShimTimer) {
        clearTimeout(hiddenShimTimer);
        hiddenShimTimer = null;
      }
      await stream.waitForCapacity(1);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })().catch(() => {
    try {
      stream.end();
    } catch {
      // ignore
    }
  });

  return stream;
}
