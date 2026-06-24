import { describe, it, expect } from "vitest";
import { pickProviderId, providerIdFromEvent } from "../src/tui-detect";

describe("pickProviderId — active provider resolution for the TUI bar", () => {
  it("reads providerID from the session object first", () => {
    expect(pickProviderId({ providerID: "kiro" }, [])).toBe("kiro");
  });

  it("reads providerID from session.model nested shape", () => {
    expect(pickProviderId({ model: { providerID: "kiro" } }, [])).toBe("kiro");
  });

  it("falls back to the most recent message providerID", () => {
    const msgs = [
      { providerID: "anthropic" },
      { providerID: "kiro" }, // most recent wins
    ];
    expect(pickProviderId({}, msgs)).toBe("kiro");
  });

  it("falls back to message.model nested shape", () => {
    expect(pickProviderId(undefined, [{ model: { providerID: "kiro" } }])).toBe("kiro");
  });

  it("returns undefined when nothing carries a providerID", () => {
    expect(pickProviderId({}, [{ role: "user" }])).toBeUndefined();
  });

  it("returns undefined for empty session + no messages", () => {
    expect(pickProviderId(undefined, [])).toBeUndefined();
  });

  it("prefers the session providerID over messages", () => {
    expect(pickProviderId({ providerID: "kiro" }, [{ providerID: "opencode-go" }])).toBe("kiro");
  });

  it("detects a non-kiro provider (bar must stay hidden)", () => {
    const pid = pickProviderId({ providerID: "opencode-go" }, []);
    expect(pid).toBe("opencode-go");
    expect(pid === "kiro").toBe(false);
  });

  it("scans messages newest-to-oldest and skips entries without a provider", () => {
    const msgs = [
      { providerID: "kiro" },
      { role: "user" }, // no provider, newest
    ];
    // newest (index 1) has no provider, so it should find kiro at index 0
    expect(pickProviderId(null, msgs)).toBe("kiro");
  });
});

describe("providerIdFromEvent — gateway warm-up signal", () => {
  it("reads providerID from message.updated info (assistant Message shape)", () => {
    const ev = { type: "message.updated", properties: { info: { providerID: "kiro" } } };
    expect(providerIdFromEvent(ev)).toBe("kiro");
  });

  it("reads providerID from session.updated info.model (Session shape)", () => {
    const ev = { type: "session.updated", properties: { info: { model: { providerID: "kiro" } } } };
    expect(providerIdFromEvent(ev)).toBe("kiro");
  });

  it("reads providerID from top-level properties", () => {
    const ev = { type: "x", properties: { providerID: "kiro" } };
    expect(providerIdFromEvent(ev)).toBe("kiro");
  });

  it("returns undefined when event has no properties", () => {
    expect(providerIdFromEvent({ type: "x" })).toBeUndefined();
  });

  it("returns undefined when info carries no provider (e.g. user message)", () => {
    const ev = { type: "message.updated", properties: { info: { id: "msg_1", role: "user" } } };
    expect(providerIdFromEvent(ev)).toBeUndefined();
  });

  it("detects non-kiro provider in event (no warm-up)", () => {
    const ev = { type: "session.updated", properties: { info: { model: { providerID: "opencode-go" } } } };
    expect(providerIdFromEvent(ev)).toBe("opencode-go");
    expect(providerIdFromEvent(ev) === "kiro").toBe(false);
  });

  it("handles null/undefined event gracefully", () => {
    expect(providerIdFromEvent(null)).toBeUndefined();
    expect(providerIdFromEvent(undefined)).toBeUndefined();
  });
});
