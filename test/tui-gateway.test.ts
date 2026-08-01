import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_AUTH_HEADER,
  GATEWAY_AUTH_NONCE_HEADER,
  GATEWAY_AUTH_TIMESTAMP_HEADER,
  GATEWAY_CAPABILITIES,
  GATEWAY_CHALLENGE_HEADER,
  GATEWAY_PROTOCOL_VERSION,
} from "../src/gateway-auth";
import { fetchVerifiedGatewayJson } from "../src/tui-gateway";

describe("TUI gateway authentication", () => {
  it("does not send request authentication when a listener fails the health challenge", async () => {
    const requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];
    const listener = createServer((req, response) => {
      requests.push({ url: req.url ?? "", headers: req.headers });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        service: "opencode-kiro-gateway",
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        capabilities: GATEWAY_CAPABILITIES,
        ready: true,
        proof: "0".repeat(64),
      }));
    });

    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Test listener did not bind a TCP port");

    try {
      await expect(fetchVerifiedGatewayJson(
        `http://127.0.0.1:${address.port}`,
        "/dashboard/api/usage",
        "real-local-gateway-secret",
        AbortSignal.timeout(1_000),
      )).rejects.toThrow("Gateway identity verification failed");
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/health");
    expect(requests[0]?.headers[GATEWAY_CHALLENGE_HEADER]).toBeTypeOf("string");
    expect(requests[0]?.headers[GATEWAY_AUTH_HEADER]).toBeUndefined();
    expect(requests[0]?.headers[GATEWAY_AUTH_TIMESTAMP_HEADER]).toBeUndefined();
    expect(requests[0]?.headers[GATEWAY_AUTH_NONCE_HEADER]).toBeUndefined();
    expect(requests[0]?.headers["x-api-key"]).toBeUndefined();
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });

  it("rejects an oversized unauthenticated health response", async () => {
    const listener = createServer((_req, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ padding: "x".repeat(70 * 1024) }));
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Test listener did not bind a TCP port");

    try {
      await expect(fetchVerifiedGatewayJson(
        `http://127.0.0.1:${address.port}`,
        "/dashboard/api/usage",
        "real-local-gateway-secret",
        AbortSignal.timeout(1_000),
      )).rejects.toThrow("exceeded");
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});
