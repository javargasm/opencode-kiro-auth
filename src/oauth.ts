// Kiro OAuth — AWS Builder ID and IAM Identity Center (IdC).
//
// Three login methods:
//   1. Builder ID (personal) — social sign-in via https://app.kiro.dev/signin
//      with PKCE (S256). Starts a localhost callback server on port 49153,
//      exchanges the authorization code for tokens via the desktop auth endpoint.
//   2. IdC (enterprise) — AWS SSO-OIDC device-code flow.
//   3. Desktop — manual refresh token import from Kiro IDE.

import { log } from "./debug";
import { resolveApiRegion, fetchAvailableModels, buildModelsFromApi, setCachedDynamicModels } from "./models";
import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";

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
  authMethod: "builder-id" | "idc" | "desktop" | "social";
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
  authMethod: "builder-id" | "idc" | "desktop" | "social"
): Promise<{ access: string; refresh: string; expires: number }> {
  const parts = refreshTokenPacked.split("|");
  const refreshToken = parts[0] ?? "";
  const clientId = parts[1] ?? "";
  const clientSecret = parts[2] ?? "";
  // parts[3] is the authMethod (matching the third arg)
  const source = parts[4] ?? "";
  const tokenKey = parts[5] ?? "";

  if (!refreshToken || !region) {
    throw new Error("Refresh token or region is missing — re-login required");
  }

  if (authMethod === "desktop" || authMethod === "social") {
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

    const newPacked = `${data.refreshToken}|||${authMethod}|${source}|${tokenKey}`;

    if (source === "kiro-cli-db" && tokenKey) {
      const { saveKiroCliCredentials } = await import("./kiro-cli-sync");
      await saveKiroCliCredentials({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        clientId: "",
        clientSecret: "",
        region,
        authMethod,
        source: "kiro-cli-db",
        tokenKey,
      });
    }

    return {
      access: data.accessToken,
      refresh: newPacked,
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

  const newPacked = `${data.refreshToken}|${clientId}|${clientSecret}|${authMethod}|${source}|${tokenKey}`;

  if (source === "kiro-cli-db" && tokenKey) {
    const { saveKiroCliCredentials } = await import("./kiro-cli-sync");
    await saveKiroCliCredentials({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      clientId,
      clientSecret,
      region,
      authMethod: authMethod as "idc",
      source: "kiro-cli-db",
      tokenKey,
    });
  }

  return {
    access: data.accessToken,
    refresh: newPacked,
    expires: Date.now() + (data.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
  };
}

// ── Social sign-in (PKCE + authorization code) ──────────────────────
//
// Used for Builder ID (personal AWS account). Matches the Kiro CLI flow:
// opens https://app.kiro.dev/signin with a PKCE challenge, listens on a
// localhost port for the OAuth redirect, then exchanges the authorization
// code for tokens via the desktop auth endpoint.
//
// Key advantage over the device-code flow: the token exchange returns
// profileArn immediately, eliminating the post-login resolution step.

const KIRO_SOCIAL_PORTAL = "https://app.kiro.dev";
const KIRO_SOCIAL_AUTH_ENDPOINT = `https://prod.${BUILDER_ID_REGION}.auth.desktop.kiro.dev`;
const SOCIAL_REDIRECT_PORT = 49153;
const SOCIAL_REDIRECT_URI = `http://localhost:${SOCIAL_REDIRECT_PORT}`;

function generateRandomState(): string {
  return randomBytes(16).toString("base64url");
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function buildSocialSignInURL(
  redirectUri: string,
  codeChallenge: string,
  state: string,
): string {
  const params = new URLSearchParams();
  params.set("code_challenge", codeChallenge);
  params.set("code_challenge_method", "S256");
  params.set("redirect_from", "kirocli");
  params.set("redirect_uri", redirectUri);
  params.set("state", state);
  return `${KIRO_SOCIAL_PORTAL}/signin?${params.toString()}`;
}

/**
 * Reconstruct the redirect_uri for the token exchange.
 * Kiro redirects the browser to {baseURI}/oauth/callback?login_option=...
 * and the token endpoint expects this exact URI back.
 */
function buildTokenRedirectUri(callbackPath: string, loginOption: string | null): string {
  const path = callbackPath || "/oauth/callback";
  const base = `${SOCIAL_REDIRECT_URI}${path}`;
  if (loginOption) {
    return `${base}?login_option=${encodeURIComponent(loginOption)}`;
  }
  return base;
}

/**
 * Render a styled OAuth callback page (success or error).
 * Dark theme with the Kiro ghost logo and OPENCODE-KIRO branding.
 * Success pages show a 3→2→1 countdown then redirect to app.kiro.dev.
 */
function oauthCallbackPage(
  kind: "success" | "error",
  title: string,
  message: string,
  redirectUrl = "https://app.kiro.dev",
): string {
  const borderColor = kind === "success" ? "#22c55e" : "#ef4444";
  const iconSvg =
    kind === "success"
      ? `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M16.67 5L7.5 14.17 3.33 10" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5l10 10" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>`;

  // Kiro ghost SVG (simplified, white fill)
  const ghostSvg = `<svg width="56" height="56" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M50 5C28.5 5 11 22.5 11 44v36c0 2.8 1.2 5.4 3.2 7.2 2 1.8 4.7 2.6 7.4 2.2l3.4-.5c3.2-.5 6.5.4 9 2.5l2.2 1.8c2.4 2 5.4 3 8.5 3h10.6c3.1 0 6.1-1.1 8.5-3l2.2-1.8c2.5-2.1 5.8-3 9-2.5l3.4.5c2.7.4 5.4-.4 7.4-2.2 2-1.8 3.2-4.4 3.2-7.2V44C89 22.5 71.5 5 50 5z" fill="white"/>
    <circle cx="37" cy="45" r="7" fill="#0a0a0a"/>
    <circle cx="63" cy="45" r="7" fill="#0a0a0a"/>
  </svg>`;

  const redirectHost = (() => {
    try { return new URL(redirectUrl).hostname; } catch { return redirectUrl; }
  })();

  const countdownHtml =
    kind === "success"
      ? `
    <div class="countdown" id="countdown">
      <svg class="ring" viewBox="0 0 60 60">
        <circle cx="30" cy="30" r="26" stroke="#1a1a1a" stroke-width="3" fill="none"/>
        <circle id="ring-progress" cx="30" cy="30" r="26" stroke="#22c55e" stroke-width="3" fill="none"
          stroke-dasharray="163.36" stroke-dashoffset="0" stroke-linecap="round"
          transform="rotate(-90 30 30)" style="transition:stroke-dashoffset 1s linear"/>
      </svg>
      <span class="countdown-num" id="countdown-num">3</span>
    </div>
    <p class="subtitle">Redirecting to <strong>${redirectHost}</strong>…</p>
    <script>
      (function(){
        var n=3, el=document.getElementById('countdown-num'),
            ring=document.getElementById('ring-progress'), circ=163.36;
        function tick(){
          if(n<=0){window.location.href=${JSON.stringify(redirectUrl)};return}
          el.textContent=n;
          ring.setAttribute('stroke-dashoffset', String(circ*(1-n/3)));
          n--;
          setTimeout(tick,1000);
        }
        tick();
      })();
    </script>`
      : `<p class="subtitle">Please close this window and try again</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OPENCODE-KIRO — Authentication</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0a0a;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
    .container{max-width:420px;padding:2rem}
    .logo{display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:48px}
    .logo-text{font-size:32px;font-weight:700;letter-spacing:4px;color:#7c3aed;font-family:'Courier New',monospace}
    .status-box{border:1.5px solid ${borderColor};border-radius:12px;padding:20px 28px;display:flex;align-items:flex-start;gap:14px;text-align:left;margin-bottom:20px;background:rgba(${kind === "success" ? "34,197,94" : "239,68,68"},0.04)}
    .status-icon{flex-shrink:0;margin-top:2px}
    .status-title{font-size:15px;font-weight:600;color:${borderColor};margin-bottom:4px}
    .status-msg{font-size:13px;color:#a3a3a3;line-height:1.4}
    .subtitle{font-size:13px;color:#737373;margin-top:4px}
    .subtitle strong{color:#a3a3a3}
    .countdown{position:relative;width:60px;height:60px;margin:24px auto 12px}
    .ring{width:60px;height:60px}
    .countdown-num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#22c55e;font-variant-numeric:tabular-nums}
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      ${ghostSvg}
      <span class="logo-text">OPENCODE-KIRO</span>
    </div>
    <div class="status-box">
      <span class="status-icon">${iconSvg}</span>
      <div>
        <div class="status-title">${title}</div>
        <div class="status-msg">${message}</div>
      </div>
    </div>
    ${countdownHtml}
  </div>
</body>
</html>`;
}

/** Result from the localhost callback server. */
interface SocialCallbackResult {
  /** Authorization code (null for IdC delegation). */
  code: string | null;
  state: string;
  callbackPath: string;
  loginOption: string | null;
  /** IdC delegation: the issuer/start URL from Kiro portal. */
  issuerUrl?: string;
  /** IdC delegation: the IdC region from Kiro portal. */
  idcRegion?: string;
}

interface SocialTokenResponse {
  accessToken: string;
  refreshToken: string;
  profileArn?: string;
  expiresIn?: number;
}

/**
 * Enterprise IdC delegation page: polls /idc-verify until the device
 * verification URL is ready, then does a 3→2→1 countdown and redirects.
 */
function oauthIdcDelegationPage(): string {
  const ghostSvg = `<svg width="56" height="56" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M50 5C28.5 5 11 22.5 11 44v36c0 2.8 1.2 5.4 3.2 7.2 2 1.8 4.7 2.6 7.4 2.2l3.4-.5c3.2-.5 6.5.4 9 2.5l2.2 1.8c2.4 2 5.4 3 8.5 3h10.6c3.1 0 6.1-1.1 8.5-3l2.2-1.8c2.5-2.1 5.8-3 9-2.5l3.4.5c2.7.4 5.4-.4 7.4-2.2 2-1.8 3.2-4.4 3.2-7.2V44C89 22.5 71.5 5 50 5z" fill="white"/>
    <circle cx="37" cy="45" r="7" fill="#0a0a0a"/>
    <circle cx="63" cy="45" r="7" fill="#0a0a0a"/>
  </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OPENCODE-KIRO — Enterprise Sign-In</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0a0a;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
    .container{max-width:420px;padding:2rem}
    .logo{display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:48px}
    .logo-text{font-size:32px;font-weight:700;letter-spacing:4px;color:#7c3aed;font-family:'Courier New',monospace}
    .status-box{border:1.5px solid #22c55e;border-radius:12px;padding:20px 28px;display:flex;align-items:flex-start;gap:14px;text-align:left;margin-bottom:20px;background:rgba(34,197,94,0.04)}
    .status-icon{flex-shrink:0;margin-top:2px}
    .status-title{font-size:15px;font-weight:600;color:#22c55e;margin-bottom:4px}
    .status-msg{font-size:13px;color:#a3a3a3;line-height:1.4}
    .subtitle{font-size:13px;color:#737373;margin-top:4px}
    .subtitle strong{color:#a3a3a3}
    .spinner{width:28px;height:28px;border:3px solid #1a1a1a;border-top-color:#22c55e;border-radius:50%;animation:spin 0.8s linear infinite;margin:24px auto 12px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .countdown{position:relative;width:60px;height:60px;margin:24px auto 12px;display:none}
    .ring{width:60px;height:60px}
    .countdown-num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#22c55e;font-variant-numeric:tabular-nums}
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      ${ghostSvg}
      <span class="logo-text">OPENCODE-KIRO</span>
    </div>
    <div class="status-box">
      <span class="status-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M16.67 5L7.5 14.17 3.33 10" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <div>
        <div class="status-title">Enterprise sign-in</div>
        <div class="status-msg" id="status-msg">Preparing device authorization…</div>
      </div>
    </div>
    <div class="spinner" id="spinner"></div>
    <div class="countdown" id="countdown">
      <svg class="ring" viewBox="0 0 60 60">
        <circle cx="30" cy="30" r="26" stroke="#1a1a1a" stroke-width="3" fill="none"/>
        <circle id="ring-progress" cx="30" cy="30" r="26" stroke="#22c55e" stroke-width="3" fill="none"
          stroke-dasharray="163.36" stroke-dashoffset="0" stroke-linecap="round"
          transform="rotate(-90 30 30)" style="transition:stroke-dashoffset 1s linear"/>
      </svg>
      <span class="countdown-num" id="countdown-num">3</span>
    </div>
    <p class="subtitle" id="subtitle">Waiting for device authorization…</p>
    <script>
      (function(){
        var msg=document.getElementById('status-msg'),
            spinner=document.getElementById('spinner'),
            cd=document.getElementById('countdown'),
            cdNum=document.getElementById('countdown-num'),
            ring=document.getElementById('ring-progress'),
            sub=document.getElementById('subtitle'),
            circ=163.36;

        function poll(){
          fetch('/idc-verify').then(function(r){return r.json()}).then(function(d){
            if(d.url){
              spinner.style.display='none';
              cd.style.display='block';
              msg.textContent='Device authorization ready';
              try{sub.innerHTML='Redirecting to <strong>'+new URL(d.url).hostname+'</strong>…'}catch(e){}
              countdown(3,d.url);
            } else {
              setTimeout(poll,500);
            }
          }).catch(function(){setTimeout(poll,1000)});
        }

        function countdown(n,url){
          if(n<=0){window.location.href=url;return}
          cdNum.textContent=n;
          ring.setAttribute('stroke-dashoffset',String(circ*(1-n/3)));
          setTimeout(function(){countdown(n-1,url)},1000);
        }

        poll();
      })();
    </script>
  </div>
</body>
</html>`;
}

/**
 * Start the localhost OAuth callback server on port 49153.
 * Returns the server, a redirect URI, and a promise that resolves when the
 * authorization callback is received.
 *
 * Handles two callback shapes:
 * - Social: `?code=...&state=...` → normal PKCE token exchange
 * - IdC delegation: `?login_option=awsidc&issuer_url=...&state=...` →
 *   serves the IdC delegation page (polls /idc-verify) and triggers
 *   device-code flow
 */
function startCallbackServer(
  expectedState: string,
): Promise<{
  server: HttpServer;
  redirectUri: string;
  waitForCode: () => Promise<SocialCallbackResult | null>;
  cancelWait: () => void;
  setIdcVerifyUrl: (url: string) => void;
}> {
  return new Promise((resolve, reject) => {
    let settleWait: ((result: SocialCallbackResult | null) => void) | undefined;
    const waitForCodePromise = new Promise<SocialCallbackResult | null>((res) => {
      settleWait = res;
    });

    let idcVerifyUrl: string | null = null;

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "", SOCIAL_REDIRECT_URI);

        // /idc-verify endpoint: returns the device verification URL when ready.
        if (url.pathname === "/idc-verify") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({ url: idcVerifyUrl }));
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const loginOption = url.searchParams.get("login_option");
        const issuerUrl = url.searchParams.get("issuer_url");
        const idcRegion = url.searchParams.get("idc_region");

        // IdC delegation: login_option=awsidc + issuer_url + state (no code)
        const isIdcDelegation = loginOption === "awsidc" && !!issuerUrl && !!state;

        if (!state || (!code && !isIdcDelegation)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("");
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthCallbackPage("error", "State mismatch", "The OAuth state parameter did not match. Please try logging in again."));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (isIdcDelegation) {
          res.end(oauthIdcDelegationPage());
        } else {
          res.end(oauthCallbackPage("success", "Request approved", "OPENCODE-KIRO has been given requested permissions."));
        }
        settleWait?.({
          code,
          state,
          callbackPath: url.pathname,
          loginOption,
          issuerUrl: issuerUrl ?? undefined,
          idcRegion: idcRegion ?? undefined,
        });
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal error");
      }
    });

    server.on("error", (err) => {
      reject(err);
    });

    server.listen(SOCIAL_REDIRECT_PORT, "localhost", () => {
      resolve({
        server,
        redirectUri: SOCIAL_REDIRECT_URI,
        cancelWait: () => { settleWait?.(null); },
        waitForCode: () => waitForCodePromise,
        setIdcVerifyUrl: (url: string) => { idcVerifyUrl = url; },
      });
    });
  });
}

