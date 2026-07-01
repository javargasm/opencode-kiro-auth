
// Kiro model catalog + ID conversion + region mapping.
//
// Model IDs use dashes in pi (e.g. "claude-sonnet-4-6") and dots in the Kiro
// API (e.g. "claude-sonnet-4.6"). Everything in this file is in the pi/dash
// form except KIRO_MODEL_IDS and the output of resolveKiroModel.

/** Canonical Kiro API IDs (dot form) accepted by the server. */
export const KIRO_MODEL_IDS = new Set<string>([
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "minimax-m2.5",
  "minimax-m2.1",
  "glm-5",
  "qwen3-coder-next",
  "auto",
]);


/** Convert Kiro API's dot form to pi's dash form (e.g. 4.6 → 4-6). */
export function dotToDash(modelId: string): string {
  return modelId.replace(/(\d)\.(\d)/g, "$1-$2");
}

/** Convert pi's dash form to the Kiro API's dot form (e.g. 4-6 → 4.6). */
export function resolveKiroModel(modelId: string): string {
  const kiroId = modelId.replace(/(\d)-(\d)/g, "$1.$2");
  if (!KIRO_MODEL_IDS.has(kiroId)) {
    throw new Error(`Unknown Kiro model ID: ${modelId}`);
  }
  return kiroId;
}

/**
 * Map an SSO/OIDC region to the Kiro API region. The Kiro Q API is only
 * deployed in a subset of regions; tokens issued in e.g. eu-west-1 must be
 * sent to the eu-central-1 API endpoint.
 */
const API_REGION_MAP: Record<string, string> = {
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "us-east-2": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1",
  "ap-northeast-1": "us-east-1",
  "ap-northeast-2": "us-east-1",
  "ap-northeast-3": "us-east-1",
  "ap-southeast-1": "us-east-1",
  "ap-southeast-2": "us-east-1",
  "ap-south-1": "us-east-1",
  "ap-east-1": "us-east-1",
  "ap-south-2": "us-east-1",
  "ap-southeast-3": "us-east-1",
  "ap-southeast-4": "us-east-1",
};

export function resolveApiRegion(ssoRegion: string | undefined): string {
  if (!ssoRegion) return "us-east-1";
  return API_REGION_MAP[ssoRegion] ?? ssoRegion;
}

const BASE_URL = "https://runtime.us-east-1.kiro.dev";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const KIRO_CLI_ORIGIN = "KIRO_CLI";
const KIRO_CLI_USER_AGENT =
  "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererruntime/0.1.17593 os/macos lang/rust/1.92.0 md/appVersion-2.10.0 app/AmazonQ-For-CLI";
const KIRO_CLI_X_AMZ_USER_AGENT = `${KIRO_CLI_USER_AGENT} m/F,C`;
const KIRO_MANAGEMENT_TARGET = {
  listAvailableProfiles: "AmazonCodeWhispererService.ListAvailableProfiles",
  listAvailableModels: "AmazonCodeWhispererService.ListAvailableModels",
} as const;
const KIRO_MANAGEMENT_BASE_HEADERS = {
  "Content-Type": "application/x-amz-json-1.0",
  "user-agent": KIRO_CLI_USER_AGENT,
  "x-amz-user-agent": KIRO_CLI_X_AMZ_USER_AGENT,
  "x-amzn-codewhisperer-optout": "true",
  Accept: "*/*",
  "accept-encoding": "gzip",
  "amz-sdk-request": "attempt=1; max=3",
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
} as const;

type KiroManagementTarget = typeof KIRO_MANAGEMENT_TARGET[keyof typeof KIRO_MANAGEMENT_TARGET];

function kiroManagementHeaders(accessToken: string, target: KiroManagementTarget): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...KIRO_MANAGEMENT_BASE_HEADERS,
    "X-Amz-Target": target,
  };
}

/** Fields every Kiro model shares. Spread into each literal below. */
const KIRO_DEFAULTS = {
  api: "kiro-api" as const,
  provider: "kiro" as const,
  baseUrl: BASE_URL,
  cost: ZERO_COST,
} as const;

