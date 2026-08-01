import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const GATEWAY_AUTH_HEADER = "x-opencode-kiro-gateway-token";
export const GATEWAY_AUTH_TIMESTAMP_HEADER = "x-opencode-kiro-gateway-timestamp";
export const GATEWAY_AUTH_NONCE_HEADER = "x-opencode-kiro-gateway-nonce";
export const GATEWAY_CHALLENGE_HEADER = "x-opencode-kiro-challenge";
export const GATEWAY_PROTOCOL_VERSION = 5;
export const GATEWAY_JSON_MAX_BYTES = 64 * 1024;
export const GATEWAY_CAPABILITIES = [
  "request-workspace",
  "dynamic-models",
  "domain-separated-auth",
  "standard-client-auth",
  "route-bound-auth",
] as const;

export function gatewayChallengeProof(token: string, challenge: string): string {
  return createHmac("sha256", token).update(`health-proof:v1:${challenge}`).digest("hex");
}

export function gatewayRequestSignature(
  token: string,
  timestamp: string,
  nonce: string,
  method = "POST",
  path = "/v1/messages",
): string {
  return createHmac("sha256", token)
    .update(`request-auth:v2:${method.toUpperCase()}:${path}:${timestamp}:${nonce}`)
    .digest("hex");
}

export function gatewayRequestHeaders(
  token: string,
  method = "POST",
  path = "/v1/messages",
): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  return {
    [GATEWAY_AUTH_HEADER]: gatewayRequestSignature(token, timestamp, nonce, method, path),
    [GATEWAY_AUTH_TIMESTAMP_HEADER]: timestamp,
    [GATEWAY_AUTH_NONCE_HEADER]: nonce,
  };
}

export function verifyGatewayChallengeProof(
  token: string,
  challenge: string,
  candidate: unknown,
): boolean {
  if (typeof candidate !== "string" || !/^[a-f0-9]{64}$/.test(candidate)) return false;
  const actual = Buffer.from(candidate, "hex");
  const expected = Buffer.from(gatewayChallengeProof(token, challenge), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Read a small gateway JSON response without trusting Content-Length. */
export async function readGatewayJson<T>(
  response: Response,
  maxBytes = GATEWAY_JSON_MAX_BYTES,
): Promise<T> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Gateway JSON response exceeded ${maxBytes} bytes`);
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`Gateway JSON response exceeded ${maxBytes} bytes`);
    }
    return JSON.parse(text) as T;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Gateway JSON response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text) as T;
}
