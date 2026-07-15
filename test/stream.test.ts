import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ToolResultMessage,
} from "../src/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  streamKiro,
  firstTokenTimeoutForModel,
  idleTimeoutForModel,
  regionFromEndpoint,
  resolveConversationId,
} from "../src/stream";
import { buildHistory, convertToolResultContent, convertToolsToKiro } from "../src/transform";
import type { Tool } from "../src/types";
import { AssistantMessageEventStream } from "../src/types";
import { buildModelsFromApi, resetProfileArnCache, seedProfileArn, setCachedDynamicModels } from "../src/models";
import type { KiroModel } from "../src/models";
import { ThinkingTagParser } from "../src/thinking-parser";

function makeModel(overrides?: Partial<Model<Api>>): Model<Api> {
  return {
    id: "claude-sonnet-4-5",
    name: "Sonnet",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 65536,
    ...overrides,
  };
}

function makeContext(userMsg = "Hello"): Context {
  return {
    systemPrompt: "You are helpful",
    messages: [{ role: "user", content: userMsg, timestamp: Date.now() }],
    tools: [],
  };
}

const ts = Date.now();
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function collect(
  stream: ReturnType<typeof streamKiro>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) {
    events.push(e);
    if (e.type === "done" || e.type === "error") return events;
  }
  return events;
}

function mockFetchChunks(chunks: string[]) {
  let index = 0;
  const encoder = new TextEncoder();
  return vi.fn().mockResolvedValueOnce({
    ok: true,
    body: {
      getReader: () => ({
        read: vi.fn().mockImplementation(() =>
          index < chunks.length
            ? Promise.resolve({ done: false, value: encoder.encode(chunks[index++]!) })
            : Promise.resolve({ done: true, value: undefined }),
        ),
        cancel: vi.fn().mockResolvedValue(undefined),
      }),
    },
  });
}

function mockFetchOk(body: string) {
  return mockFetchChunks([body]);
}