type Input = ("text" | "image")[];
const MULTIMODAL: Input = ["text", "image"];
const TEXT_ONLY: Input = ["text"];

export interface KiroModel {
  id: string;
  name: string;
  api: "kiro-api";
  provider: "kiro";
  baseUrl: string;
  reasoning: boolean;
  input: Input;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  /**
   * Credit rate multiplier from the Kiro ListAvailableModels catalog
   * (`rateMultiplier`). Used to annotate the display name so users see the
   * relative credit cost of each model directly in the picker. Defaults to
   * 1.0 when the upstream catalog omits it.
   */
  rateMultiplier?: number;
  /** Optional per-model override for the first-token timeout (ms). */
  firstTokenTimeout?: number;
  /** Per-model idle timeout override (ms). */
  idleTimeout?: number;
  /**
   * Upstream is expected to hide reasoning from clients — tags and
   * native reasoning events should be absent. When set:
   *
   *   - The `<thinking_mode>` system-prompt directive is skipped
   *     (the provider ignores it for these models).
   *   - A redacted-thinking breadcrumb is emitted lazily — only if
   *     no content or tool-call arrives within
   *     `HIDDEN_REASONING_COUNTDOWN_MS`. Fast responses emit no
   *     thinking block; slow responses get a single "Reasoning
   *     hidden by provider" marker so downstream UIs can show a
   *     "reasoning hidden" marker via the standard event stream contract.
   *
   * Does NOT gate the ThinkingTagParser — that runs unconditionally
   * when `reasoning` is enabled. The adaptive-thinking policy is
   * advisory: some models (Opus 4.7) intermittently leak
   * `<thinking>...</thinking>` tags inline, and the parser handles
   * them correctly when they do arrive.
   *
   * Applies to Claude Opus 4.7, which flipped Anthropic's
   * adaptive-thinking default from "summarized" to "omitted".
   * See https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking
   */
  reasoningHidden?: boolean;
  /**
   * Effort levels supported by this model for adaptive thinking.
   * Sourced from `ListAvailableModels` → `additionalModelRequestFieldsSchema`.
   * When present, the effort is sent via `additionalModelRequestFields.output_config.effort`
   * in the GenerateAssistantResponse request body.
   */
  supportedEfforts?: string[];
  /** Whether the model supports `thinking` block configuration. */
  supportsThinkingConfig?: boolean;
}

export const kiroModels: KiroModel[] = [
  {
    ...KIRO_DEFAULTS,
    id: "claude-fable-5",
    name: "Claude Fable 5 (disabled)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    // rateMultiplier intentionally omitted: fable-5 is disabled and absent
    // from the account catalog, so we don't fabricate a credit multiplier.
    firstTokenTimeout: 180_000,
    idleTimeout: 180_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsThinkingConfig: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    rateMultiplier: 1.3,
    firstTokenTimeout: 180_000,
    idleTimeout: 180_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsThinkingConfig: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    rateMultiplier: 2.2,
    firstTokenTimeout: 180_000,
    idleTimeout: 180_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsThinkingConfig: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    rateMultiplier: 2.2,
    firstTokenTimeout: 180_000,
    idleTimeout: 180_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsThinkingConfig: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    rateMultiplier: 2.2,
    supportedEfforts: ["low", "medium", "high", "max"],
    supportsThinkingConfig: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    rateMultiplier: 1.3,
    supportedEfforts: ["low", "medium", "high", "max"],
    supportsThinkingConfig: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 64_000,
    rateMultiplier: 2.2,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 64_000,
    rateMultiplier: 1.3,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 64_000,
    rateMultiplier: 1.3,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 64_000,
    rateMultiplier: 0.4,
  },
  {
    ...KIRO_DEFAULTS,
    id: "deepseek-3-2",
    name: "DeepSeek V3.2",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 164_000,
    maxTokens: 64_000,
    rateMultiplier: 0.25,
  },
  {
    ...KIRO_DEFAULTS,
    id: "minimax-m2-5",
    name: "MiniMax M2.5",
    reasoning: false,
    input: TEXT_ONLY,
    contextWindow: 196_000,
    maxTokens: 64_000,
    rateMultiplier: 0.25,
  },
  {
    ...KIRO_DEFAULTS,
    id: "minimax-m2-1",
    name: "MiniMax M2.1",
    reasoning: false,
    input: MULTIMODAL,
    contextWindow: 196_000,
    maxTokens: 64_000,
    rateMultiplier: 0.15,
  },
  {
    ...KIRO_DEFAULTS,
    id: "glm-5",
    name: "GLM-5",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 64_000,
    rateMultiplier: 0.5,
  },
  {
    ...KIRO_DEFAULTS,
    id: "qwen3-coder-next",
    name: "Qwen3 Coder Next",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 256_000,
    maxTokens: 64_000,
    rateMultiplier: 0.05,
  },
  {
    ...KIRO_DEFAULTS,
    id: "auto",
    name: "Auto",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    rateMultiplier: 1.0,
  },
];

