// Local type definitions and runtime utilities for opencode-kiro.
//
// These replace the subset of @earendil-works/pi-ai that this plugin consumed.
// Keeping them local eliminates the external dependency and makes the plugin
// fully self-contained for the OpenCode plugin ecosystem.

import type { KiroModel } from "./models";

// ---- Content block types -----------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  /** Opaque provider payload used to replay redacted reasoning. */
  redactedContent?: string;
  /** When true, the thinking content was redacted by safety filters. */
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
}

// ---- Usage / Cost ------------------------------------------------------

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

// ---- Stop reasons ------------------------------------------------------

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// ---- Messages ----------------------------------------------------------

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---- API / Model / Context ---------------------------------------------

export type Api = string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/** Exact effort labels accepted by the Kiro catalog request schemas. */
export type KiroNativeEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

export interface SimpleStreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Absolute deadline for the complete upstream request, including headers and body. */
  requestTimeoutMs?: number;
  /** Maximum time spent consuming a non-success response body. */
  errorBodyTimeoutMs?: number;
  /** Defensive override for the maximum retained incomplete event frame. */
  maxIncompleteFrameChars?: number;
  /** Defensive override for total bytes accepted from one upstream response. */
  maxResponseBytes?: number;
  apiKey?: string;
  sessionId?: string;
  /** Absolute workspace path supplied by the OpenCode process for this request. */
  workingDirectory?: string;
  /** Account-specific profile supplied by the attaching OpenCode process. */
  profileArn?: string;
  /** Disable the process-wide profile cache for request-scoped bearer credentials. */
  cacheProfileArn?: boolean;
  /**
   * Stable identifier used to group all file-log entries (requests,
   * responses, errors) for one session into a single
   * `/tmp/kiro-logs/session-{id}.log` file. Does NOT affect the Kiro API
   * request. Falls back to `sessionId` when omitted.
   */
  logSessionId?: string;
  /** Request-scoped catalog metadata that must not fall back to another account. */
  modelMetadata?: KiroModel;
  /** A catalog-validated effort label; never normalize this value. */
  nativeEffort?: KiroNativeEffort;
  reasoning?: ThinkingLevel;
  headers?: Record<string, string>;
}

// ---- Event stream protocol ---------------------------------------------

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_signature"; contentIndex: number; signature: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

// ---- EventStream (generic push-based async iterable) --------------------

export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: Array<(result: { value: T; done: false } | { value: undefined; done: true }) => void> = [];
  private capacityWaiters = new Set<() => void>();
  private done = false;
  private iteratorStarted = false;
  private discardEvents = false;
  private finalResultPromise: Promise<R>;
  private resolveFinalResult!: (result: R) => void;
  private rejectFinalResult!: (reason?: unknown) => void;
  private resultSettled = false;
  private isComplete: (event: T) => boolean;
  private extractResult: (event: T) => R;

  constructor(
    isComplete: (event: T) => boolean,
    extractResult: (event: T) => R,
    private readonly maxQueueSize = Number.POSITIVE_INFINITY,
  ) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise<R>((resolve, reject) => {
      this.resolveFinalResult = resolve;
      this.rejectFinalResult = reject;
    });
    // end() may settle this promise (rejecting) before any caller awaits it.
    // Attach a no-op catch so an unobserved rejection never escalates to an
    // unhandledRejection; real awaiters of result() still observe it.
    this.finalResultPromise.catch(() => {});
  }

  push(event: T): void {
    if (this.done) return;
    const complete = this.isComplete(event);
    let finalResult!: R;
    if (complete) finalResult = this.extractResult(event);
    if (this.discardEvents) {
      if (complete) {
        this.done = true;
        this.resultSettled = true;
        this.resolveFinalResult(finalResult);
        this.notifyCapacity();
      }
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      if (this.queue.length >= this.maxQueueSize) {
        throw new Error(`Event stream queue exceeded ${this.maxQueueSize} events`);
      }
      this.queue.push(event);
    }
    if (complete) {
      this.done = true;
      this.resultSettled = true;
      this.resolveFinalResult(finalResult);
      this.notifyCapacity();
    }
  }

  private notifyCapacity(): void {
    for (const wake of this.capacityWaiters) wake();
    this.capacityWaiters.clear();
  }

  /** Pause an eager producer before it can overfill the bounded event queue. */
  async waitForCapacity(reserve = 1, signal?: AbortSignal): Promise<void> {
    const threshold = Math.max(0, this.maxQueueSize - Math.max(1, reserve));
    while (!this.done && !this.discardEvents && this.queue.length > threshold) {
      if (signal?.aborted) throw signal.reason ?? new Error("Event production aborted");
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          cleanup();
          resolve();
        };
        const onAbort = () => {
          cleanup();
          reject(signal?.reason ?? new Error("Event production aborted"));
        };
        const cleanup = () => {
          this.capacityWaiters.delete(wake);
          signal?.removeEventListener("abort", onAbort);
        };
        this.capacityWaiters.add(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (this.done || this.discardEvents || this.queue.length <= threshold) wake();
      });
    }
  }

  end(result?: R): void {
    this.done = true;
    if (result !== undefined) {
      this.resultSettled = true;
      this.resolveFinalResult(result);
    } else if (!this.resultSettled) {
      // Stream ended without ever producing a terminal (done/error) event.
      // Reject so callers awaiting result() fail fast instead of hanging
      // forever (e.g. the gateway's `await kiroStream.result()`).
      this.resultSettled = true;
      this.rejectFinalResult(new Error("Stream ended before producing a final result"));
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter!({ value: undefined, done: true });
    }
    this.notifyCapacity();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    this.iteratorStarted = true;
    try {
      while (true) {
        if (this.queue.length > 0) {
          const event = this.queue.shift()!;
          this.notifyCapacity();
          yield event;
        } else if (this.done) {
          return;
        } else {
          const result = await new Promise<{ value: T; done: false } | { value: undefined; done: true }>(
            (resolve) => this.waiting.push(resolve),
          );
          if (result.done) return;
          yield result.value;
        }
      }
    } finally {
      // There is one logical consumer. If it exits before the terminal event,
      // keep producing only the final result instead of deadlocking on a full
      // queue that nobody will drain.
      if (!this.done) {
        this.discardEvents = true;
        this.queue.length = 0;
        this.notifyCapacity();
      }
    }
  }

  result(): Promise<R> {
    // result()-only callers do not need deltas. Discard them so a bounded
    // producer cannot deadlock when there is intentionally no iterator.
    if (!this.iteratorStarted) {
      this.discardEvents = true;
      this.queue.length = 0;
      this.notifyCapacity();
    }
    return this.finalResultPromise;
  }
}

// ---- AssistantMessageEventStream (concrete stream type) -----------------

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor(maxQueueSize = Number.POSITIVE_INFINITY) {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type for final result");
      },
      maxQueueSize,
    );
  }
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}

// ---- calculateCost (Kiro models are zero-cost) --------------------------

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
  usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
  usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}
