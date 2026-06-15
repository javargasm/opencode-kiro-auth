// Kiro OAuth — AWS Builder ID and IAM Identity Center (IdC).
//
// Both methods use the same AWS SSO-OIDC device-code flow and the same
// refresh endpoint.

import { log } from "./debug";
import { resolveApiRegion, fetchAvailableModels, buildModelsFromApi } from "./models";

export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const BUILDER_ID_REGION = "us-east-1";
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

/** Regions probed when an IdC user leaves the region blank. */
export const IDC_PROBE_REGIONS = [
  "us-east-1",
  "eu-west-1",
  "eu-central-1",
  "us-east-2",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "ap-southeast-1",
  "ap-northeast-1",
  "us-west-2",
];

/** 5-minute safety buffer subtracted from real token expiry. */
export const EXPIRES_BUFFER_MS = 5 * 60 * 1000;

export interface KiroCredentials {
  refresh: string;
  access: string;
  expires: number;
  clientId: string;
  clientSecret: string;
  region: string;
  authMethod: "builder-id" | "idc" | "desktop";
}

export interface DeviceAuthResponse {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

interface ClientRegisterResponse {
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  error?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}

/** Promise-based delay that rejects promptly if the signal fires. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Login cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

export async function tryRegisterAndAuthorize(
  startUrl: string,
  region: string,
): Promise<{
  clientId: string;
  clientSecret: string;
  oidcEndpoint: string;
  devAuth: DeviceAuthResponse;
} | null> {
  const oidcEndpoint = `https://oidc.${region}.amazonaws.com`;

  try {
    const regResp = await fetch(`${oidcEndpoint}/client/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "opencode-kiro" },
      body: JSON.stringify({
        clientName: "opencode-kiro",
        clientType: "public",
        scopes: SSO_SCOPES,
        grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      }),
    });
    if (!regResp.ok) return null;
    const { clientId, clientSecret } = (await regResp.json()) as ClientRegisterResponse;

    const devResp = await fetch(`${oidcEndpoint}/device_authorization`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "opencode-kiro" },
      body: JSON.stringify({ clientId, clientSecret, startUrl }),
    });
    if (!devResp.ok) return null;

    return {
      clientId,
      clientSecret,
      oidcEndpoint,
      devAuth: (await devResp.json()) as DeviceAuthResponse,
    };
  } catch (e) {
    log.error(`tryRegisterAndAuthorize failed in region ${region}: ${e}`);
    return null;
  }
}

export async function pollForToken(
  oidcEndpoint: string,
  clientId: string,
  clientSecret: string,
  devAuth: DeviceAuthResponse,
  signal: AbortSignal | undefined,
): Promise<TokenResponse> {
  const deadline = Date.now() + (devAuth.expiresIn || 600) * 1000;
  const baseInterval = (devAuth.interval || 5) * 1000;
  let interval = baseInterval;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    await abortableDelay(interval, signal);

    let resp: Response;
    try {
      resp = await fetch(`${oidcEndpoint}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "opencode-kiro" },
        body: JSON.stringify({
          clientId,
          clientSecret,
          deviceCode: devAuth.deviceCode,
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
    } catch {
      continue;
    }

    if (resp.status >= 500) continue;

    let data: TokenResponse;
    try {
      data = (await resp.json()) as TokenResponse;
    } catch {
      if (!resp.ok) {
        throw new Error(`Authorization failed: HTTP ${resp.status}`);
      }
      continue;
    }

    if (!data.error && data.accessToken && data.refreshToken) return data;
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      interval += baseInterval;
      continue;
    }
    if (data.error) throw new Error(`Authorization failed: ${data.error}`);
  }
  throw new Error("Authorization timed out");
}

export async function refreshKiroToken(
  refreshTokenPacked: string,
  region: string,
  authMethod: "builder-id" | "idc" | "desktop"
): Promise<{ access: string; refresh: string; expires: number }> {
  const parts = refreshTokenPacked.split("|");
  const refreshToken = parts[0] ?? "";
  const clientId = parts[1] ?? "";
  const clientSecret = parts[2] ?? "";

  if (!refreshToken || !region) {
    throw new Error("Refresh token or region is missing — re-login required");
  }

  if (authMethod === "desktop") {
    const desktopEndpoint = `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
    const resp = await fetch(desktopEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "opencode-kiro" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Desktop token refresh failed: ${resp.status} ${body}`);
    }

    const data = (await resp.json()) as {
      accessToken: string;
      refreshToken: string;
      expiresIn?: number;
    };

    return {
      access: data.accessToken,
      refresh: `${data.refreshToken}|||desktop`,
      expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
    };
  }

  if (!clientId || !clientSecret) {
    throw new Error("OIDC clientId or clientSecret missing — re-login required");
  }

  const endpoint = `https://oidc.${region}.amazonaws.com/token`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "opencode-kiro" },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Token refresh failed: ${resp.status} ${body}`);
  }

  const data = (await resp.json()) as {
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
  };

  return {
    access: data.accessToken,
    refresh: `${data.refreshToken}|${clientId}|${clientSecret}|${authMethod}`,
    expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
  };
}