/**
 * Format a model's display name with its credit rate multiplier appended,
 * e.g. "Claude Opus 4.8 (2.2x)". Applied at the single display chokepoint
 * (the OpenCode config hook) so BOTH paths are annotated:
 *   - dynamic/endpoint models (name is the raw dotted id, e.g. "claude-opus-4.8")
 *   - static/fallback models (name is the pretty label, e.g. "Claude Opus 4.8")
 *
 * When rateMultiplier is absent (e.g. the disabled fable-5) the name is
 * returned unchanged — we never invent a multiplier.
 */
export function formatModelName(model: Pick<KiroModel, "name" | "rateMultiplier">): string {
  const m = model.rateMultiplier;
  if (typeof m !== "number" || !Number.isFinite(m)) return model.name;
  return `${model.name} (${m}x)`;
}

// ---- Dynamic model resolution -----------------------------------------

export interface KiroApiModel {
  modelId: string;
  modelName: string;
  /** Credit rate multiplier from the ListAvailableModels catalog. */
  rateMultiplier?: number;
  tokenLimits?: { maxInputTokens?: number; maxOutputTokens?: number };
  supportedInputTypes?: string[];
  /** Schema for extra fields accepted by GenerateAssistantResponse. */
  additionalModelRequestFieldsSchema?: {
    properties?: {
      output_config?: { properties?: { effort?: { enum?: string[] } } };
      thinking?: { properties?: { type?: { enum?: string[] } } };
    };
  };
}

let cachedProfileArn: string | null = null;
let profileArnSkipResolution = false;

export function resetProfileArnCache(skipResolution = false): void {
  cachedProfileArn = null;
  profileArnSkipResolution = skipResolution;
}

export function seedProfileArn(arn: string): void {
  cachedProfileArn = arn;
}

/**
 * Resolve the Kiro profile ARN by calling ListAvailableProfiles.
 * Builder ID device-code login doesn't receive a profileArn, so we
 * discover it here. Returns null on failure (graceful fallback).
 */
export async function resolveProfileArn(
  accessToken: string,
  apiRegion: string,
): Promise<string | null> {
  if (profileArnSkipResolution) return null;
  if (cachedProfileArn !== null) return cachedProfileArn;

  const endpoint = `https://management.${apiRegion}.kiro.dev/`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: kiroManagementHeaders(accessToken, KIRO_MANAGEMENT_TARGET.listAvailableProfiles),
    body: "{}",
  });
  if (!resp || !resp.ok) return null;

  const data = (await resp.json()) as {
    profiles?: { arn?: string; profileType?: string; status?: string }[];
  };
  const profiles = data.profiles ?? [];
  const kiroProfile = profiles.find((p) => p.profileType === "KIRO" && p.status === "ACTIVE");
  const arn = kiroProfile?.arn ?? profiles[0]?.arn ?? null;
  
  if (arn) {
    cachedProfileArn = arn;
  }
  return arn;
}

/**
 * Fetch the list of models actually available for this account from Kiro.
 * Filters out "auto" — it appears in ListAvailableModels but is rejected
 * by GenerateAssistantResponse with INVALID_MODEL_ID.
 */