describe("streamKiro", () => {
  beforeEach(() => {
    resetProfileArnCache(true);
  });

  afterEach(() => {
    setCachedDynamicModels(null);
    vi.restoreAllMocks();
  });

  it("emits error when no credentials", async () => {
    const events = await collect(streamKiro(makeModel(), makeContext(), {}));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.error.errorMessage).toContain("/login kiro");
    }
  });

  it("emits aborted when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const events = await collect(
      streamKiro(makeModel(), makeContext(), { apiKey: "t", signal: ac.signal }),
    );
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.error.stopReason).toBe("aborted");
    }
  });

  it("sends POST with expected headers matching real Kiro CLI", async () => {
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));

    const call = fetchMock.mock.calls[0];
    const [url, opts] = call as [string, { headers: Record<string, string>; method: string; body: string }];
    expect(url).toContain("generateAssistantResponse");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    expect(opts.headers["X-Amz-Target"]).toBe(
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    );
    expect(opts.headers["Content-Type"]).toBe("application/x-amz-json-1.0");
    expect(opts.headers.Accept).toBe("*/*");
    expect(opts.headers["Accept-Encoding"]).toBe("gzip");
    expect(opts.headers["amz-sdk-request"]).toBe("attempt=1; max=3");
    expect(opts.headers.Pragma).toBe("no-cache");
    expect(opts.headers["Cache-Control"]).toBe("no-cache");
    expect(opts.headers["x-amzn-codewhisperer-optout"]).toBe("true");

    // user-agent and x-amz-user-agent must differ (m/F vs md/appVersion)
    expect(opts.headers["user-agent"]).toContain("aws-sdk-rust/1.3.15");
    expect(opts.headers["user-agent"]).toContain("api/codewhispererstreaming/0.1.17975");
    expect(opts.headers["user-agent"]).toContain("md/appVersion-2.12.1");
    expect(opts.headers["x-amz-user-agent"]).toContain("aws-sdk-rust/1.3.15");
    expect(opts.headers["x-amz-user-agent"]).toContain("api/codewhispererstreaming/0.1.17975");
    expect(opts.headers["x-amz-user-agent"]).toContain("m/F");
    expect(opts.headers["x-amz-user-agent"]).not.toContain("md/appVersion");

    // x-amzn-kiro-agent-mode must NOT be sent (not present in real client)
    expect(opts.headers["x-amzn-kiro-agent-mode"]).toBeUndefined();
  });

  it.each([
    ["minimal", "low"],
    ["xhigh", "max"],
  ] as const)("preserves direct normalized GPT reasoning %s as Kiro effort %s", async (reasoning, effort) => {
    const [model] = buildModelsFromApi([{
      modelId: "gpt-5.2",
      modelName: "GPT 5.2",
      additionalModelRequestFieldsSchema: {
        properties: {
          reasoning: { properties: { effort: { enum: ["none", "low", "medium", "high", "xhigh", "max"] } } },
        },
      },
    }]);
    setCachedDynamicModels([model!]);
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await collect(streamKiro(model!, makeContext(), { apiKey: "tok", reasoning }));

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.additionalModelRequestFields.reasoning).toEqual({ effort });
    expect(body.additionalModelRequestFields.output_config).toBeUndefined();
  });

  it.each(["none", "low", "medium", "high", "xhigh", "max"] as const)(
    "serializes raw GPT native effort %s with scoped catalog metadata",
    async (effort) => {
      const [model] = buildModelsFromApi([{
        modelId: "gpt-5.6-sol",
        modelName: "GPT 5.6 Sol",
        additionalModelRequestFieldsSchema: {
          properties: {
            reasoning: { properties: { effort: { enum: ["none", "low", "medium", "high", "xhigh", "max"] } } },
          },
        },
      }]);
      setCachedDynamicModels([{ ...model!, effortRequestField: "output_config" }]);
      const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      await collect(streamKiro(model!, makeContext(), {
        apiKey: "tok", nativeEffort: effort, modelMetadata: model!,
      }));

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      expect(body.additionalModelRequestFields.reasoning).toEqual({ effort });
      expect(body.additionalModelRequestFields.output_config).toBeUndefined();
      if (effort === "none") {
        expect(body.conversationState.currentMessage.userInputMessage.content).not.toContain("<thinking_mode>");
        expect(body.conversationState.currentMessage.userInputMessage.content).not.toContain("<max_thinking_length>");
      }
    },
  );

  it("maps Claude effort to output_config.effort", async () => {
    const [model] = buildModelsFromApi([{
      modelId: "claude-opus-4.7",
      modelName: "Claude Opus 4.7",
      additionalModelRequestFieldsSchema: {
        properties: {
          output_config: { properties: { effort: { enum: ["low", "medium", "high", "xhigh", "max"] } } },
        },
      },
    }]);
    setCachedDynamicModels([model!]);
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await collect(streamKiro(model!, makeContext(), { apiKey: "tok", reasoning: "high" }));

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.additionalModelRequestFields.output_config).toEqual({ effort: "xhigh" });
    expect(body.additionalModelRequestFields.reasoning).toBeUndefined();
  });

  it.each(["low", "medium", "high", "max"] as const)(
    "serializes raw Claude native effort %s unchanged",
    async (effort) => {
      const [model] = buildModelsFromApi([{
        modelId: "claude-opus-4.7",
        modelName: "Claude Opus 4.7",
        additionalModelRequestFieldsSchema: {
          properties: {
            output_config: { properties: { effort: { enum: ["low", "medium", "high", "max"] } } },
          },
        },
      }]);
      setCachedDynamicModels([model!]);
      const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      await collect(streamKiro(model!, makeContext(), { apiKey: "tok", nativeEffort: effort }));

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      expect(body.additionalModelRequestFields.output_config).toEqual({ effort });
      expect(body.additionalModelRequestFields.reasoning).toBeUndefined();
    },
  );

  it("forwards max_tokens only when the catalog advertises it", async () => {
    const [gpt] = buildModelsFromApi([{
      modelId: "gpt-5.6-terra",
      modelName: "GPT 5.6 Terra",
      additionalModelRequestFieldsSchema: {
        properties: {
          reasoning: { properties: { effort: { enum: ["none", "low", "medium", "high", "xhigh", "max"] } } },
        },
      },
    }]);
    setCachedDynamicModels([gpt!]);
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await collect(streamKiro(gpt!, makeContext(), { apiKey: "tok", maxTokens: 100 }));
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.additionalModelRequestFields?.max_tokens).toBeUndefined();

    const [claude] = buildModelsFromApi([{
      modelId: "claude-opus-4.7",
      modelName: "Claude Opus 4.7",
      additionalModelRequestFieldsSchema: {
        properties: {
          output_config: { properties: { effort: { enum: ["low", "medium", "high", "max"] } } },
          thinking: { properties: { type: { enum: ["adaptive"] } } },
          max_tokens: { type: "integer" },
        },
      },
    }]);
    setCachedDynamicModels([claude!]);
    const secondFetch = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
    vi.spyOn(globalThis, "fetch").mockImplementation(secondFetch);
    await collect(streamKiro(claude!, makeContext(), { apiKey: "tok", maxTokens: 100 }));
    const secondBody = JSON.parse(secondFetch.mock.calls[0]?.[1]?.body as string);
    expect(secondBody.additionalModelRequestFields.max_tokens).toBe(1024);
  });

  it("uses the request workspace in Kiro envState", async () => {
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await collect(streamKiro(makeModel(), makeContext(), {
      apiKey: "tok",
      workingDirectory: "/tmp/request-workspace",
    }));

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(
      body.conversationState.currentMessage.userInputMessage.userInputMessageContext.envState.currentWorkingDirectory,
    ).toBe("/tmp/request-workspace");
  });

  it("parses text + contextUsage into usage", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":10}'));
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.reason).toBe("stop");
      expect(done.message.usage.input).toBe(20000);
      expect(done.message.usage.totalTokens).toBeGreaterThan(20000);
      expect(done.message.content.some((b) => b.type === "text")).toBe(true);
    }
  });

  it("preserves assistant text when every content frame prefix is split", async () => {
    const content = ["Every ", "frame ", "survives."];
    const prefix = '{"content":';
    const chunks = content.flatMap((text, index) => {
      const frame = JSON.stringify({ content: text });
      const splitAt = ((index * 4) % (prefix.length - 1)) + 1;
      return [
        `:event-type assistantResponseEvent:content-type application/json:message-type event${frame.slice(0, splitAt)}`,
        frame.slice(splitAt),
      ];
    });
    chunks.push('{"contextUsagePercentage":10}');
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetchChunks(chunks));

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((event) => event.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      const text = done.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      expect(text).toBe(content.join(""));
      expect(text).not.toBe("");
    }
  });

  it("emits toolUse stopReason when tool called", async () => {
    const toolPayload = '{"name":"bash","toolUseId":"t1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}';
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetchOk(`${toolPayload}{"contextUsagePercentage":20}`));
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type === "done") expect(done.reason).toBe("toolUse");
  });

  it("returns length when no contextUsage and no tool calls", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetchOk('{"content":"Partial"}'));
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type === "done") expect(done.reason).toBe("length");
  });

  it("413 propagates with context_length_exceeded marker", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      statusText: "Too Large",
      text: () => Promise.resolve("too big"),
    }));
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.error.errorMessage).toMatch(/context_length_exceeded/);
    }
  });

  it("MONTHLY_REQUEST_COUNT does not retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad",
      text: () => Promise.resolve("MONTHLY_REQUEST_COUNT exceeded"),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries fetch socket closures with exponential backoff before receiving a response", async () => {
    const socketClosed = new TypeError(
      "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
    );
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(socketClosed)
      .mockRejectedValueOnce(socketClosed)
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"content":"Hi"}{"contextUsagePercentage":5}') })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: vi.fn().mockResolvedValue(undefined),
          }),
        },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    vi.useFakeTimers();

    const p = collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const events = await p;

    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
  }, 30000);

  it("retries transport read errors before the first token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockRejectedValueOnce(new TypeError("socket connection closed")),
            cancel: vi.fn().mockResolvedValue(undefined),
          }),
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"content":"Recovered"}{"contextUsagePercentage":5}') })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: vi.fn().mockResolvedValue(undefined),
          }),
        },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    vi.useFakeTimers();

    const p = collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const events = await p;

    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
  }, 30000);

  it("does not retry transport read errors after partial output", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"content":"Partial"}') })
            .mockRejectedValueOnce(new TypeError("socket connection closed")),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "text_delta" && e.delta === "Partial")).toBe(true);
    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    if (err?.type === "error") {
      expect(err.error.errorMessage).toContain("after partial output");
    }
  });

  it("emits a terminal error when idle cancellation follows partial text and a complete tool call", async () => {
    vi.useFakeTimers();
    try {
      let resolveHangingRead!: (result: { done: true; value: undefined }) => void;
      const hangingRead = new Promise<{ done: true; value: undefined }>((resolve) => {
        resolveHangingRead = resolve;
      });
      const read = vi.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode(
            '{"content":"Partial"}' +
              '{"name":"bash","toolUseId":"t1","input":"{\\"cmd\\":\\"ls\\"}","stop":true}',
          ),
        })
        .mockReturnValueOnce(hangingRead);
      const cancel = vi.fn().mockImplementation(() => {
        resolveHangingRead({ done: true, value: undefined });
        return Promise.resolve();
      });
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => ({ read, cancel }) },
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
      const model = makeModel();

      const pendingEvents = collect(streamKiro(model, makeContext(), { apiKey: "tok" }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(idleTimeoutForModel(model.id));
      const events = await pendingEvents;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(events.some((e) => e.type === "text_delta" && e.delta === "Partial")).toBe(true);
      expect(events.some((e) => e.type === "toolcall_end")).toBe(true);
      expect(events.find((e) => e.type === "done")).toBeUndefined();
      const terminal = events[events.length - 1];
      expect(terminal?.type).toBe("error");
      if (terminal?.type === "error") {
        expect(terminal.error.errorMessage).toContain("idle timeout");
        expect(terminal.error.errorMessage).toContain("after partial output");
        expect(terminal.error.stopReason).toBe("error");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends origin: KIRO_CLI and modelId in dot format", async () => {
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    await collect(
      streamKiro(makeModel({ id: "claude-sonnet-4-5" }), makeContext(), { apiKey: "tok" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.conversationState.currentMessage.userInputMessage.origin).toBe("KIRO_CLI");
    expect(body.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-sonnet-4.5");
    expect(body.conversationState.agentTaskType).toBe("vibe");
    expect(body.agentMode).toBeUndefined();
  });

  it("preserves redacted reasoning for replay without exposing opaque text", async () => {
    const opaque = "c2Vuc2l0aXZlLXJlZGFjdGVkLWNvbnRlbnQ=";
    const fetchMock = mockFetchOk(
      `${JSON.stringify({ redactedContent: opaque })}{"content":"Hi"}{"contextUsagePercentage":5}`,
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      const thinking = done.message.content.find((block) => block.type === "thinking");
      expect(thinking).toMatchObject({
        type: "thinking",
        thinking: "",
        redacted: true,
        redactedContent: opaque,
      });
      expect(done.message.responseId).toEqual(expect.any(String));
      expect(events.filter((event) => event.type === "thinking_delta")).toEqual([]);

      const history = buildHistory(
        [
          { role: "user", content: "previous", timestamp: ts },
          done.message,
          { role: "user", content: "current", timestamp: ts },
        ],
        "claude-sonnet-4.5",
      ).history;
      const replayed = history.find((entry) => entry.assistantResponseMessage)?.assistantResponseMessage;
      expect(replayed).toMatchObject({
        messageId: done.message.responseId,
        reasoningContent: { redactedContent: opaque },
      });
      expect(replayed?.reasoningContent).not.toHaveProperty("reasoningText");

      const messageWithoutResponseId = { ...done.message, responseId: undefined };
      const buildFallbackId = () => buildHistory(
        [
          { role: "user", content: "previous", timestamp: ts },
          messageWithoutResponseId,
          { role: "user", content: "current", timestamp: ts },
        ],
        "claude-sonnet-4.5",
      ).history.find((entry) => entry.assistantResponseMessage)?.assistantResponseMessage?.messageId;
      const fallbackId = buildFallbackId();
      expect(fallbackId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(buildFallbackId()).toBe(fallbackId);
    }
  });

  it("converts JSON tool results to json blocks and truncates plain text blocks", () => {
    expect(convertToolResultContent('{"ok":true,"items":[1,2]}')).toEqual({
      json: { ok: true, items: [1, 2] },
    });
    expect(convertToolResultContent("[1,2]")).toEqual({ text: "[1,2]" });
    expect(convertToolResultContent("plain tool output")).toEqual({ text: "plain tool output" });
  });

  it("omits images from replayed history", () => {
    const history = buildHistory(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect this" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
          timestamp: ts,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "inspected" }],
          api: "kiro-api",
          provider: "kiro",
          model: "claude-sonnet-4-5",
          usage: zeroUsage,
          stopReason: "stop",
          timestamp: ts,
        },
        { role: "user", content: "continue", timestamp: ts },
      ],
      "claude-sonnet-4.5",
    ).history;

    expect(history[0]?.userInputMessage?.content).toContain("inspect this");
    expect(history[0]?.userInputMessage?.images).toBeUndefined();
  });

  it("keeps supported images on the current message", async () => {
    const fetchMock = mockFetchOk('{"content":"seen"}{"contextUsagePercentage":5}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    const context: Context = {
      systemPrompt: "",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
        timestamp: ts,
      }],
      tools: [],
    };

    await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.conversationState.currentMessage.userInputMessage.images).toEqual([
      { format: "png", source: { bytes: "iVBORw0KGgo=" } },
    ]);
  });

  it("injects thinking mode tags when reasoning is enabled", async () => {
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    await collect(
      streamKiro(makeModel({ reasoning: true }), makeContext(), {
        apiKey: "tok",
        reasoning: "high",
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain(
      "<thinking_mode>enabled</thinking_mode>",
    );
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain(
      "<max_thinking_length>30000",
    );
  });

  it("strips __tool_use_purpose from tool call arguments", async () => {
    const toolPayload =
      '{"name":"bash","toolUseId":"t1","input":"{\\"cmd\\":\\"ls\\",\\"__tool_use_purpose\\":\\"test\\"}","stop":true}';
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetchOk(`${toolPayload}{"contextUsagePercentage":5}`));
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    
    const deltaEvent = events.find((e) => e.type === "toolcall_delta");
    expect(deltaEvent).toBeDefined();
    if (deltaEvent?.type === "toolcall_delta") {
      expect(deltaEvent.delta).not.toContain("__tool_use_purpose");
      expect(JSON.parse(deltaEvent.delta)).toEqual({ cmd: "ls" });
    }

    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done").toBe(true);
    if (done?.type === "done") {
      const tc = done.message.content[0];
      expect(tc?.type).toBe("toolCall");
      if (tc?.type === "toolCall") {
        expect(tc.arguments).toEqual({ cmd: "ls" });
      }
    }
  });

  it("emits stream-level error when response body has error event", async () => {
    const errorBody = '{"error":"ThrottlingException","message":"Rate limit"}';
    const makeReader = () => ({
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(errorBody) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn().mockResolvedValue(undefined),
    });
    const makeResponse = () => ({ ok: true, body: { getReader: makeReader } });
    vi.spyOn(globalThis, "fetch").mockImplementation(vi
      .fn()
      .mockResolvedValueOnce(makeResponse())
      .mockResolvedValueOnce(makeResponse())
      .mockResolvedValueOnce(makeResponse())
      .mockResolvedValueOnce(makeResponse()));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    vi.useRealTimers();

    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    if (err?.type === "error") {
      expect(err.error.errorMessage).toMatch(/ThrottlingException/);
    }
  }, 30000);

  describe("context truncation on too-big errors", () => {
    function makeContextWithHistory(turns: number): Context {
      const messages: Context["messages"] = [];
      for (let i = 0; i < turns; i++) {
        messages.push({ role: "user", content: `msg ${i}`, timestamp: Date.now() });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: `reply ${i}` }],
          api: "kiro-api",
          provider: "kiro",
          model: "claude-sonnet-4-5",
          usage: zeroUsage,
          stopReason: "stop",
          timestamp: Date.now(),
        });
      }
      messages.push({ role: "user", content: "current question", timestamp: Date.now() });
      return { systemPrompt: "You are helpful", messages, tools: [] };
    }

    it("retries with truncated history on 413", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 413,
          statusText: "Too Large",
          text: () => Promise.resolve("too big"),
        })
        .mockResolvedValueOnce({
          ok: true,
          body: {
            getReader: () => ({
              read: vi.fn()
                .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"content":"Hi"}{"contextUsagePercentage":5}') })
                .mockResolvedValueOnce({ done: true, value: undefined }),
              cancel: vi.fn().mockResolvedValue(undefined),
            }),
          },
        });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const ctx = makeContextWithHistory(5);
      const events = await collect(streamKiro(makeModel(), ctx, { apiKey: "tok" }));

      expect(fetchMock).toHaveBeenCalledTimes(2);

      const firstBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
      const firstHistoryLen = firstBody.conversationState.history?.length ?? 0;
      const secondHistoryLen = secondBody.conversationState.history?.length ?? 0;
      expect(secondHistoryLen).toBeLessThan(firstHistoryLen);

      const done = events.find((e) => e.type === "done");
      expect(done?.type).toBe("done");
    }, 30000);
  });

  describe("reasoningHidden models (Claude 4.7)", () => {
    const hiddenModel = (): Model<Api> =>
      makeModel({
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        reasoning: true,
        ...({ reasoningHidden: true } as unknown as Partial<Model<Api>>),
      });

    it("skips <thinking_mode> system-prompt directive", async () => {
      const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
      await collect(
        streamKiro(hiddenModel(), makeContext(), { apiKey: "tok", reasoning: "high" }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const content = body.conversationState.currentMessage.userInputMessage.content as string;
      expect(content).not.toContain("<thinking_mode>");
      expect(content).not.toContain("<max_thinking_length>");
    });

    it("fast response emits no shim: content only, no thinking events", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        mockFetchOk('{"content":"Hi"}{"content":"!"}{"contextUsagePercentage":5}'),
      );
      const events = await collect(streamKiro(hiddenModel(), makeContext(), { apiKey: "tok" }));

      const types = events.map((e) => e.type);
      expect(types.filter((t) => t === "thinking_start")).toHaveLength(0);
      expect(types.filter((t) => t === "thinking_delta")).toHaveLength(0);
      expect(types.filter((t) => t === "thinking_end")).toHaveLength(0);

      const done = events.find((e) => e.type === "done");
      if (done?.type === "done") {
        expect(done.message.content).toHaveLength(1);
        const text = done.message.content[0];
        expect(text?.type).toBe("text");
        if (text?.type === "text") {
          expect(text.text).toBe("Hi!");
        }
      }
    });
  });

  describe("Bedrock tool-use validation (e2e through streamKiro)", () => {
    function user(text: string): Context["messages"][number] {
      return { role: "user" as const, content: text, timestamp: ts };
    }

    function toolResult(id: string, text: string): ToolResultMessage {
      return {
        role: "toolResult" as const,
        toolCallId: id,
        toolName: "bash",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: ts,
      };
    }

    /**
     * Validate Bedrock's two invariants on the request body:
     * 1. No duplicate toolUseIds within any single assistant message
     * 2. Every toolUse has a matching toolResult in the NEXT message
     */
    function validateBedrockInvariants(body: any): { errors: string[] } {
      const errors: string[] = [];
      const history: any[] = body.conversationState.history ?? [];

      for (let i = 0; i < history.length; i++) {
        const entry = history[i];
        const arm = entry?.assistantResponseMessage;
        if (!arm?.toolUses || arm.toolUses.length === 0) continue;

        const useIds = arm.toolUses.map((tu: any) => tu.toolUseId);
        const seen = new Set<string>();
        for (const id of useIds) {
          if (seen.has(id)) {
            errors.push(`TOOL_DUPLICATE: entry[${i}] has duplicate toolUseId "${id}"`);
          }
          seen.add(id);
        }

        const next = i + 1 < history.length ? history[i + 1] : undefined;
        const results = next?.userInputMessage?.userInputMessageContext?.toolResults;
        const resultIdSet = new Set((results ?? []).map((tr: any) => tr.toolUseId));
        for (const id of useIds) {
          if (!resultIdSet.has(id)) {
            errors.push(`TOOL_USE_RESULT_MISMATCH: entry[${i}] toolUse "${id}" has no matching toolResult in entry[${i + 1}]`);
          }
        }
      }

      const lastEntry = history[history.length - 1];
      if (lastEntry?.assistantResponseMessage?.toolUses?.length > 0) {
        const currentResults = body.conversationState.currentMessage
          ?.userInputMessage?.userInputMessageContext?.toolResults ?? [];
        const resultIdSet = new Set(currentResults.map((tr: any) => tr.toolUseId));
        for (const tu of lastEntry.assistantResponseMessage.toolUses) {
          if (!resultIdSet.has(tu.toolUseId)) {
            errors.push(
              `TOOL_USE_RESULT_MISMATCH: last history ASST toolUse "${tu.toolUseId}" has no matching toolResult in currentMessage`,
            );
          }
        }
      }

      return { errors };
    }

    it("e2e: agentic loop with tool calls produces valid request", async () => {
      const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const context: Context = {
        systemPrompt: "You are helpful",
        messages: [
          user("do a thing"),
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check" },
              { type: "toolCall", id: "tooluse_AAAA", name: "bash", arguments: { cmd: "ls" } },
              { type: "toolCall", id: "tooluse_BBBB", name: "read", arguments: { path: "f.ts" } },
            ],
            api: "kiro-api",
            provider: "kiro",
            model: "test",
            usage: zeroUsage,
            stopReason: "toolUse",
            timestamp: ts,
          },
          toolResult("tooluse_AAAA", "file1.ts"),
          toolResult("tooluse_BBBB", "contents"),
          {
            role: "assistant",
            content: [
              { type: "text", text: "Now writing" },
              { type: "toolCall", id: "tooluse_CCCC", name: "write", arguments: { path: "f.ts" } },
            ],
            api: "kiro-api",
            provider: "kiro",
            model: "test",
            usage: zeroUsage,
            stopReason: "toolUse",
            timestamp: ts,
          },
          toolResult("tooluse_CCCC", "done"),
          user("looks good"),
        ],
        tools: [],
      };

      await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const { errors } = validateBedrockInvariants(body);
      expect(errors).toEqual([]);
    });

    it("e2e: cross-provider handoff with non-Kiro tool IDs produces valid request", async () => {
      const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const foreignId1 = "call_abc123|fc_def456";
      const foreignId2 = "call_xyz789|fc_uvw012";
      const context: Context = {
        systemPrompt: "You are helpful",
        messages: [
          user("check files"),
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: foreignId1, name: "bash", arguments: { cmd: "ls" } },
              { type: "toolCall", id: foreignId2, name: "read", arguments: { path: "a.ts" } },
            ],
            api: "anthropic",
            provider: "anthropic",
            model: "claude-3",
            usage: zeroUsage,
            stopReason: "toolUse",
            timestamp: ts,
          },
          toolResult(foreignId1, "file list"),
          toolResult(foreignId2, "file contents"),
          user("now what?"),
        ],
        tools: [],
      };

      await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const { errors } = validateBedrockInvariants(body);
      expect(errors).toEqual([]);

      const bodyStr = JSON.stringify(body);
      expect(bodyStr).not.toContain(foreignId1);
      expect(bodyStr).not.toContain(foreignId2);
    });

    it("e2e: assistant with orphan toolUses gets sanitized (no MISMATCH)", async () => {
      const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const context: Context = {
        systemPrompt: "You are helpful",
        messages: [
          user("do something"),
          {
            role: "assistant",
            content: [
              { type: "text", text: "I'll check" },
              { type: "toolCall", id: "tooluse_AAAA", name: "bash", arguments: { cmd: "ls" } },
            ],
            api: "kiro-api",
            provider: "kiro",
            model: "test",
            usage: zeroUsage,
            stopReason: "toolUse",
            timestamp: ts,
          },
          toolResult("tooluse_AAAA", "ok"),
          {
            role: "assistant",
            content: [
              { type: "text", text: "One more thing" },
              { type: "toolCall", id: "tooluse_DDDD", name: "bash", arguments: { cmd: "pwd" } },
            ],
            api: "kiro-api",
            provider: "kiro",
            model: "test",
            usage: zeroUsage,
            stopReason: "stop",
            timestamp: ts,
          },
          user("continue please"),
        ],
        tools: [],
      };

      await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const { errors } = validateBedrockInvariants(body);
      expect(errors).toEqual([]);
    });

    it("e2e: duplicate tool call IDs get deduplicated (no TOOL_DUPLICATE)", async () => {
      const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const context: Context = {
        systemPrompt: "You are helpful",
        messages: [
          user("go"),
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "tooluse_SAME", name: "bash", arguments: { cmd: "ls" } },
              { type: "toolCall", id: "tooluse_SAME", name: "bash", arguments: { cmd: "pwd" } },
              { type: "toolCall", id: "tooluse_OTHER", name: "read", arguments: {} },
            ],
            api: "kiro-api",
            provider: "kiro",
            model: "test",
            usage: zeroUsage,
            stopReason: "toolUse",
            timestamp: ts,
          },
          toolResult("tooluse_SAME", "file list"),
          toolResult("tooluse_OTHER", "contents"),
          user("next"),
        ],
        tools: [],
      };

      await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const { errors } = validateBedrockInvariants(body);
      expect(errors).toEqual([]);
    });

    it("e2e: tools-less request with tool blocks in history injects a placeholder toolConfig (no TOOL_CONFIG_MISSING)", async () => {
      // Reproduces the TOOL_CONFIG_MISSING 400 loop: opencode sends an
      // auxiliary turn (title gen / summarization / compaction) with NO tools,
      // but the replayed history still carries toolUse/toolResult blocks from
      // earlier turns. Bedrock rejects that unless a toolConfig is present.
      const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const context: Context = {
        systemPrompt: "Summarize this conversation",
        messages: [
          user("do a thing"),
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "tooluse_AAAA", name: "bash", arguments: { cmd: "ls" } },
            ],
            api: "kiro-api",
            provider: "kiro",
            model: "test",
            usage: zeroUsage,
            stopReason: "toolUse",
            timestamp: ts,
          },
          toolResult("tooluse_AAAA", "file1.ts"),
          user("now summarize"),
        ],
        // No tools on this turn — the trigger for the bug.
        tools: [],
      };

      await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const tools =
        body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools;
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
      expect(tools[0].toolSpecification.name).toBe("noop");
    });

    it("e2e: tools-less request with NO tool blocks in history sends no toolConfig", async () => {
      const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const context: Context = {
        systemPrompt: "You are helpful",
        messages: [user("just chatting, no tools ever")],
        tools: [],
      };

      await collect(streamKiro(makeModel(), context, { apiKey: "tok" }));

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const tools =
        body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools;
      expect(tools).toBeUndefined();
    });
  });
});

