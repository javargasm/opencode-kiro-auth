import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _loadGatewayTokenForTest, _repairGatewayTokenForTest } from "../src/index";
import { readGatewayToken } from "../src/tui-gateway";

let directory: string | undefined;
const originalGatewayToken = process.env.KIRO_GATEWAY_TOKEN;
const originalCacheHome = process.env.XDG_CACHE_HOME;

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalGatewayToken === undefined) delete process.env.KIRO_GATEWAY_TOKEN;
  else process.env.KIRO_GATEWAY_TOKEN = originalGatewayToken;
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("gateway token repair", () => {
  it("rejects weak explicit plugin overrides and makes the TUI fail closed", async () => {
    directory = await mkdtemp(join(tmpdir(), "opencode-kiro-token-"));
    process.env.XDG_CACHE_HOME = directory;
    process.env.KIRO_GATEWAY_TOKEN = "too-short";

    await expect(_loadGatewayTokenForTest()).rejects.toThrow("at least 32 characters");
    expect(readGatewayToken()).toBeNull();
  });

  it("accepts a 32-character explicit override in both readers", async () => {
    const token = "x".repeat(32);
    process.env.KIRO_GATEWAY_TOKEN = `  ${token}  `;
    await expect(_loadGatewayTokenForTest()).resolves.toBe(token);
    expect(readGatewayToken()).toBe(token);
  });

  it("rejects a short token loaded from the cache file", async () => {
    directory = await mkdtemp(join(tmpdir(), "opencode-kiro-token-"));
    process.env.XDG_CACHE_HOME = directory;
    delete process.env.KIRO_GATEWAY_TOKEN;
    const tokenDirectory = join(directory, "opencode-kiro");
    await mkdir(tokenDirectory);
    await writeFile(join(tokenDirectory, "gateway-token"), "short-cache-token");

    expect(readGatewayToken()).toBeNull();
  });

  it("reclaims a dead owner's lock and completes token repair", async () => {
    directory = await mkdtemp(join(tmpdir(), "opencode-kiro-lock-"));
    const tokenPath = join(directory, "gateway-token");
    const lockPath = `${tokenPath}.repair.lock`;
    const deadPid = 424242;
    await writeFile(tokenPath, "partial");
    await writeFile(lockPath, String(deadPid), { mode: 0o600 });

    vi.spyOn(process, "kill").mockImplementation((() => {
      const error = new Error("process not found") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    }) as typeof process.kill);

    const token = await _repairGatewayTokenForTest(tokenPath);

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(tokenPath, "utf8")).toBe(token);
    expect((await readdir(directory)).sort()).toEqual(["gateway-token"]);
  });
});
