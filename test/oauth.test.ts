import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Defensive module mocks (hoisted). Keep importing oauth.ts side-effect free:
// - ../src/models is only used by startSocialLogin; stub it so the top-level
//   import never touches the network.
// - ../src/kiro-cli-sync is dynamically imported by refreshKiroToken when a
//   credential originated from the kiro-cli DB; stub the write-back.
vi.mock("../src/models", () => ({
  resolveApiRegion: vi.fn((r: string) => r),
  fetchAvailableModels: vi.fn().mockResolvedValue([]),
  buildModelsFromApi: vi.fn(() => []),
  setCachedDynamicModels: vi.fn(),
  resolveProfileArn: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/kiro-cli-sync", () => ({
  saveKiroCliCredentials: vi.fn().mockResolvedValue(true),
}));

import {
  abortableDelay,
  tryRegisterAndAuthorize,
  pollForToken,
  refreshKiroToken,
  EXPIRES_BUFFER_MS,
  type DeviceAuthResponse,
} from "../src/oauth";
import { saveKiroCliCredentials } from "../src/kiro-cli-sync";

// ── Test helpers ────────────────────────────────────────────────────

interface MockRespOpts {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}

/** Build a minimal Response-like object for a mocked fetch. */
function mockResp(opts: MockRespOpts = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

function makeDevAuth(overrides: Partial<DeviceAuthResponse> = {}): DeviceAuthResponse {
  return {
    verificationUri: "https://device.example/verify",
    verificationUriComplete: "https://device.example/verify?code=ABCD-1234",
    userCode: "ABCD-1234",
    deviceCode: "device-code-xyz",
    interval: 1,
    expiresIn: 600,
    ...overrides,
  };
}

function spyFetch() {
  return vi.spyOn(globalThis, "fetch");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── abortableDelay ──────────────────────────────────────────────────

describe("abortableDelay", () => {
  it("resolves after the given delay", async () => {
    vi.useFakeTimers();
    const p = abortableDelay(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    await expect(abortableDelay(1000, controller.signal)).rejects.toThrow("already gone");
  });

  it("rejects when the signal aborts during the wait and clears the timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const p = abortableDelay(10_000, controller.signal);
    const expectation = expect(p).rejects.toThrow("cancelled mid-wait");
    controller.abort(new Error("cancelled mid-wait"));
    await expectation;
    // The timer was cleared on abort: no pending timers remain and advancing
    // past the original delay is a no-op.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
  });
});

// ── tryRegisterAndAuthorize ─────────────────────────────────────────

describe("tryRegisterAndAuthorize", () => {
  it("registers the client then requests device authorization (happy path)", async () => {
    const region = "eu-west-1";
    const devAuth = makeDevAuth();
    const fetchSpy = spyFetch()
      .mockResolvedValueOnce(mockResp({ json: { clientId: "cid", clientSecret: "csec" } }))
      .mockResolvedValueOnce(mockResp({ json: devAuth }));

    const result = await tryRegisterAndAuthorize("https://start.example/start", region);

    expect(result).toEqual({
      clientId: "cid",
      clientSecret: "csec",
      oidcEndpoint: `https://oidc.${region}.amazonaws.com`,
      devAuth,
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`https://oidc.${region}.amazonaws.com/client/register`);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(`https://oidc.${region}.amazonaws.com/device_authorization`);
  });

  it("returns null when client registration is not ok", async () => {
    const fetchSpy = spyFetch().mockResolvedValueOnce(mockResp({ ok: false, status: 400 }));
    const result = await tryRegisterAndAuthorize("https://start.example/start", "us-east-1");
    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null when device authorization is not ok", async () => {
    spyFetch()
      .mockResolvedValueOnce(mockResp({ json: { clientId: "cid", clientSecret: "csec" } }))
      .mockResolvedValueOnce(mockResp({ ok: false, status: 400 }));
    const result = await tryRegisterAndAuthorize("https://start.example/start", "us-east-1");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (network error is caught)", async () => {
    spyFetch().mockRejectedValue(new Error("network down"));
    const result = await tryRegisterAndAuthorize("https://start.example/start", "us-east-1");
    expect(result).toBeNull();
  });
});

// ── pollForToken ────────────────────────────────────────────────────

describe("pollForToken", () => {
  const endpoint = "https://oidc.us-east-1.amazonaws.com";

  it("returns the token response on the first successful poll", async () => {
    vi.useFakeTimers();
    spyFetch().mockResolvedValue(
      mockResp({ json: { accessToken: "AT", refreshToken: "RT", expiresIn: 3600 } }),
    );

    const p = pollForToken(endpoint, "cid", "csec", makeDevAuth(), undefined);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;

    expect(result).toEqual({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 });
  });

  it("keeps polling on authorization_pending then succeeds", async () => {
    vi.useFakeTimers();
    spyFetch()
      .mockResolvedValueOnce(mockResp({ json: { error: "authorization_pending" } }))
      .mockResolvedValueOnce(mockResp({ json: { accessToken: "AT", refreshToken: "RT" } }));

    const p = pollForToken(endpoint, "cid", "csec", makeDevAuth(), undefined);
    await vi.advanceTimersByTimeAsync(1000); // poll 1 → pending
    await vi.advanceTimersByTimeAsync(1000); // poll 2 → success
    const result = await p;

    expect(result).toMatchObject({ accessToken: "AT", refreshToken: "RT" });
  });

  it("backs off on slow_down: the poll interval actually grows before retrying", async () => {
    vi.useFakeTimers();
    // baseInterval = interval * 1000 = 1000ms.
    const fetchSpy = spyFetch()
      .mockResolvedValueOnce(mockResp({ json: { error: "slow_down" } }))
      .mockResolvedValueOnce(mockResp({ json: { accessToken: "AT", refreshToken: "RT" } }));

    const p = pollForToken(endpoint, "cid", "csec", makeDevAuth({ interval: 1 }), undefined);

    // Poll 1 fires after the base interval and returns slow_down, which bumps
    // the interval to 2000ms (baseInterval + baseInterval).
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Only 1000ms into the new 2000ms interval: the 2nd poll must NOT have
    // fired yet. If the backoff were broken (interval still 1000ms), poll 2
    // would already have been sent here — this assertion is what genuinely
    // proves the interval grew.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Completing the 2000ms interval finally fires poll 2 → success.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await expect(p).resolves.toMatchObject({ accessToken: "AT", refreshToken: "RT" });
  });

  it("retries after a 5xx response without reading the body, then succeeds", async () => {
    vi.useFakeTimers();
    const fetchSpy = spyFetch()
      .mockResolvedValueOnce(mockResp({ ok: false, status: 503 }))
      .mockResolvedValueOnce(mockResp({ json: { accessToken: "AT", refreshToken: "RT" } }));

    const p = pollForToken(endpoint, "cid", "csec", makeDevAuth({ interval: 1 }), undefined);
    await vi.advanceTimersByTimeAsync(1000); // poll 1 → 503 → continue (interval unchanged)
    await vi.advanceTimersByTimeAsync(1000); // poll 2 → success
    const result = await p;

    expect(result).toMatchObject({ accessToken: "AT", refreshToken: "RT" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects with 'Authorization failed: HTTP <status>' when a non-ok response is unparseable", async () => {
    vi.useFakeTimers();
    spyFetch().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => {
        throw new Error("bad json");
      },
      text: async () => "",
    } as unknown as Response);

    const p = pollForToken(endpoint, "cid", "csec", makeDevAuth({ interval: 1 }), undefined);
    const expectation = expect(p).rejects.toThrow("Authorization failed: HTTP 400");
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  it("throws on a non-recoverable error code", async () => {
    vi.useFakeTimers();
    spyFetch().mockResolvedValue(mockResp({ json: { error: "access_denied" } }));

    const p = pollForToken(endpoint, "cid", "csec", makeDevAuth(), undefined);
    const expectation = expect(p).rejects.toThrow("Authorization failed: access_denied");
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  it("throws 'Login cancelled' when the signal is already aborted at loop entry", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    await expect(
      pollForToken(endpoint, "cid", "csec", makeDevAuth(), controller.signal),
    ).rejects.toThrow("Login cancelled");
  });

  it("throws 'Authorization timed out' once the deadline passes", async () => {
    vi.useFakeTimers();
    // Always pending so the loop only ever exits via the deadline check.
    spyFetch().mockResolvedValue(mockResp({ json: { error: "authorization_pending" } }));

    const p = pollForToken(
      endpoint,
      "cid",
      "csec",
      makeDevAuth({ interval: 1, expiresIn: 1 }),
      undefined,
    );
    const expectation = expect(p).rejects.toThrow("Authorization timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });
});

// ── refreshKiroToken ────────────────────────────────────────────────

describe("refreshKiroToken", () => {
  beforeEach(() => {
    vi.mocked(saveKiroCliCredentials).mockClear();
    vi.mocked(saveKiroCliCredentials).mockResolvedValue(true);
  });

  it("throws when the refresh token is missing", async () => {
    await expect(refreshKiroToken("", "us-east-1", "idc")).rejects.toThrow(
      "Refresh token or region is missing — re-login required",
    );
  });

  it("throws when the region is missing", async () => {
    await expect(refreshKiroToken("rt|cid|csec|idc|src|key", "", "idc")).rejects.toThrow(
      "Refresh token or region is missing — re-login required",
    );
  });

  describe("desktop/social branch", () => {
    it("refreshes via the desktop endpoint and repacks the refresh token", async () => {
      const region = "us-east-1";
      const fetchSpy = spyFetch().mockResolvedValue(
        mockResp({ json: { accessToken: "newAT", refreshToken: "newRT", expiresIn: 3600 } }),
      );

      const before = Date.now();
      const result = await refreshKiroToken("rt|||desktop|other|key", region, "desktop");
      const after = Date.now();

      expect(fetchSpy).toHaveBeenCalledWith(
        `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(result.access).toBe("newAT");
      expect(result.refresh).toBe("newRT|||desktop|other|key");
      expect(result.expires).toBeGreaterThanOrEqual(before + 3600 * 1000 - EXPIRES_BUFFER_MS);
      expect(result.expires).toBeLessThanOrEqual(after + 3600 * 1000 - EXPIRES_BUFFER_MS);
      expect(saveKiroCliCredentials).not.toHaveBeenCalled();
    });

    it("writes back to the kiro-cli DB when the credential came from it", async () => {
      spyFetch().mockResolvedValue(
        mockResp({ json: { accessToken: "newAT", refreshToken: "newRT", expiresIn: 3600 } }),
      );

      const result = await refreshKiroToken("rt|||desktop|kiro-cli-db|tok123", "us-east-1", "desktop");

      expect(result.refresh).toBe("newRT|||desktop|kiro-cli-db|tok123");
      expect(saveKiroCliCredentials).toHaveBeenCalledTimes(1);
      expect(saveKiroCliCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "newAT",
          refreshToken: "newRT",
          source: "kiro-cli-db",
          tokenKey: "tok123",
          authMethod: "desktop",
        }),
      );
    });

    it("throws with status and body when the desktop refresh is not ok", async () => {
      spyFetch().mockResolvedValue(mockResp({ ok: false, status: 403, text: "denied" }));
      await expect(refreshKiroToken("rt|||desktop|src|key", "us-east-1", "desktop")).rejects.toThrow(
        "Desktop token refresh failed: 403 denied",
      );
    });
  });

  describe("idc/oidc branch", () => {
    it("throws when clientId/clientSecret are missing", async () => {
      await expect(refreshKiroToken("rt|||idc|src|key", "us-east-1", "idc")).rejects.toThrow(
        "OIDC clientId or clientSecret missing — re-login required",
      );
    });

    it("refreshes via the OIDC endpoint and repacks with client creds", async () => {
      const region = "us-east-1";
      const fetchSpy = spyFetch().mockResolvedValue(
        mockResp({ json: { accessToken: "newAT", refreshToken: "newRT", expiresIn: 3600 } }),
      );

      const result = await refreshKiroToken("rt|cid|csec|idc|src|key", region, "idc");

      expect(fetchSpy).toHaveBeenCalledWith(
        `https://oidc.${region}.amazonaws.com/token`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(result.access).toBe("newAT");
      expect(result.refresh).toBe("newRT|cid|csec|idc|src|key");
      expect(saveKiroCliCredentials).not.toHaveBeenCalled();
    });

    it("writes back to the kiro-cli DB when the credential came from it", async () => {
      spyFetch().mockResolvedValue(
        mockResp({ json: { accessToken: "newAT", refreshToken: "newRT", expiresIn: 3600 } }),
      );

      await refreshKiroToken("rt|cid|csec|idc|kiro-cli-db|tok9", "us-east-1", "idc");

      expect(saveKiroCliCredentials).toHaveBeenCalledTimes(1);
      expect(saveKiroCliCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "newAT",
          refreshToken: "newRT",
          clientId: "cid",
          clientSecret: "csec",
          source: "kiro-cli-db",
          tokenKey: "tok9",
        }),
      );
    });

    it("throws with status and body when the OIDC refresh is not ok", async () => {
      spyFetch().mockResolvedValue(mockResp({ ok: false, status: 401, text: "bad" }));
      await expect(refreshKiroToken("rt|cid|csec|idc|src|key", "us-east-1", "idc")).rejects.toThrow(
        "Token refresh failed: 401 bad",
      );
    });
  });
});
