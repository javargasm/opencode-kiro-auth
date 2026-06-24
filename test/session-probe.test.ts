import { describe, it, expect } from "vitest";
import {
  mostRecentSession,
  providerFromSession,
  providerFromMessages,
} from "../src/session-probe";

describe("mostRecentSession", () => {
  it("returns undefined for empty or non-array input", () => {
    expect(mostRecentSession([])).toBeUndefined();
    expect(mostRecentSession(undefined as any)).toBeUndefined();
  });

  it("picks the session with the highest time.updated", () => {
    const a = { id: "a", time: { updated: 100 } };
    const b = { id: "b", time: { updated: 300 } };
    const c = { id: "c", time: { updated: 200 } };
    expect(mostRecentSession([a, b, c])?.id).toBe("b");
  });

  it("falls back to time.created when updated is missing", () => {
    const a = { id: "a", time: { created: 50 } };
    const b = { id: "b", time: { created: 90 } };
    expect(mostRecentSession([a, b])?.id).toBe("b");
  });

  it("handles a single session", () => {
    expect(mostRecentSession([{ id: "solo", time: { updated: 1 } }])?.id).toBe("solo");
  });
});

describe("providerFromSession", () => {
  it("reads model.providerID first (runtime Session shape)", () => {
    expect(providerFromSession({ model: { providerID: "kiro" } })).toBe("kiro");
  });

  it("falls back to top-level providerID", () => {
    expect(providerFromSession({ providerID: "kiro" })).toBe("kiro");
  });

  it("returns undefined when no provider present", () => {
    expect(providerFromSession({ id: "x", title: "t" })).toBeUndefined();
    expect(providerFromSession(undefined)).toBeUndefined();
  });

  it("detects a non-kiro provider", () => {
    expect(providerFromSession({ model: { providerID: "opencode-go" } })).toBe("opencode-go");
  });
});

describe("providerFromMessages", () => {
  it("reads providerID from the HTTP {info,parts} shape, newest first", () => {
    const msgs = [
      { info: { providerID: "anthropic" }, parts: [] },
      { info: { providerID: "kiro" }, parts: [] },
    ];
    expect(providerFromMessages(msgs)).toBe("kiro");
  });

  it("reads providerID from a bare message array", () => {
    expect(providerFromMessages([{ providerID: "kiro" }])).toBe("kiro");
  });

  it("reads info.model.providerID nested shape", () => {
    expect(providerFromMessages([{ info: { model: { providerID: "kiro" } } }])).toBe("kiro");
  });

  it("skips messages without a provider and finds the older one", () => {
    const msgs = [
      { info: { providerID: "kiro" }, parts: [] },
      { info: { role: "user" }, parts: [] }, // newest, no provider
    ];
    expect(providerFromMessages(msgs)).toBe("kiro");
  });

  it("returns undefined for empty or non-array input", () => {
    expect(providerFromMessages([])).toBeUndefined();
    expect(providerFromMessages(undefined as any)).toBeUndefined();
  });

  it("detects a non-kiro provider (gateway stays cold)", () => {
    const pid = providerFromMessages([{ info: { providerID: "opencode-go" } }]);
    expect(pid).toBe("opencode-go");
    expect(pid === "kiro").toBe(false);
  });
});
