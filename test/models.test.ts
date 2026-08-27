import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModelsFromApi,
  fetchAvailableModels,
  formatModelName,
  kiroModels,
  resetProfileArnCache,
  resolveApiRegion,
  resolveProfileArn,
} from "../src/models";
import { log } from "../src/debug";

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
  it("maps unsupported or malformed regions to a trusted Kiro API region", () => {
    expect(resolveApiRegion("eu-west-1")).toBe("eu-central-1");
    expect(resolveApiRegion("evil.example/#")).toBe("us-east-1");
  });

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
    // formatModelName resolves the pretty name from kiroModels by id
    expect(formatModelName(model!)).toBe("Claude Sonnet 5 (1.3x)");
    expect(formatModelName({ id: "claude-fable-5", name: "claude-fable-5" })).toBe("Claude Fable 5 (disabled)");
  });

  it("preserves native GPT and Claude catalog effort metadata", () => {
    const gptEfforts = ["none", "low", "medium", "high", "xhigh", "max"];
    const [sol, terra, luna, claude] = buildModelsFromApi([
      {
        modelId: "gpt-5.6-sol",
        modelName: "GPT 5.6 Sol",
        rateMultiplier: 1.5,
        supportedInputTypes: ["TEXT"],
        tokenLimits: { maxInputTokens: 128_000, maxOutputTokens: 32_000 },
        additionalModelRequestFieldsSchema: {
          properties: {
            reasoning: {
              properties: {
                effort: { enum: gptEfforts },
                mode: { enum: ["enabled", "disabled"] },
              },
            },
          },
        },
      },
      {
        modelId: "gpt-5.6-terra",
        modelName: "GPT 5.6 Terra",
        additionalModelRequestFieldsSchema: {
          properties: { reasoning: { properties: { effort: { enum: gptEfforts } } } },
        },
      },
      {
        modelId: "gpt-5.6-luna",
        modelName: "GPT 5.6 Luna",
        additionalModelRequestFieldsSchema: {
          properties: { reasoning: { properties: { effort: { enum: gptEfforts } } } },
        },
      },
      {
        modelId: "claude-opus-4.7",
        modelName: "Claude Opus 4.7",
        rateMultiplier: 2,
        supportedInputTypes: ["TEXT", "IMAGE"],
        tokenLimits: { maxInputTokens: 200_000, maxOutputTokens: 64_000 },
        additionalModelRequestFieldsSchema: {
          properties: {
            output_config: { properties: { effort: { enum: ["low", "medium", "high", "max"] } } },
            thinking: { properties: { type: { enum: ["adaptive"] } } },
            max_tokens: { type: "integer" },
          },
        },
      },
    ]);

    expect(sol).toMatchObject({
      id: "gpt-5-6-sol",
      name: "GPT 5.6 Sol",
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 32_000,
      rateMultiplier: 1.5,
      reasoning: true,
      firstTokenTimeout: 230_000,
      idleTimeout: 230_000,
      nativeEfforts: gptEfforts,
      supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
      effortRequestField: "reasoning",
    });
    expect(sol?.supportsMaxTokens).toBeUndefined();
    for (const gpt of [terra, luna]) {
      expect(gpt).toMatchObject({
        nativeEfforts: gptEfforts,
        supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
        effortRequestField: "reasoning",
        firstTokenTimeout: 230_000,
        idleTimeout: 230_000,
      });
      expect(gpt?.supportsMaxTokens).toBeUndefined();
    }
    expect(claude).toMatchObject({
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 64_000,
      rateMultiplier: 2,
      reasoning: true,
      nativeEfforts: ["low", "medium", "high", "max"],
      supportedEfforts: ["minimal", "low", "medium", "xhigh"],
      effortRequestField: "output_config",
      supportsThinkingConfig: true,
      supportsMaxTokens: true,
      reasoningHidden: true,
    });
    expect(kiroModels.find((model) => model.id === "claude-opus-4-7")?.reasoningHidden).toBe(true);
    expect(kiroModels.find((model) => model.id === "claude-opus-5")?.reasoningHidden).toBeUndefined();
  });

  it("formatModelName resolves pretty name from kiroModels by id", () => {
    // Dynamic catalog model with raw dotted name → resolved to static pretty name
    const dynamic = buildModelsFromApi([
      { modelId: "gpt-5.6-sol", modelName: "gpt-5.6-sol", rateMultiplier: 2.4 },
    ]);
    expect(formatModelName(dynamic[0]!)).toBe("GPT 5.6 Sol (2.4x)");

    // Unknown model id falls back to the passed name
    expect(formatModelName({ id: "unknown-model", name: "Unknown", rateMultiplier: 1.0 })).toBe("Unknown (1x)");

    // No rateMultiplier returns just the resolved name
    expect(formatModelName({ id: "claude-sonnet-4", name: "claude-sonnet-4" })).toBe("Claude Sonnet 4");
  });

  it("includes GPT 5.6 variants in static kiroModels", () => {
    const gptIds = ["gpt-5-6-sol", "gpt-5-6-terra", "gpt-5-6-luna"];
    for (const id of gptIds) {
      const model = kiroModels.find((m) => m.id === id);
      expect(model, `${id} should exist in kiroModels`).toBeDefined();
      expect(model!.reasoning).toBe(true);
      expect(model!.contextWindow).toBe(272_000);
      expect(model!.maxTokens).toBe(128_000);
      expect(model!.effortRequestField).toBe("reasoning");
      expect(model!.nativeEfforts).toContain("none");
      expect(model!.nativeEfforts).toContain("max");
    }

    // Verify specific rate multipliers matching live kiro-cli
    expect(kiroModels.find((m) => m.id === "gpt-5-6-sol")!.rateMultiplier).toBe(2.4);
    expect(kiroModels.find((m) => m.id === "gpt-5-6-terra")!.rateMultiplier).toBe(1.0);
    expect(kiroModels.find((m) => m.id === "gpt-5-6-luna")!.rateMultiplier).toBe(0.1);
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
    expect(headers["user-agent"]).toContain("md/appVersion-2.20.0 app/AmazonQ-For-CLI");
    expect(headers["x-amz-user-agent"]).toContain("m/F,C");
    expect(headers["x-amzn-codewhisperer-optout"]).toBe("true");
    expect(headers["amz-sdk-request"]).toBe("attempt=1; max=3");
    expect(headers.Pragma).toBe("no-cache");
    expect(headers["Cache-Control"]).toBe("no-cache");
  });

  it("logs the model catalog exchange without credentials or the profile ARN", async () => {
    const debugSpy = vi.spyOn(log, "debug");
    const errorSpy = vi.spyOn(log, "error");
    spyFetch().mockResolvedValueOnce(
      mockResp({
        json: {
          models: [
            { modelId: "auto", modelName: "auto" },
            { modelId: "claude-sonnet-5", modelName: "claude-sonnet-5" },
          ],
        },
      }),
    );

    const accessToken = "secret-access-token";
    const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/SECRET";
    await fetchAvailableModels(accessToken, "us-east-1", profileArn);

    expect(debugSpy).toHaveBeenCalledWith("model_catalog_request", expect.any(Object));
    expect(debugSpy).toHaveBeenCalledWith("model_catalog_response", expect.objectContaining({
      status: 200,
      modelCount: 2,
      returnedModelCount: 1,
    }));
    expect(errorSpy).not.toHaveBeenCalled();

    const logged = JSON.stringify(debugSpy.mock.calls);
    expect(logged).toContain("model_catalog_request");
    expect(logged).toContain("model_catalog_response");
    expect(logged).not.toContain("claude-sonnet-5");
    expect(logged).toContain("[redacted]");
    expect(logged).not.toContain(accessToken);
    expect(logged).not.toContain(profileArn);
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
    expect(headers["user-agent"]).toContain("md/appVersion-2.20.0 app/AmazonQ-For-CLI");
  });

  it("resolveProfileArn falls back to DEFAULT_PROFILE_ARN when ListAvailableProfiles fails (e.g. Builder ID)", async () => {
    resetProfileArnCache(false);
    spyFetch().mockResolvedValueOnce(
      mockResp({
        ok: false,
        status: 400,
        json: {
          __type: "com.amazon.kiro.controlplane#AccessDeniedException",
          message: "User is not authorized to access this feature.",
        },
      }),
    );

    const arn = await resolveProfileArn("builder-id-token", "us-east-1");

    expect(arn).toBe("arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX");
  });

  it("resolveProfileArn falls back to DEFAULT_PROFILE_ARN when ListAvailableProfiles throws", async () => {
    resetProfileArnCache(false);
    spyFetch().mockRejectedValueOnce(new Error("network failure"));

    const arn = await resolveProfileArn("token", "us-east-1");

    expect(arn).toBe("arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX");
  });
});
