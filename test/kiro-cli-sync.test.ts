import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// Override only the two fs functions kiro-cli-sync uses for the SSO-cache and
// guard paths. We spread the real module so other consumers (e.g. src/debug,
// which imports appendFileSync/mkdirSync) keep working at import time.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import {
  selectKiroTokenRowForWrite,
  sameKiroCliCredential,
  importFromKiroSsoCache,
  importFromKiroCli,
  getKiroCliCredentialsAllowExpired,
  saveKiroCliCredentials,
  type AuthKvRow,
  type KiroCliCredentials,
} from "../src/kiro-cli-sync";

const mockExists = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFileSync);

/** Filenames the module derives internally from homedir(). */
const SSO_CACHE_FILE = "kiro-auth-token.json";
const DB_FILE = "data.sqlite3";

/** Build the JSON blob Kiro IDE writes to the SSO cache. */
function ssoJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    accessToken: "acc-token",
    refreshToken: "ref-token",
    region: "eu-west-1",
    authMethod: "IdC",
    ...over,
  });
}

beforeEach(() => {
  mockExists.mockReset();
  mockReadFile.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── selectKiroTokenRowForWrite (pure) ─────────────────────────────────
describe("selectKiroTokenRowForWrite", () => {
  const rows: AuthKvRow[] = [
    { key: "kirocli:odic:token", value: "{}" },
    { key: "kirocli:social:token", value: "{}" },
    { key: "kirocli:odic:device-registration", value: "{}" },
  ];

  it("returns undefined when creds.tokenKey is absent", () => {
    expect(selectKiroTokenRowForWrite(rows, { authMethod: "idc" })).toBeUndefined();
  });

  it("returns the token row whose key matches creds.tokenKey", () => {
    const row = selectKiroTokenRowForWrite(rows, {
      authMethod: "idc",
      tokenKey: "kirocli:odic:token",
    });
    expect(row).toEqual({ key: "kirocli:odic:token", value: "{}" });
  });

  it("returns undefined when no token row matches the tokenKey", () => {
    expect(
      selectKiroTokenRowForWrite(rows, { authMethod: "idc", tokenKey: "kirocli:does-not-exist" }),
    ).toBeUndefined();
  });

  it("returns undefined when the matching key is not a token row (no ':token')", () => {
    // The device-registration key exists but is filtered out by isTokenRow.
    expect(
      selectKiroTokenRowForWrite(rows, {
        authMethod: "idc",
        tokenKey: "kirocli:odic:device-registration",
      }),
    ).toBeUndefined();
  });
});

// ── sameKiroCliCredential (pure) ──────────────────────────────────────
describe("sameKiroCliCredential", () => {
  const base: KiroCliCredentials = {
    accessToken: "a",
    refreshToken: "r",
    region: "us-east-1",
    authMethod: "idc",
    source: "kiro-cli-db",
    tokenKey: "kirocli:odic:token",
  };

  it("returns false when left is null", () => {
    expect(sameKiroCliCredential(null, base)).toBe(false);
  });

  it("returns false when right is null", () => {
    expect(sameKiroCliCredential(base, null)).toBe(false);
  });

  it("returns true when all compared fields are equal", () => {
    expect(sameKiroCliCredential(base, { ...base })).toBe(true);
  });

  it("returns false when accessToken differs", () => {
    expect(sameKiroCliCredential(base, { ...base, accessToken: "different" })).toBe(false);
  });

  it("returns false when authMethod differs", () => {
    expect(sameKiroCliCredential(base, { ...base, authMethod: "desktop" })).toBe(false);
  });

  it("returns false when tokenKey differs", () => {
    expect(sameKiroCliCredential(base, { ...base, tokenKey: "kirocli:social:token" })).toBe(false);
  });
});

// ── importFromKiroSsoCache (node:fs mocked) ───────────────────────────
describe("importFromKiroSsoCache", () => {
  it("returns null when the cache file does not exist", async () => {
    mockExists.mockReturnValue(false);
    expect(await importFromKiroSsoCache()).toBeNull();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("returns null when readFileSync throws", async () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    expect(await importFromKiroSsoCache()).toBeNull();
  });

  it("returns null when the file is not valid JSON", async () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue("{ not valid json");
    expect(await importFromKiroSsoCache()).toBeNull();
  });

  it("returns null when the JSON carries no tokens", async () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue(JSON.stringify({ region: "us-east-1", authMethod: "IdC" }));
    expect(await importFromKiroSsoCache()).toBeNull();
  });

  it("returns credentials when the cache holds a valid access token", async () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue(ssoJson());
    expect(await importFromKiroSsoCache()).toEqual({
      accessToken: "acc-token",
      refreshToken: "ref-token",
      region: "eu-west-1",
      authMethod: "idc",
      source: "kiro-sso-cache",
    });
  });

  it("uses the region from the cache when present", async () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue(ssoJson({ region: "ap-southeast-1" }));
    const creds = await importFromKiroSsoCache();
    expect(creds?.region).toBe("ap-southeast-1");
  });

  it("defaults region to us-east-1 when absent", async () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue(ssoJson({ region: undefined }));
    const creds = await importFromKiroSsoCache();
    expect(creds?.region).toBe("us-east-1");
  });

  it("maps authMethod 'IdC' to 'idc'", async () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue(ssoJson({ authMethod: "IdC" }));
    const creds = await importFromKiroSsoCache();
    expect(creds?.authMethod).toBe("idc");
  });

  it("maps authMethod 'builderid' to 'desktop'", async () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue(ssoJson({ authMethod: "builderid" }));
    const creds = await importFromKiroSsoCache();
    expect(creds?.authMethod).toBe("desktop");
  });

  it("maps authMethod 'builder-id' to 'desktop'", async () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue(ssoJson({ authMethod: "builder-id" }));
    const creds = await importFromKiroSsoCache();
    expect(creds?.authMethod).toBe("desktop");
  });
});