/**
 * Run the full social (Builder ID) sign-in flow.
 *
 * 1. Generate PKCE verifier + challenge.
 * 2. Start localhost callback server on port 49153.
 * 3. Return the sign-in URL for the caller to redirect the browser to.
 * 4. Wait for the OAuth callback with the authorization code.
 * 5. Exchange the code for tokens via Kiro's desktop auth endpoint.
 * 6. Fetch and cache dynamic models if profileArn is returned.
 *
 * If Kiro portal detects an enterprise (IdC) account, it redirects with
 * `login_option=awsidc` instead of a code. In that case, the callback
 * server shows the IdC delegation page and the flow transparently
 * switches to a device-code flow for IdC.
 *
 * Returns the sign-in URL immediately and a promise that resolves with the
 * credentials once the flow completes (regardless of social or IdC path).
 */
export async function startSocialLogin(): Promise<{
  signInUrl: string;
  waitForCredentials: () => Promise<{
    accessToken: string;
    refreshToken: string;
    refreshPacked: string;
    profileArn?: string;
    region: string;
    authMethod: "social" | "idc";
    expiresAt: number;
  }>;
}> {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateRandomState();

  const callbackServer = await startCallbackServer(state);
  const signInUrl = buildSocialSignInURL(callbackServer.redirectUri, challenge, state);

  const waitForCredentials = async () => {
    try {
      const result = await callbackServer.waitForCode();

      // ── IdC delegation ──────────────────────────────────────────
      // Kiro portal redirected with issuer_url + idc_region instead
      // of an authorization code. Start the device-code flow for IdC
      // and pipe the verification URL to the browser tab via /idc-verify.
      if (result?.loginOption === "awsidc" && result.issuerUrl) {
        log.info("[social-login] Enterprise IdC delegation detected");
        const idcRegion = result.idcRegion || BUILDER_ID_REGION;
        const regions = [idcRegion];

        let regResult: Awaited<ReturnType<typeof tryRegisterAndAuthorize>> | null = null;
        let detectedRegion = "";
        for (const region of regions) {
          regResult = await tryRegisterAndAuthorize(result.issuerUrl, region);
          if (regResult) {
            detectedRegion = region;
            break;
          }
        }

        if (!regResult || !detectedRegion) {
          throw new Error(
            `Could not authorize ${result.issuerUrl} in ${regions.join(", ")}. ` +
            "Check your start URL and region and try again.",
          );
        }

        // Pipe the verification URL to the browser tab via /idc-verify
        callbackServer.setIdcVerifyUrl(regResult.devAuth.verificationUriComplete);
        log.info(`[social-login] IdC device auth ready, verification URL sent to browser`);

        const tok = await pollForToken(
          regResult.oidcEndpoint,
          regResult.clientId,
          regResult.clientSecret,
          regResult.devAuth,
          undefined,
        );

        if (!tok.accessToken || !tok.refreshToken) {
          throw new Error("IdC authorization completed but no tokens returned");
        }

        // Resolve profileArn for IdC
        let profileArn: string | undefined;
        try {
          const apiRegion = resolveApiRegion(detectedRegion);
          const { resolveProfileArn } = await import("./models");
          const resolved = await resolveProfileArn(tok.accessToken, apiRegion);
          if (resolved) {
            profileArn = resolved;
            try {
              const apiModels = await fetchAvailableModels(tok.accessToken, apiRegion, profileArn);
              setCachedDynamicModels(buildModelsFromApi(apiModels));
              log.info(`[social-login] IdC: fetched and cached ${apiModels.length} models`);
            } catch (err) {
              log.warn(`[social-login] IdC: failed to fetch models: ${err}`);
            }
          }
        } catch (err) {
          log.warn(`[social-login] IdC: failed to resolve profileArn: ${err}`);
        }

        return {
          accessToken: tok.accessToken,
          refreshToken: tok.refreshToken,
          refreshPacked: `${tok.refreshToken}|${regResult.clientId}|${regResult.clientSecret}|idc`,
          profileArn,
          region: detectedRegion,
          authMethod: "idc" as const,
          expiresAt: Date.now() + (tok.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
        };
      }

      // ── Normal social sign-in ───────────────────────────────────
      if (!result?.code) {
        throw new Error("Missing authorization code — sign-in was not completed");
      }

      const tokenRedirectUri = buildTokenRedirectUri(result.callbackPath, result.loginOption);

      log.info("[social-login] Exchanging authorization code…");

      const resp = await fetch(`${KIRO_SOCIAL_AUTH_ENDPOINT}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "opencode-kiro" },
        body: JSON.stringify({
          code: result.code,
          code_verifier: verifier,
          redirect_uri: tokenRedirectUri,
        }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Token exchange failed: ${resp.status} ${body}`);
      }

      const data = (await resp.json()) as SocialTokenResponse;

      if (!data.accessToken || !data.refreshToken) {
        throw new Error("Token exchange returned no tokens");
      }

      // Social flow returns profileArn — fetch and cache models immediately.
      if (data.profileArn) {
        try {
          const apiRegion = resolveApiRegion(BUILDER_ID_REGION);
          const apiModels = await fetchAvailableModels(data.accessToken, apiRegion, data.profileArn);
          setCachedDynamicModels(buildModelsFromApi(apiModels));
          log.info(`[social-login] Fetched and cached ${apiModels.length} models`);
        } catch (err) {
          log.warn(`[social-login] Failed to fetch models: ${err}`);
        }
      }

      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        refreshPacked: `${data.refreshToken}|||social`,
        profileArn: data.profileArn,
        region: BUILDER_ID_REGION,
        authMethod: "social" as const,
        expiresAt: Date.now() + (data.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
      };
    } finally {
      callbackServer.server.close();
    }
  };

  return { signInUrl, waitForCredentials };
}