export async function fetchAvailableModels(
  accessToken: string,
  apiRegion: string,
  profileArn: string,
): Promise<KiroApiModel[]> {
  const url = `https://management.${apiRegion}.kiro.dev/?origin=${KIRO_CLI_ORIGIN}&profileArn=${encodeURIComponent(
    profileArn,
  )}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: kiroManagementHeaders(accessToken, KIRO_MANAGEMENT_TARGET.listAvailableModels),
    body: JSON.stringify({ origin: KIRO_CLI_ORIGIN, profileArn }),
  });
  if (!resp.ok) {
    throw new Error(`ListAvailableModels failed: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { models?: KiroApiModel[] };
  return (data.models ?? []).filter((m) => m.modelId !== "auto");
}

/** Model families known to support reasoning/thinking. */
const REASONING_FAMILIES = new Set([
  "claude-fable", "claude-sonnet", "claude-opus",
  "deepseek", "kimi", "glm", "qwen", "agi-nova", "minimax"
]);

function isReasoningModel(dotId: string): boolean {
  for (const family of REASONING_FAMILIES) {
    if (dotId.startsWith(family)) return true;
  }
  return false;
}

/** Timeout for high-effort reasoning models (Opus/Fable: 180s). */
function modelTimeout(dotId: string, defaultMs: number): number {
  if (dotId.startsWith("claude-fable") || dotId.startsWith("claude-opus")) return 180_000;
  return defaultMs;
}

/**
 * Build pi model definitions from the Kiro ListAvailableModels API response.
 *
 * BY DESIGN (audit #14): this also mutates the module-level KIRO_MODEL_IDS set
 * (adds each dynamic model id) so resolveKiroModel() accepts ids that only
 * exist in the dynamic catalog. The side effect is intentional and required —
 * without it, dynamically-discovered models would be rejected as "Unknown Kiro
 * model ID" before the request is ever sent.
 */
export function buildModelsFromApi(apiModels: KiroApiModel[]): KiroModel[] {
  return apiModels.map((m) => {
    // Register the model ID dynamically to allow resolveKiroModel to pass
    KIRO_MODEL_IDS.add(m.modelId);

    const dashId = dotToDash(m.modelId);
    const supportedTypes = m.supportedInputTypes ?? ["TEXT"];
    const input: ("text" | "image")[] = supportedTypes.includes("IMAGE")
      ? ["text", "image"]
      : ["text"];

    // Extract supported effort levels from the model schema
    const effortEnum = m.additionalModelRequestFieldsSchema
      ?.properties?.output_config?.properties?.effort?.enum;
    const supportedEfforts = Array.isArray(effortEnum) && effortEnum.length > 0
      ? effortEnum
      : undefined;

    const supportsThinkingConfig = !!m.additionalModelRequestFieldsSchema?.properties?.thinking;

    const rateMultiplier =
      typeof m.rateMultiplier === "number" && Number.isFinite(m.rateMultiplier)
        ? m.rateMultiplier
        : undefined;

    return {
      ...KIRO_DEFAULTS,
      id: dashId,
      name: m.modelName,
      reasoning: isReasoningModel(m.modelId),
      input,
      contextWindow: m.tokenLimits?.maxInputTokens ?? 200_000,
      maxTokens: m.tokenLimits?.maxOutputTokens ?? 8_192,
      firstTokenTimeout: modelTimeout(m.modelId, 90_000),
      idleTimeout: modelTimeout(m.modelId, 60_000),
      // Per-model overrides for known special cases
      ...(rateMultiplier !== undefined ? { rateMultiplier } : {}),
      ...(supportedEfforts ? { supportedEfforts } : {}),
      ...(supportsThinkingConfig ? { supportsThinkingConfig } : {}),
    };
  });
}

// Module-level cache for dynamically loaded models
let cachedDynamicModels: KiroModel[] | null = null;

export function getCachedDynamicModels(): KiroModel[] | null {
  return cachedDynamicModels;
}

export function setCachedDynamicModels(models: KiroModel[] | null): void {
  cachedDynamicModels = models;
}