// ── importFromKiroCli (fallback to SSO when the DB is absent) ──────────
describe("importFromKiroCli", () => {
  it("falls back to the SSO cache when the kiro-cli DB is absent", async () => {
    // DB path missing → importFromKiroDb bails before touching SQLite;
    // SSO cache present → fallback yields the SSO credentials.
    mockExists.mockImplementation((p) => String(p).includes(SSO_CACHE_FILE));
    mockReadFile.mockReturnValue(ssoJson());

    const creds = await importFromKiroCli();
    expect(creds).toEqual({
      accessToken: "acc-token",
      refreshToken: "ref-token",
      region: "eu-west-1",
      authMethod: "idc",
      source: "kiro-sso-cache",
    });
  });

  it("returns null when neither the DB nor the SSO cache exist", async () => {
    mockExists.mockReturnValue(false);
    expect(await importFromKiroCli()).toBeNull();
  });
});

// ── getKiroCliCredentialsAllowExpired (driven via the SSO fallback) ───
describe("getKiroCliCredentialsAllowExpired", () => {
  beforeEach(() => {
    // DB absent, SSO cache present with a valid token.
    mockExists.mockImplementation((p) => String(p).includes(SSO_CACHE_FILE));
    mockReadFile.mockReturnValue(ssoJson());
  });

  it("returns the imported credentials when no exclude is given", async () => {
    const creds = await getKiroCliCredentialsAllowExpired();
    expect(creds).toEqual({
      accessToken: "acc-token",
      refreshToken: "ref-token",
      region: "eu-west-1",
      authMethod: "idc",
      source: "kiro-sso-cache",
    });
  });

  it("returns null when the imported credentials equal the exclude set", async () => {
    const exclude: KiroCliCredentials = {
      accessToken: "acc-token",
      refreshToken: "ref-token",
      region: "eu-west-1",
      authMethod: "idc",
      source: "kiro-sso-cache",
      // tokenKey is undefined on both sides — sameKiroCliCredential treats that as equal.
    };
    expect(await getKiroCliCredentialsAllowExpired(exclude)).toBeNull();
  });
});

// ── saveKiroCliCredentials (guard clauses only — no real DB) ───────────
describe("saveKiroCliCredentials", () => {
  it("returns false when the credential did not originate from the kiro-cli DB", async () => {
    const creds: KiroCliCredentials = {
      accessToken: "a",
      refreshToken: "r",
      region: "us-east-1",
      authMethod: "idc",
      source: "kiro-sso-cache",
      tokenKey: "kirocli:odic:token",
    };
    expect(await saveKiroCliCredentials(creds)).toBe(false);
    // Guard returns before any filesystem access.
    expect(mockExists).not.toHaveBeenCalled();
  });

  it("returns false when the kiro-cli-db credential has no tokenKey", async () => {
    const creds: KiroCliCredentials = {
      accessToken: "a",
      refreshToken: "r",
      region: "us-east-1",
      authMethod: "idc",
      source: "kiro-cli-db",
    };
    expect(await saveKiroCliCredentials(creds)).toBe(false);
    expect(mockExists).not.toHaveBeenCalled();
  });

  it("returns false when the DB file is missing", async () => {
    mockExists.mockReturnValue(false);
    const creds: KiroCliCredentials = {
      accessToken: "a",
      refreshToken: "r",
      region: "us-east-1",
      authMethod: "idc",
      source: "kiro-cli-db",
      tokenKey: "kirocli:odic:token",
    };
    expect(await saveKiroCliCredentials(creds)).toBe(false);
    expect(mockExists).toHaveBeenCalled();
  });
});
