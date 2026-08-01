import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  GATEWAY_CAPABILITIES,
  GATEWAY_CHALLENGE_HEADER,
  GATEWAY_PROTOCOL_VERSION,
  gatewayRequestHeaders,
  readGatewayJson,
  verifyGatewayChallengeProof,
} from "./gateway-auth";

export function readGatewayToken(): string | null {
  try {
    const configuredOverride = process.env.KIRO_GATEWAY_TOKEN;
    if (configuredOverride !== undefined) {
      const override = configuredOverride.trim();
      return override.length >= 32 ? override : null;
    }
    const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    const token = readFileSync(join(cacheRoot, "opencode-kiro", "gateway-token"), "utf8").trim();
    return token.length >= 32 ? token : null;
  } catch {
    return null;
  }
}

/** Verify ownership by challenge-response before sending a nonce-bound HMAC. */
export async function fetchVerifiedGatewayJson<T>(
  origin: string,
  pathname: string,
  token: string,
  signal: AbortSignal,
): Promise<T> {
  const challenge = randomUUID();
  const health = await fetch(`${origin}/health`, {
    headers: { [GATEWAY_CHALLENGE_HEADER]: challenge },
    signal,
  });
  if (!health.ok) throw new Error(`Gateway health check failed: HTTP ${health.status}`);
  const status = await readGatewayJson<{
    service?: string;
    protocolVersion?: number;
    capabilities?: string[];
    ready?: boolean;
    proof?: string;
  }>(health);
  const compatible = status.service === "opencode-kiro-gateway"
    && status.protocolVersion === GATEWAY_PROTOCOL_VERSION
    && status.ready !== false
    && GATEWAY_CAPABILITIES.every((capability) => status.capabilities?.includes(capability))
    && verifyGatewayChallengeProof(token, challenge, status.proof);
  if (!compatible) throw new Error("Gateway identity verification failed");

  const response = await fetch(`${origin}${pathname}`, {
    headers: gatewayRequestHeaders(token, "GET", pathname),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readGatewayJson<T>(response);
}