describe("convertToolsToKiro schema sanitization", () => {
  function getJson(tool: Tool) {
    return convertToolsToKiro([tool])[0]!.toolSpecification.inputSchema.json as Record<string, any>;
  }

  it("preserves parameter names under `properties` (regression: params were stripped)", () => {
    const tool: Tool = {
      name: "codegraph_search",
      description: "Quick symbol search by name.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "the symbol to search" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    };

    const json = getJson(tool);
    // The real parameter MUST survive — before the fix only __tool_use_purpose remained.
    expect(json.properties).toHaveProperty("query");
    expect(json.properties.query).toEqual({ type: "string", description: "the symbol to search" });
    // The injected purpose field is still added.
    expect(json.properties).toHaveProperty("__tool_use_purpose");
    // `required` still references a param that now actually exists.
    expect(json.required).toEqual(["query"]);
  });

  it("preserves multiple params and keeps `required` consistent", () => {
    const tool: Tool = {
      name: "edit",
      description: "edit a file",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        required: ["filePath", "oldString", "newString"],
      },
    };

    const json = getJson(tool);
    expect(Object.keys(json.properties).sort()).toEqual(
      ["__tool_use_purpose", "filePath", "newString", "oldString", "replaceAll"].sort(),
    );
    expect(json.required).toEqual(["filePath", "oldString", "newString"]);
  });

  it("recurses into nested object properties without stripping inner param names", () => {
    const tool: Tool = {
      name: "complex",
      description: "nested params",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["open", "closed"] },
              limit: { type: "number" },
            },
            required: ["status"],
          },
        },
        required: ["filter"],
      },
    };

    const json = getJson(tool);
    expect(json.properties).toHaveProperty("filter");
    expect(json.properties.filter.properties).toHaveProperty("status");
    expect(json.properties.filter.properties).toHaveProperty("limit");
    expect(json.properties.filter.properties.status.enum).toEqual(["open", "closed"]);
    expect(json.properties.filter.required).toEqual(["status"]);
  });

  it("preserves array item param names via `items`", () => {
    const tool: Tool = {
      name: "batch",
      description: "array of objects",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                value: { type: "number" },
              },
            },
          },
        },
        required: ["items"],
      },
    };

    const json = getJson(tool);
    const itemSchema = json.properties.items.items;
    expect(itemSchema.properties).toHaveProperty("id");
    expect(itemSchema.properties).toHaveProperty("value");
  });

  it("still strips disallowed JSON Schema keywords (e.g. $schema, exclusiveMinimum)", () => {
    const tool: Tool = {
      name: "zodish",
      description: "zod-emitted schema",
      parameters: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          count: { type: "number", exclusiveMinimum: 0, description: "a count" },
        },
        required: ["count"],
      },
    };

    const json = getJson(tool);
    expect(json).not.toHaveProperty("$schema");
    expect(json.properties).toHaveProperty("count");
    // disallowed keyword removed from the sub-schema, allowed ones kept
    expect(json.properties.count).not.toHaveProperty("exclusiveMinimum");
    expect(json.properties.count.type).toBe("number");
    expect(json.properties.count.description).toBe("a count");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression tests for audited bugs (#1, #2, #4, #5, #9, #11, #12, #16)
// ─────────────────────────────────────────────────────────────────────────

describe("regionFromEndpoint (#1)", () => {
  it("extracts the region from runtime/management URLs", () => {
    expect(regionFromEndpoint("https://runtime.us-east-1.kiro.dev")).toBe("us-east-1");
    expect(regionFromEndpoint("https://runtime.eu-central-1.kiro.dev")).toBe("eu-central-1");
    expect(regionFromEndpoint("https://management.us-east-1.kiro.dev/")).toBe("us-east-1");
  });
  it("falls back to us-east-1 for unrecognized URLs", () => {
    expect(regionFromEndpoint("https://q.amazonaws.com/x")).toBe("us-east-1");
    expect(regionFromEndpoint("")).toBe("us-east-1");
  });
});

describe("firstTokenTimeoutForModel (#9 — consults dynamic models)", () => {
  afterEach(() => setCachedDynamicModels(null));

  it("falls back to the default for unknown models", () => {
    expect(firstTokenTimeoutForModel("totally-unknown")).toBe(90_000);
  });

  it("uses a static model's firstTokenTimeout", () => {
    expect(firstTokenTimeoutForModel("claude-opus-4-8")).toBe(180_000);
  });

  it("uses a dynamic-only model's firstTokenTimeout", () => {
    setCachedDynamicModels([
      {
        id: "dyn-opus",
        name: "Dyn",
        api: "kiro-api",
        provider: "kiro",
        baseUrl: "x",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1,
        maxTokens: 1,
        firstTokenTimeout: 180_000,
      } as KiroModel,
    ]);
    expect(firstTokenTimeoutForModel("dyn-opus")).toBe(180_000);
  });

  it("prefers refreshed metadata over the static definition for a known model", () => {
    setCachedDynamicModels([
      {
        id: "claude-opus-4-8",
        name: "Refreshed Opus",
        api: "kiro-api",
        provider: "kiro",
        baseUrl: "x",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1,
        maxTokens: 1,
        firstTokenTimeout: 45_000,
      } as KiroModel,
    ]);

    expect(firstTokenTimeoutForModel("claude-opus-4-8")).toBe(45_000);
  });
});

function mockFetchReader(body: string) {
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(body) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        cancel: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
}

describe("streamKiro bug fixes", () => {
  beforeEach(() => {
    resetProfileArnCache(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setCachedDynamicModels(null);
    resetProfileArnCache(true);
  });

  it("#1: resolveProfileArn is called with the region, not the base URL", async () => {
    resetProfileArnCache(false); // allow dynamic ARN resolution
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            profiles: [
              { arn: "arn:aws:codewhisperer:us-east-1:1:profile/X", profileType: "KIRO", status: "ACTIVE" },
            ],
          }),
      })
      .mockResolvedValueOnce(mockFetchReader('{"content":"Hi"}{"contextUsagePercentage":5}'));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await collect(
      streamKiro(makeModel({ baseUrl: "https://runtime.us-east-1.kiro.dev" }), makeContext(), { apiKey: "tok" }),
    );

    const profileUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(profileUrl).toBe("https://management.us-east-1.kiro.dev/");
    expect(profileUrl).not.toContain("management.https://");
  });

  it("#5: preserves identical consecutive content chunks (no blind dedup)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchOk('{"content":"a"}{"content":"a"}{"content":"b"}{"contextUsagePercentage":5}'),
    );
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      const text = done.message.content.find((b) => b.type === "text");
      expect(text?.type).toBe("text");
      if (text?.type === "text") expect(text.text).toBe("aab"); // both "a" survive
    }
  });

  it("#4/#2: a stream error after partial content does NOT retry and surfaces the error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchReader('{"content":"Hello"}{"error":"ThrottlingException","message":"rate"}'));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));

    // No reset-and-retry once content was streamed → exactly one HTTP call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    if (err?.type === "error") {
      expect(err.error.errorMessage).toMatch(/after partial output/);
      // Partial content is preserved, not discarded.
      expect(err.error.content.some((b) => b.type === "text")).toBe(true);
    }
  });

  it("#16: a signature-only reasoning frame creates no empty thinking block", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchOk('{"signature":"sig-only"}{"content":"Hi"}{"contextUsagePercentage":5}'),
    );
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    expect(events.filter((e) => e.type === "thinking_start")).toHaveLength(0);
    const done = events.find((e) => e.type === "done");
    if (done?.type === "done") {
      expect(done.message.content.every((b) => b.type !== "thinking")).toBe(true);
      const text = done.message.content.find((b) => b.type === "text");
      if (text?.type === "text") expect(text.text).toBe("Hi");
    }
  });

  it("#11: forwards clamped max_tokens for catalog-advertised models", async () => {
    const [model] = buildModelsFromApi([{
      modelId: "claude-opus-4.8",
      modelName: "Claude Opus 4.8",
      tokenLimits: { maxOutputTokens: 128_000 },
      additionalModelRequestFieldsSchema: {
        properties: {
          output_config: { properties: { effort: { enum: ["low", "medium", "high", "max"] } } },
          thinking: { properties: { type: { enum: ["adaptive"] } } },
          max_tokens: { type: "integer" },
        },
      },
    }]);
    setCachedDynamicModels([model!]);
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    await collect(
      streamKiro(model!, makeContext(), {
        apiKey: "tok",
        maxTokens: 50000,
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.additionalModelRequestFields?.max_tokens).toBe(50000);
  });

  it("#11: clamps max_tokens to the model output window", async () => {
    const [model] = buildModelsFromApi([{
      modelId: "claude-opus-4.8",
      modelName: "Claude Opus 4.8",
      tokenLimits: { maxOutputTokens: 64_000 },
      additionalModelRequestFieldsSchema: {
        properties: {
          output_config: { properties: { effort: { enum: ["low", "medium", "high", "max"] } } },
          thinking: { properties: { type: { enum: ["adaptive"] } } },
          max_tokens: { type: "integer" },
        },
      },
    }]);
    setCachedDynamicModels([model!]);
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    await collect(
      streamKiro(model!, makeContext(), {
        apiKey: "tok",
        maxTokens: 999999,
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.additionalModelRequestFields?.max_tokens).toBe(64000);
  });

  it("#11: omits max_tokens when the catalog does not advertise it", async () => {
    const [model] = buildModelsFromApi([{
      modelId: "claude-sonnet-4.5",
      modelName: "Claude Sonnet 4.5",
      additionalModelRequestFieldsSchema: {
        properties: {
          output_config: { properties: { effort: { enum: ["low", "medium", "high", "max"] } } },
          thinking: { properties: { type: { enum: ["adaptive"] } } },
        },
      },
    }]);
    setCachedDynamicModels([model!]);
    const fetchMock = mockFetchOk('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    await collect(
      streamKiro(model!, makeContext(), { apiKey: "tok", maxTokens: 50000 }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.additionalModelRequestFields?.max_tokens).toBeUndefined();
  });
});

describe("ThinkingTagParser ordering (#12 — no index-corrupting splice)", () => {
  function setup() {
    const output = {
      role: "assistant" as const,
      content: [] as any[],
      api: "kiro-api",
      provider: "kiro",
      model: "m",
      usage: zeroUsage,
      stopReason: "stop" as const,
      timestamp: 0,
    };
    const stream = new AssistantMessageEventStream();
    const pushed: any[] = [];
    vi.spyOn(stream, "push").mockImplementation((e: any) => {
      pushed.push(e);
    });
    return { output, pushed, parser: new ThinkingTagParser(output as any, stream) };
  }

  afterEach(() => vi.restoreAllMocks());

  it("text-before-thinking does not splice/renumber the already-emitted text block", () => {
    const { output, pushed, parser } = setup();
    parser.processChunk("Hello ");
    const textStart = pushed.find((e) => e.type === "text_start");
    expect(textStart?.contentIndex).toBe(0);

    parser.processChunk("<thinking>reasoning</thinking>");
    parser.finalize();

    // Thinking is APPENDED at index 1; the text block stays at index 0.
    const thinkingStart = pushed.find((e) => e.type === "thinking_start");
    expect(thinkingStart?.contentIndex).toBe(1);
    expect(output.content[0]?.type).toBe("text");
    expect(output.content[1]?.type).toBe("thinking");
    // Every emitted text_delta still references index 0 (no splice corruption).
    const textDeltas = pushed.filter((e) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.every((e) => e.contentIndex === 0)).toBe(true);
  });

  it("normal case (thinking before text) keeps thinking → text order", () => {
    const { output, parser } = setup();
    parser.processChunk("<thinking>plan</thinking>answer");
    parser.finalize();
    expect(output.content[0]?.type).toBe("thinking");
    expect(output.content[1]?.type).toBe("text");
  });
});

describe("metadataEvent stopReason (real wire format, authoritative)", () => {
  beforeEach(() => resetProfileArnCache(true));
  afterEach(() => {
    vi.restoreAllMocks();
    setCachedDynamicModels(null);
    resetProfileArnCache(true);
  });

  it("prefers END_TURN over the no-contextUsage length heuristic", async () => {
    // No contextUsage + no tools → the #10 heuristic would say "length";
    // the server's metadataEvent says END_TURN, which must win → "stop".
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchOk('{"content":"Done"}{"stopReason":"END_TURN"}'),
    );
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(done.reason).toBe("stop");
  });

  it("maps MAX_TOKENS to length even when contextUsage was received", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchOk('{"content":"Cut off"}{"contextUsagePercentage":5}{"stopReason":"MAX_TOKENS"}'),
    );
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((e) => e.type === "done");
    if (done?.type === "done") expect(done.reason).toBe("length");
  });

  it("maps TOOL_USE to toolUse", async () => {
    const tool = '{"name":"grep","toolUseId":"t1","stop":true}';
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchOk(`${tool}{"stopReason":"TOOL_USE"}{"contextUsagePercentage":5}`),
    );
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((e) => e.type === "done");
    if (done?.type === "done") expect(done.reason).toBe("toolUse");
  });

  it("falls back to the heuristic when no metadataEvent arrives", async () => {
    // Unchanged #10 behavior: no contextUsage, no tools, no stopReason → length.
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetchOk('{"content":"Partial"}'));
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    const done = events.find((e) => e.type === "done");
    if (done?.type === "done") expect(done.reason).toBe("length");
  });
});

