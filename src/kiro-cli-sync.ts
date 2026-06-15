// Kiro CLI/IDE credential sync — import tokens from local Kiro storage.
//
// Two sources, tried in order:
//   1. kiro-cli SQLite DB (preferred: has OIDC clientId/clientSecret)
//   2. Kiro IDE AWS SSO cache JSON (fallback: no OIDC creds, desktop refresh only)
//
// OpenCode runs on Bun, so bun:sqlite is always available.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { log } from "./debug";

export interface KiroCliCredentials {
  accessToken: string;
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  region: string;
  authMethod: "idc" | "desktop";
  email?: string;
  profileArn?: string;
}

// ── Paths ────────────────────────────────────────────────────────────

function getKiroDbPath(): string {
  const home = homedir();

  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3");
  }

  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(home, "AppData", "Roaming"),
      "kiro-cli",
      "data.sqlite3",
    );
  }

  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData && xdgData.length > 0) {
    return join(xdgData, "kiro-cli", "data.sqlite3");
  }
  return join(home, ".local", "share", "kiro-cli", "data.sqlite3");
}

function getKiroSsoCachePath(): string {
  const home = homedir();
  if (process.platform === "win32") {
    return join(
      process.env.USERPROFILE || home,
      ".aws", "sso", "cache", "kiro-auth-token.json",
    );
  }
  return join(home, ".aws", "sso", "cache", "kiro-auth-token.json");
}

// ── Helpers ──────────────────────────────────────────────────────────

function safeJsonParse(value: unknown): any {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findClientCreds(obj: any): { clientId?: string; clientSecret?: string } {
  if (!obj || typeof obj !== "object") return {};
  const id = obj.clientId ?? obj.client_id;
  const secret = obj.clientSecret ?? obj.client_secret;
  if (typeof id === "string" && typeof secret === "string") {
    return { clientId: id, clientSecret: secret };
  }
  for (const key of Object.keys(obj)) {
    const result = findClientCreds(obj[key]);
    if (result.clientId) return result;
  }
  return {};
}

function isIdcTokenKey(key: string): boolean {
  return key.includes("odic") || key.includes("oidc") || key.includes("idc");
}

function extractRegionFromArn(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return undefined;
  const region = parts[3];
  return region && region.length > 0 ? region : undefined;
}

// ── SQLite import (bun:sqlite) ───────────────────────────────────────

async function importFromKiroDb(): Promise<KiroCliCredentials | null> {
  const dbPath = getKiroDbPath();
  if (!existsSync(dbPath)) {
    log.debug(`Kiro CLI DB not found at ${dbPath}`);
    return null;
  }

  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });

    try {
      db.exec("PRAGMA busy_timeout = 5000");
    } catch { /* ignore */ }

    let rows: Array<{ key: string; value: string }>;
    try {
      rows = db.prepare("SELECT key, value FROM auth_kv").all() as Array<{ key: string; value: string }>;
    } catch {
      log.debug("Failed to read auth_kv table from Kiro DB");
      try { db.close(); } catch { /* ignore */ }
      return null;
    }

    // Try to read active profile ARN
    let activeProfileArn: string | undefined;
    try {
      const stateRow = db.prepare("SELECT value FROM state WHERE key = ?")
        .get("api.codewhisperer.profile") as { value?: string } | undefined;
      const parsed = safeJsonParse(stateRow?.value);
      const arn = parsed?.arn || parsed?.profileArn || parsed?.profile_arn;
      if (typeof arn === "string" && arn.trim()) {
        activeProfileArn = arn.trim();
      }
    } catch { /* state table might not exist */ }

    try { db.close(); } catch { /* ignore */ }

    // Extract device registration credentials
    const deviceRegRow = rows.find(
      (r) => typeof r?.key === "string" && r.key.includes("device-registration"),
    );
    const deviceReg = safeJsonParse(deviceRegRow?.value);
    const regCreds = deviceReg ? findClientCreds(deviceReg) : {};

    // Find token entries, prefer IdC over social/desktop
    const tokenRows = rows
      .filter((r) => r.key.includes(":token"))
      .sort((a, b) => (isIdcTokenKey(a.key) ? 0 : 1) - (isIdcTokenKey(b.key) ? 0 : 1));

    for (const row of tokenRows) {
      const data = safeJsonParse(row.value);
      if (!data) continue;

      const accessToken = data.accessToken || data.access_token;
      const refreshToken = data.refreshToken || data.refresh_token;
      if (!accessToken && !refreshToken) continue;

      const isIdc = isIdcTokenKey(row.key);
      const authMethod: "idc" | "desktop" = isIdc ? "idc" : "desktop";

      const oidcRegion = data.region || "us-east-1";
      let profileArn: string | undefined = data.profile_arn || data.profileArn;
      if (!profileArn) profileArn = activeProfileArn;
      const serviceRegion = extractRegionFromArn(profileArn) || oidcRegion;

      const result: KiroCliCredentials = {
        accessToken: accessToken || "",
        refreshToken: refreshToken || "",
        region: serviceRegion,
        authMethod,
        email: data.email || data.emailAddress,
        profileArn: profileArn,
      };

      if (isIdc && regCreds.clientId) {
        result.clientId = regCreds.clientId;
        result.clientSecret = regCreds.clientSecret;
      }

      log.info(
        `Imported Kiro CLI credentials (method=${authMethod}, region=${serviceRegion}` +
        `${result.email ? `, email=${result.email}` : ""})`,
      );
      return result;
    }

    log.debug("No valid token entries found in Kiro CLI DB");
    return null;
  } catch (err) {
    log.warn(`Failed to import from Kiro CLI: ${err}`);
    return null;
  }
}

// ── SSO cache import ─────────────────────────────────────────────────

async function importFromKiroSsoCache(): Promise<KiroCliCredentials | null> {
  const cachePath = getKiroSsoCachePath();
  if (!existsSync(cachePath)) {
    log.debug(`Kiro SSO cache not found at ${cachePath}`);
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf8");
  } catch (err) {
    log.warn(`Failed to read Kiro SSO cache at ${cachePath}: ${err}`);
    return null;
  }

  const token = safeJsonParse(raw);
  if (!token || typeof token !== "object") return null;

  const accessToken = typeof token.accessToken === "string" ? token.accessToken : "";
  const refreshToken = typeof token.refreshToken === "string" ? token.refreshToken : "";
  if (!accessToken && !refreshToken) return null;

  const region = typeof token.region === "string" && token.region.length > 0
    ? token.region : "us-east-1";

  // SSO cache doesn't have OIDC creds, must use desktop refresh
  const authMethod: "idc" | "desktop" = "desktop";

  log.info(`Imported Kiro SSO cache credentials (region=${region})`);

  return { accessToken, refreshToken, region, authMethod };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Import credentials from Kiro CLI DB first, then SSO cache fallback.
 * Returns null if neither source yields valid credentials. Never throws.
 */
export async function importFromKiroCli(): Promise<KiroCliCredentials | null> {
  const dbResult = await importFromKiroDb();
  if (dbResult) return dbResult;
  return importFromKiroSsoCache();
}
