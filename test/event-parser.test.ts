import { describe, expect, it } from "vitest";
import { parseKiroEventMulti, parseKiroEvents } from "../src/event-parser";

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
