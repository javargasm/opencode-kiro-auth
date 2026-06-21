// Local type definitions and runtime utilities for opencode-kiro.
//
// These replace the subset of @earendil-works/pi-ai that this plugin consumed.
// Keeping them local eliminates the external dependency and makes the plugin
// fully self-contained for the OpenCode plugin ecosystem.

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
  apiKey?: string;
  sessionId?: string;
  /**
   * Stable identifier used to group all file-log entries (requests,
   * responses, errors) for one session into a single
   * `/tmp/kiro-logs/session-{id}.log` file. Does NOT affect the Kiro API
   * request. Falls back to `sessionId` when omitted.
   */
  logSessionId?: string;
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
  private done = false;
  private finalResultPromise: Promise<R>;
  private resolveFinalResult!: (result: R) => void;
  private rejectFinalResult!: (reason?: unknown) => void;
  private resultSettled = false;
  private isComplete: (event: T) => boolean;
  private extractResult: (event: T) => R;

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
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
    if (this.isComplete(event)) {
      this.done = true;
      this.resultSettled = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
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
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
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
  }

  result(): Promise<R> {
    return this.finalResultPromise;
  }
}

// ---- AssistantMessageEventStream (concrete stream type) -----------------

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type for final result");
      },
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
