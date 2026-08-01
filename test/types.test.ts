import { describe, it, expect } from "vitest";
import { AssistantMessageEventStream, EventStream } from "../src/types";
import type { AssistantMessage } from "../src/types";

function makeMsg(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "kiro-api",
    provider: "kiro",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

describe("EventStream.result() settling (#8 — no hang on end without result)", () => {
  it("rejects result() when the stream end()s without a terminal event", async () => {
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: makeMsg() });
    stream.end(); // no done/error event ever emitted
    await expect(stream.result()).rejects.toThrow(/before producing a final result/);
  });

  it("resolves result() with the done message", async () => {
    const stream = new AssistantMessageEventStream();
    const msg = makeMsg();
    msg.content.push({ type: "text", text: "hi" });
    stream.push({ type: "done", reason: "stop", message: msg });
    stream.end();
    const final = await stream.result();
    expect(final.content[0]).toMatchObject({ type: "text", text: "hi" });
  });

  it("resolves result() with the error message", async () => {
    const stream = new AssistantMessageEventStream();
    const msg = makeMsg();
    msg.stopReason = "error";
    msg.errorMessage = "boom";
    stream.push({ type: "error", reason: "error", error: msg });
    stream.end();
    const final = await stream.result();
    expect(final.errorMessage).toBe("boom");
  });

  it("end() after a terminal event keeps the resolved result (no reject)", async () => {
    const stream = new EventStream<{ type: string }, number>(
      (e) => e.type === "done",
      () => 42,
    );
    stream.push({ type: "done" });
    stream.end(); // must NOT override the already-settled result with a rejection
    await expect(stream.result()).resolves.toBe(42);
  });

  it("unblocks a bounded producer when the iterator exits early", async () => {
    const stream = new EventStream<{ type: string }, number>(
      (event) => event.type === "done",
      () => 42,
      1,
    );
    const iterator = stream[Symbol.asyncIterator]();
    stream.push({ type: "delta" });
    await expect(iterator.next()).resolves.toMatchObject({ done: false });

    stream.push({ type: "queued" });
    let capacityReleased = false;
    const capacity = stream.waitForCapacity().then(() => {
      capacityReleased = true;
    });
    await Promise.resolve();
    expect(capacityReleased).toBe(false);

    await iterator.return?.();
    await capacity;
    stream.push({ type: "done" });

    expect(capacityReleased).toBe(true);
    await expect(stream.result()).resolves.toBe(42);
  });

  it("does not mark a rejected terminal push complete before queueing it", async () => {
    const stream = new EventStream<{ type: string }, number>(
      (event) => event.type === "done",
      () => 42,
      1,
    );
    const iterator = stream[Symbol.asyncIterator]();
    stream.push({ type: "first" });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "first" }, done: false });
    stream.push({ type: "queued" });

    expect(() => stream.push({ type: "done" })).toThrow("queue exceeded 1 events");
    let settled = false;
    const result = stream.result().then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "queued" }, done: false });
    stream.push({ type: "done" });
    await expect(result).resolves.toBe(42);
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "done" }, done: false });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });
});
