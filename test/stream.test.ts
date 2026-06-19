import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ToolResultMessage,
} from "../src/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamKiro } from "../src/stream";
import { convertToolsToKiro } from "../src/transform";
import type { Tool } from "../src/types";
import { resetProfileArnCache, seedProfileArn } from "../src/models";

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

function mockFetchOk(body: string) {
  return vi.fn().mockResolvedValueOnce({
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
  });
}

describe("streamKiro", () => {
  beforeEach(() => {
    resetProfileArnCache(true);
  });

  afterEach(() => {
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
    expect(opts.headers["user-agent"]).toContain("md/appVersion-2.7.1");
    expect(opts.headers["x-amz-user-agent"]).toContain("aws-sdk-rust/1.3.15");
    expect(opts.headers["x-amz-user-agent"]).toContain("m/F");
    expect(opts.headers["x-amz-user-agent"]).not.toContain("md/appVersion");

    // x-amzn-kiro-agent-mode must NOT be sent (not present in real client)
    expect(opts.headers["x-amzn-kiro-agent-mode"]).toBeUndefined();
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
    expect(body.agentMode).toBe("vibe");
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