describe("text-only END_TURN stream (real capture #2, no metadataEvent)", () => {
  beforeEach(() => resetProfileArnCache(true));
  afterEach(() => {
    vi.restoreAllMocks();
    setCachedDynamicModels(null);
    resetProfileArnCache(true);
  });

  it("resolves stopReason via the contextUsage heuristic and assembles text with newlines", async () => {
    // Mirrors the real capture: reasoning + signature, then content, then
    // contextUsage + metering, with NO metadataEvent. Heuristic → "stop".
    const body =
      '{"text":"Pensando"}{"signature":"SIG=="}' +
      '{"content":"Listo. ","modelId":"claude-opus-4.8"}' +
      '{"content":"Todo ok.\\n\\nFin","modelId":"claude-opus-4.8"}' +
      '{"contextUsagePercentage":9.30090045928955}' +
      '{"unit":"credit","unitPlural":"credits","usage":0.4933805256384743}';
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetchOk(body));
    const events = await collect(streamKiro(makeModel(), makeContext(), { apiKey: "tok" }));
    expect(events.some((event) => event.type === "thinking_signature" && event.signature === "SIG==")).toBe(true);
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.reason).toBe("stop");
      const text = done.message.content.find((b) => b.type === "text");
      expect(text?.type).toBe("text");
      if (text?.type === "text") {
        expect(text.text).toBe("Listo. Todo ok.\n\nFin");
      }
      // metering credit propagated as cost.total
      expect(done.message.usage.cost?.total).toBeCloseTo(0.4933805256384743, 10);
    }
  });
});

