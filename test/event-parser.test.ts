import { describe, expect, it } from "vitest";
import { parseKiroEventMulti, parseKiroEvents, detectEventStreamException } from "../src/event-parser";

describe("parseKiroEventMulti — usage vs metering disambiguation", () => {
  it("emits a usage event when `usage` is an OBJECT (real usageEvent)", () => {
    const events = parseKiroEventMulti({ usage: { inputTokens: 1500, outputTokens: 320 } });
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type === "usage") {
      expect(usage.data.inputTokens).toBe(1500);
      expect(usage.data.outputTokens).toBe(320);
    }
  });

  it("does NOT emit a bogus usage event for a meteringEvent where `usage` is a NUMBER", () => {
    // Real frame captured from Kiro CLI:
    // {"unit":"credit","unitPlural":"credits","usage":0.17618616013267}
    const events = parseKiroEventMulti({
      unit: "credit",
      unitPlural: "credits",
      usage: 0.17618616013267,
    });

    // The regression: the old object-less guard pushed a usage event with
    // undefined tokens, which clobbered a real usageEvent from earlier in
    // the stream. There must be NO usage event here.
    expect(events.find((e) => e.type === "usage")).toBeUndefined();

    // It must still be recognized as metering with the credit amount.
    const metering = events.find((e) => e.type === "metering");
    expect(metering).toBeDefined();
    if (metering?.type === "metering") {
      expect(metering.data.usage).toBeCloseTo(0.17618616013267, 10);
    }
  });

  it("supports PascalCase Usage/InputTokens/OutputTokens", () => {
    const events = parseKiroEventMulti({ Usage: { InputTokens: 42, OutputTokens: 7 } });
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type === "usage") {
      expect(usage.data.inputTokens).toBe(42);
      expect(usage.data.outputTokens).toBe(7);
    }
  });
});

describe("parseKiroEvents — full stream ordering (usage before metering)", () => {
  it("preserves a real usageEvent even when a meteringEvent follows", () => {
    // A usageEvent (object) followed by a meteringEvent (number `usage`).
    const buffer =
      '{"usage":{"inputTokens":2000,"outputTokens":450}}' +
      '{"unit":"credit","unitPlural":"credits","usage":0.176}';

    const { events } = parseKiroEvents(buffer);

    const usageEvents = events.filter((e) => e.type === "usage");
    // Exactly one usage event, carrying the real token counts.
    expect(usageEvents).toHaveLength(1);
    const usage = usageEvents[0];
    if (usage?.type === "usage") {
      expect(usage.data.inputTokens).toBe(2000);
      expect(usage.data.outputTokens).toBe(450);
    }

    const metering = events.find((e) => e.type === "metering");
    expect(metering).toBeDefined();
    if (metering?.type === "metering") {
      expect(metering.data.usage).toBeCloseTo(0.176, 6);
    }
  });
});

describe("AWS Event Stream exception framing (vnd.amazon.eventstream)", () => {
  // Simulate the text-decoded bytes of an exception message: header name +
  // value-type byte (0x07 = string) + 2-byte big-endian length + value, then
  // the JSON payload (which carries only the message, never the type).
  function header(name: string, value: string): string {
    const len = value.length;
    return `:${name}\x07${String.fromCharCode((len >> 8) & 0xff)}${String.fromCharCode(len & 0xff)}${value}`;
  }
  function exceptionFrame(type: string, message: string): string {
    return (
      "\x00\x00\x00\x2a\x00\x00\x00\x1f" + // junk prelude bytes (length/CRC)
      header("message-type", "exception") +
      header("exception-type", type) +
      header("content-type", "application/json") +
      `{"message":${JSON.stringify(message)}}`
    );
  }

  it("detectEventStreamException pulls the type from the header and message from the payload", () => {
    const exc = detectEventStreamException(exceptionFrame("ThrottlingException", "slow down"));
    expect(exc).not.toBeNull();
    expect(exc?.type).toBe("ThrottlingException");
    expect(exc?.message).toBe("slow down");
  });

  it("surfaces an exception frame as an error event (payload has no `error` key)", () => {
    const { events } = parseKiroEvents(exceptionFrame("InternalServerException", "boom"));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.data.error).toBe("InternalServerException");
      expect(err.data.message).toBe("boom");
    }
  });

  it("still extracts content events that precede an exception frame", () => {
    const buffer = '{"content":"partial answer"}' + exceptionFrame("ThrottlingException", "rate");
    const { events } = parseKiroEvents(buffer);
    expect(events.find((e) => e.type === "content")).toBeDefined();
    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    if (err?.type === "error") expect(err.data.error).toBe("ThrottlingException");
  });

  it("does NOT false-positive on normal content that mentions an exception", () => {
    const { events } = parseKiroEvents(
      '{"content":"wrap it in a try/catch for the Exception"}{"contextUsagePercentage":5}',
    );
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(detectEventStreamException("just some text about an Exception class")).toBeNull();
  });

  it("does not double-emit when the payload already carries an `error` key", () => {
    const { events } = parseKiroEvents('{"error":"ValidationException","message":"bad input"}');
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });
});

