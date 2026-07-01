import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModelsFromApi,
  fetchAvailableModels,
  formatModelName,
  resetProfileArnCache,
  resolveProfileArn,
} from "../src/models";

interface MockRespOpts {
  ok?: boolean;
  status?: number;
  json?: unknown;
}

function mockResp(opts: MockRespOpts = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json ?? {},
  } as unknown as Response;
}

function spyFetch() {
  return vi.spyOn(globalThis, "fetch");
}

afterEach(() => {
  resetProfileArnCache();
  vi.restoreAllMocks();
});

describe("Kiro model catalog", () => {
  it("keeps API rate multipliers and formats model names for display", () => {
    const [model] = buildModelsFromApi([
      {
        modelId: "claude-sonnet-5",
        modelName: "claude-sonnet-5",
        rateMultiplier: 1.3,
        supportedInputTypes: ["TEXT", "IMAGE"],
        tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
      },
    ]);

    expect(model).toMatchObject({
      id: "claude-sonnet-5",
      name: "claude-sonnet-5",
      rateMultiplier: 1.3,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });
    expect(formatModelName(model!)).toBe("claude-sonnet-5 (1.3x)");
    expect(formatModelName({ name: "Claude Fable 5 (disabled)" })).toBe("Claude Fable 5 (disabled)");
  });
});

describe("Kiro management API requests", () => {
  it("fetchAvailableModels sends Kiro CLI 2.10.0 headers and captured body", async () => {
    const fetchSpy = spyFetch().mockResolvedValueOnce(
      mockResp({
        json: {
          models: [
            { modelId: "auto", modelName: "auto", rateMultiplier: 1.0 },
            { modelId: "claude-sonnet-5", modelName: "claude-sonnet-5", rateMultiplier: 1.3 },
          ],
        },
      }),
    );

    const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC123";
    const models = await fetchAvailableModels("access-token", "us-east-1", profileArn);

    expect(models).toEqual([{ modelId: "claude-sonnet-5", modelName: "claude-sonnet-5", rateMultiplier: 1.3 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      `https://management.us-east-1.kiro.dev/?origin=KIRO_CLI&profileArn=${encodeURIComponent(profileArn)}`,
    );
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ origin: "KIRO_CLI", profileArn }));

    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-token");
    expect(headers["Content-Type"]).toBe("application/x-amz-json-1.0");
    expect(headers["X-Amz-Target"]).toBe("AmazonCodeWhispererService.ListAvailableModels");
    expect(headers["user-agent"]).toContain("md/appVersion-2.10.0 app/AmazonQ-For-CLI");
    expect(headers["x-amz-user-agent"]).toContain("m/F,C");
    expect(headers["x-amzn-codewhisperer-optout"]).toBe("true");
    expect(headers["amz-sdk-request"]).toBe("attempt=1; max=3");
    expect(headers.Pragma).toBe("no-cache");
    expect(headers["Cache-Control"]).toBe("no-cache");
  });

  it("resolveProfileArn uses the method-specific ListAvailableProfiles target", async () => {
    const fetchSpy = spyFetch().mockResolvedValueOnce(
      mockResp({
        json: {
          profiles: [
            {
              arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/KIRO",
              profileType: "KIRO",
              status: "ACTIVE",
            },
          ],
        },
      }),
    );

    const arn = await resolveProfileArn("access-token", "us-east-1");

    expect(arn).toBe("arn:aws:codewhisperer:us-east-1:123456789012:profile/KIRO");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://management.us-east-1.kiro.dev/");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");

    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Amz-Target"]).toBe("AmazonCodeWhispererService.ListAvailableProfiles");
    expect(headers["user-agent"]).toContain("md/appVersion-2.10.0 app/AmazonQ-For-CLI");
  });
});