describe("conversationId stability (#17 — one deterministic id per session)", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  beforeEach(() => {
    resetProfileArnCache(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A fetch mock that yields a FRESH reader on every call, so a single mock can
  // back several streamKiro invocations (the once-style helper is consumed).
  function mockFetchOkRepeating(body: string) {
    return vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        body: {
          getReader: () => {
            const chunks = [
              { done: false, value: new TextEncoder().encode(body) },
              { done: true, value: undefined },
            ];
            let i = 0;
            return {
              read: () => Promise.resolve(chunks[i++] ?? { done: true, value: undefined }),
              cancel: () => Promise.resolve(undefined),
            };
          },
        },
      }),
    );
  }

  it("resolveConversationId is a deterministic v5 UUID — same id for one sessionId across calls", () => {
    const a = resolveConversationId("sess-1");
    const b = resolveConversationId("sess-1");
    expect(a).toBe(b);
    expect(a).toMatch(UUID_V5);
  });

  it("resolveConversationId survives a process restart (pure function of the key)", () => {
    // There is NO module-level cache: the id is derived purely from the session
    // key, so the SAME key yields the SAME id even after the gateway process
    // restarts (e.g. closing OpenCode and reopening with `opencode -s <id>`).
    // Pin the exact value so the mapping for existing conversations can never
    // silently drift if the derivation algorithm is changed.
    expect(resolveConversationId("c-deadbeefcafe")).toBe("4dbaa3ae-9fea-59f2-b4a2-0026ad22bb9d");
  });

  it("resolveConversationId returns DIFFERENT ids for different sessions", () => {
    expect(resolveConversationId("sess-1")).not.toBe(resolveConversationId("sess-2"));
  });

  it("resolveConversationId mints a fresh, random (v4) id when sessionId is undefined", () => {
    const a = resolveConversationId(undefined);
    const b = resolveConversationId(undefined);
    expect(a).not.toBe(b);
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
  });

  it("reuses ONE conversationId across multiple turns of the same session", async () => {
    const fetchMock = mockFetchOkRepeating('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await collect(streamKiro(makeModel(), makeContext("turn 1"), { apiKey: "tok", sessionId: "c-abc" }));
    await collect(streamKiro(makeModel(), makeContext("turn 2"), { apiKey: "tok", sessionId: "c-abc" }));

    const id0 = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).conversationState.conversationId;
    const id1 = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string).conversationState.conversationId;
    expect(id0).toMatch(UUID_V5);
    expect(id0).toBe(id1);
  });

  it("uses DIFFERENT conversationIds for different sessions", async () => {
    const fetchMock = mockFetchOkRepeating('{"content":"Hi"}{"contextUsagePercentage":5}');
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await collect(streamKiro(makeModel(), makeContext("a"), { apiKey: "tok", sessionId: "c-aaa" }));
    await collect(streamKiro(makeModel(), makeContext("b"), { apiKey: "tok", sessionId: "c-bbb" }));

    const id0 = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).conversationState.conversationId;
    const id1 = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string).conversationState.conversationId;
    expect(id0).not.toBe(id1);
  });
});