describe("real captured Kiro CLI stream (vnd.amazon.eventstream payloads)", () => {
  // Header lines as they decode from the binary envelope, followed by the exact
  // JSON payloads captured from a real Kiro CLI response (claude-opus-4.8):
  // reasoning text → reasoning signature → assistant content (with modelId) →
  // toolUse (with escaped nested JSON in `input`) → metadata → contextUsage →
  // metering. initial-response ({"conversationId"}) is intentionally ignored.
  const realStream =
    ":event-type initial-response:content-type application/x-amz-json-1.0:message-type event" +
    '{"conversationId":""}' +
    ":event-type reasoningContentEvent:content-type application/json:message-type event" +
    '{"text":"El"}' +
    ":event-type reasoningContentEvent:content-type application/json:message-type event" +
    '{"text":" usuario neces"}' +
    ":event-type reasoningContentEvent:content-type application/json:message-type event" +
    '{"signature":"EscDCmMIDhABGAIqQA=="}' +
    ":event-type assistantResponseEvent:content-type application/json:message-type event" +
    '{"content":"Vo","modelId":"claude-opus-4.8"}' +
    ":event-type assistantResponseEvent:content-type application/json:message-type event" +
    '{"content":"y a buscar","modelId":"claude-opus-4.8"}' +
    ":event-type toolUseEvent:content-type application/json:message-type event" +
    '{"input":"{\\"pattern\\": \\"[Uu]ser","name":"grep","toolUseId":"tooluse_Xu"}' +
    ":event-type toolUseEvent:content-type application/json:message-type event" +
    '{"name":"grep","stop":true,"toolUseId":"tooluse_Xu"}' +
    ":event-type metadataEvent:content-type application/json:message-type event" +
    '{"stopReason":"TOOL_USE"}' +
    ":event-type contextUsageEvent:content-type application/json:message-type event" +
    '{"contextUsagePercentage":3.4357998371124268}' +
    ":event-type meteringEvent:content-type application/json:message-type event" +
    '{"unit":"credit","unitPlural":"credits","usage":0.34230098331674963}';

  it("extracts every event type, in order, from the real envelope", () => {
    const { events, remaining } = parseKiroEvents(realStream);
    expect(remaining).toBe("");

    // reasoning text chunks
    const reasoning = events.filter((e) => e.type === "reasoning");
    expect(reasoning.length).toBeGreaterThanOrEqual(3);
    if (reasoning[0]?.type === "reasoning") expect(reasoning[0].data.text).toBe("El");
    // signature-only reasoning frame survives with empty text
    const sig = reasoning.find((e) => e.type === "reasoning" && e.data.signature);
    expect(sig).toBeDefined();
    if (sig?.type === "reasoning") {
      expect(sig.data.text).toBe("");
      expect(sig.data.signature).toBe("EscDCmMIDhABGAIqQA==");
    }

    // assistant content (modelId in the same frame must not break extraction)
    const content = events.filter((e) => e.type === "content");
    expect(content.map((e) => (e.type === "content" ? e.data : ""))).toEqual(["Vo", "y a buscar"]);

    // toolUse with escaped nested JSON in `input`
    const toolUses = events.filter((e) => e.type === "toolUse");
    expect(toolUses.length).toBeGreaterThanOrEqual(2);
    const withInput = toolUses.find((e) => e.type === "toolUse" && e.data.input.includes("pattern"));
    expect(withInput).toBeDefined();
    if (withInput?.type === "toolUse") {
      expect(withInput.data.name).toBe("grep");
      expect(withInput.data.input).toBe('{"pattern": "[Uu]ser');
    }
    const stopFrame = toolUses.find((e) => e.type === "toolUse" && e.data.stop);
    expect(stopFrame).toBeDefined();

    // authoritative stop reason
    const meta = events.find((e) => e.type === "metadata");
    expect(meta).toBeDefined();
    if (meta?.type === "metadata") expect(meta.data.stopReason).toBe("TOOL_USE");

    // contextUsage + metering
    const ctx = events.find((e) => e.type === "contextUsage");
    if (ctx?.type === "contextUsage") expect(ctx.data.contextUsagePercentage).toBeCloseTo(3.4358, 3);
    const metering = events.find((e) => e.type === "metering");
    if (metering?.type === "metering") expect(metering.data.usage).toBeCloseTo(0.3423, 4);

    // no spurious error from the exception detector on a clean stream
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  it("emits a metadata event for a standalone metadataEvent frame", () => {
    const { events } = parseKiroEvents(
      ":event-type metadataEvent:content-type application/json:message-type event" +
        '{"stopReason":"END_TURN"}',
    );
    const meta = events.find((e) => e.type === "metadata");
    expect(meta).toBeDefined();
    if (meta?.type === "metadata") expect(meta.data.stopReason).toBe("END_TURN");
  });
});

describe("real captured Kiro CLI stream #2 — text-only END_TURN (no metadataEvent)", () => {
  // Second real capture: a pure-text answer. Unlike the tool-use capture, Kiro
  // sends NO metadataEvent here — the stream ends with contextUsage + metering.
  // This proves the server only emits an explicit stopReason for TOOL_USE, so
  // the heuristic fallback must carry END_TURN. Also exercises escaped quotes
  // and real "\n\n" inside content (must NOT be deduped/dropped).
  const realTextStream =
    ":event-type reasoningContentEvent\n:content-type application/json\n:message-type event" +
    '{"text":"Restaur"}' +
    ":event-type reasoningContentEvent\n:content-type application/json\n:message-type event" +
    '{"text":"é fable-5 con el"}' +
    ":event-type reasoningContentEvent\n:content-type application/json\n:message-type event" +
    '{"signature":"ErkGCmMIDhABGAIqQA=="}' +
    ":event-type assistantResponseEvent\n:content-type application/json\n:message-type event" +
    '{"content":"List","modelId":"claude-opus-4.8"}' +
    ":event-type assistantResponseEvent\n:content-type application/json\n:message-type event" +
    '{"content":"o. `claude-fable","modelId":"claude-opus-4.8"}' +
    ":event-type assistantResponseEvent\n:content-type application/json\n:message-type event" +
    '{"content":"del gateway).\\n\\nN","modelId":"claude-opus-4.8"}' +
    ":event-type assistantResponseEvent\n:content-type application/json\n:message-type event" +
    '{"content":"\\"Claude Fable 5 (disabled)\\"","modelId":"claude-opus-4.8"}' +
    ":event-type contextUsageEvent\n:content-type application/json\n:message-type event" +
    '{"contextUsagePercentage":9.30090045928955}' +
    ":event-type meteringEvent\n:content-type application/json\n:message-type event" +
    '{"unit":"credit","unitPlural":"credits","usage":0.4933805256384743}';

  it("emits NO metadata event (server sent no stopReason for END_TURN)", () => {
    const { events } = parseKiroEvents(realTextStream);
    expect(events.find((e) => e.type === "metadata")).toBeUndefined();
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  it("preserves real newlines and escaped quotes in content", () => {
    const { events } = parseKiroEvents(realTextStream);
    const joined = events
      .filter((e) => e.type === "content")
      .map((e) => (e.type === "content" ? e.data : ""))
      .join("");
    expect(joined).toContain("\n\n"); // the {"content":"...\\n\\nN"} frame
    expect(joined).toContain('"Claude Fable 5 (disabled)"'); // escaped quotes survive
  });

  it("captures reasoning text + signature and the trailing usage/metering", () => {
    const { events } = parseKiroEvents(realTextStream);
    const reasoning = events.filter((e) => e.type === "reasoning");
    expect(reasoning.some((e) => e.type === "reasoning" && e.data.text === "Restaur")).toBe(true);
    expect(reasoning.some((e) => e.type === "reasoning" && e.data.signature)).toBe(true);
    const ctx = events.find((e) => e.type === "contextUsage");
    if (ctx?.type === "contextUsage") expect(ctx.data.contextUsagePercentage).toBeCloseTo(9.3009, 3);
    const metering = events.find((e) => e.type === "metering");
    if (metering?.type === "metering") expect(metering.data.usage).toBeCloseTo(0.49338, 4);
  });
});
