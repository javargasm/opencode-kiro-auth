
// Kiro model catalog + ID conversion + region mapping.
//
// Model IDs use dashes in pi (e.g. "claude-sonnet-4-6") and dots in the Kiro
// API (e.g. "claude-sonnet-4.6"). Everything in this file is in the pi/dash
// form except KIRO_MODEL_IDS and the output of resolveKiroModel.

import { log } from "./debug";
import type { KiroNativeEffort, ThinkingLevel } from "./types";
import { createHash } from "node:crypto";

/** Canonical Kiro API IDs (dot form) accepted by the server. */
export const KIRO_MODEL_IDS = new Set<string>([
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
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
  if (ssoRegion === "us-east-1" || ssoRegion === "eu-central-1") return ssoRegion;
  return API_REGION_MAP[ssoRegion] ?? "us-east-1";
}

const BASE_URL = "https://runtime.us-east-1.kiro.dev";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const KIRO_CLI_ORIGIN = "KIRO_CLI";
const KIRO_CLI_USER_AGENT =
  "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererruntime/0.1.17593 os/macos lang/rust/1.92.0 md/appVersion-2.15.0 app/AmazonQ-For-CLI";
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

const REDACTED_PROFILE_ARN = "[redacted]";

function redactProfileArn(value: string): string {
  return value ? REDACTED_PROFILE_ARN : value;
}

function redactCatalogError(error: unknown, accessToken: string, profileArn: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (accessToken) message = message.replaceAll(accessToken, REDACTED_PROFILE_ARN);
  if (profileArn) message = message.replaceAll(profileArn, REDACTED_PROFILE_ARN);
  return message;
}

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
  /** Exact effort labels advertised by the Kiro catalog. */
  nativeEfforts?: KiroNativeEffort[];
  /** Normalized Pi levels retained for existing direct stream callers. */
  supportedEfforts?: ThinkingLevel[];
  /** Request field advertised by the catalog for effort overrides. */
  effortRequestField?: "reasoning" | "output_config";
  /** Whether the catalog advertises the top-level max_tokens field. */
  supportsMaxTokens?: boolean;
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
    nativeEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
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
    nativeEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    effortRequestField: "output_config",
    supportsThinkingConfig: true,
    supportsMaxTokens: true,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-5",
    name: "Claude Opus 5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    rateMultiplier: 2.2,
    firstTokenTimeout: 180_000,
    idleTimeout: 180_000,
    nativeEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    effortRequestField: "output_config",
    supportsThinkingConfig: true,
    supportsMaxTokens: true,
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
    nativeEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    effortRequestField: "output_config",
    supportsThinkingConfig: true,
    supportsMaxTokens: true,
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
    nativeEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    effortRequestField: "output_config",
    supportsThinkingConfig: true,
    supportsMaxTokens: true,
    reasoningHidden: true,
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
    nativeEfforts: ["low", "medium", "high", "max"],
    supportedEfforts: ["minimal", "low", "medium", "xhigh"],
    effortRequestField: "output_config",
    supportsThinkingConfig: true,
    supportsMaxTokens: true,
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
    nativeEfforts: ["low", "medium", "high", "max"],
    supportedEfforts: ["minimal", "low", "medium", "xhigh"],
    effortRequestField: "output_config",
    supportsThinkingConfig: true,
    supportsMaxTokens: true,
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
    id: "gpt-5-6-sol",
    name: "GPT 5.6 Sol",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 272_000,
    maxTokens: 128_000,
    rateMultiplier: 2.4,
    firstTokenTimeout: 230_000,
    idleTimeout: 230_000,
    nativeEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    effortRequestField: "reasoning",
  },
  {
    ...KIRO_DEFAULTS,
    id: "gpt-5-6-terra",
    name: "GPT 5.6 Terra",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 272_000,
    maxTokens: 128_000,
    rateMultiplier: 1.2,
    firstTokenTimeout: 230_000,
    idleTimeout: 230_000,
    nativeEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    effortRequestField: "reasoning",
  },
  {
    ...KIRO_DEFAULTS,
    id: "gpt-5-6-luna",
    name: "GPT 5.6 Luna",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 272_000,
    maxTokens: 128_000,
    rateMultiplier: 0.6,
    firstTokenTimeout: 230_000,
    idleTimeout: 230_000,
    nativeEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    effortRequestField: "reasoning",
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
export function formatModelName(model: Pick<KiroModel, "id" | "name" | "rateMultiplier">): string {
  const staticModel = kiroModels.find((m) => m.id === model.id);
  const name = staticModel?.name ?? model.name;
  const rate = model.rateMultiplier;
  if (typeof rate !== "number" || !Number.isFinite(rate)) return name;
  return `${name} (${rate}x)`;
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
      reasoning?: { properties?: { effort?: { enum?: string[] }; mode?: { enum?: string[] } } };
      thinking?: { properties?: { type?: { enum?: string[] } } };
      max_tokens?: { type?: string };
    };
  };
}

const KIRO_TO_PI_EFFORT: Record<string, ThinkingLevel> = {
  low: "minimal",
  medium: "low",
  high: "medium",
  xhigh: "high",
  max: "xhigh",
};

export const KIRO_NATIVE_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

export function isKiroNativeEffort(effort: unknown): effort is KiroNativeEffort {
  return typeof effort === "string" && (KIRO_NATIVE_EFFORTS as readonly string[]).includes(effort);
}

function nativeSupportedEfforts(effortEnum: unknown): KiroNativeEffort[] | undefined {
  if (!Array.isArray(effortEnum)) return undefined;
  const nativeEfforts = effortEnum.filter(isKiroNativeEffort);
  return nativeEfforts.length > 0 ? nativeEfforts : undefined;
}

function normalizeSupportedEfforts(nativeEfforts: KiroNativeEffort[] | undefined): ThinkingLevel[] | undefined {
  if (!nativeEfforts) return undefined;
  const normalized = nativeEfforts.flatMap((effort) => {
    const level = KIRO_TO_PI_EFFORT[effort];
    return level ? [level] : [];
  });
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

const cachedProfileArns = new Map<string, string>();
const PROFILE_ARN_CACHE_MAX_ENTRIES = 64;
let profileArnSkipResolution = false;

function profileCacheKey(accessToken: string, apiRegion: string): string {
  return createHash("sha256").update(`${accessToken}\0${apiRegion}`).digest("hex");
}

function cacheProfileArn(key: string, arn: string): void {
  cachedProfileArns.delete(key);
  cachedProfileArns.set(key, arn);
  while (cachedProfileArns.size > PROFILE_ARN_CACHE_MAX_ENTRIES) {
    const oldest = cachedProfileArns.keys().next().value;
    if (!oldest) break;
    cachedProfileArns.delete(oldest);
  }
}

function managementSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function resetProfileArnCache(skipResolution = false): void {
  cachedProfileArns.clear();
  profileArnSkipResolution = skipResolution;
}

export function seedProfileArn(arn: string, accessToken: string, apiRegion: string): void {
  cacheProfileArn(profileCacheKey(accessToken, apiRegion), arn);
}

/**
 * Resolve the Kiro profile ARN by calling ListAvailableProfiles.
 * Builder ID device-code login doesn't receive a profileArn, so we
 * discover it here. Returns null on failure (graceful fallback).
 */
export async function resolveProfileArn(
  accessToken: string,
  apiRegion: string,
  useCache = true,
  signal?: AbortSignal,
): Promise<string | null> {
  if (profileArnSkipResolution) return null;
  const cacheKey = profileCacheKey(accessToken, apiRegion);
  const cached = cachedProfileArns.get(cacheKey);
  if (useCache && cached !== undefined) return cached;

  const endpoint = `https://management.${apiRegion}.kiro.dev/`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: kiroManagementHeaders(accessToken, KIRO_MANAGEMENT_TARGET.listAvailableProfiles),
    body: "{}",
    signal: managementSignal(signal),
  });
  if (!resp || !resp.ok) return null;

  const data = (await resp.json()) as {
    profiles?: { arn?: string; profileType?: string; status?: string }[];
  };
  const profiles = data.profiles ?? [];
  const kiroProfile = profiles.find((p) => p.profileType === "KIRO" && p.status === "ACTIVE");
  const arn = kiroProfile?.arn ?? profiles[0]?.arn ?? null;
  
  if (arn && useCache) {
    cacheProfileArn(cacheKey, arn);
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
  signal?: AbortSignal,
): Promise<KiroApiModel[]> {
  const url = `https://management.${apiRegion}.kiro.dev/?origin=${KIRO_CLI_ORIGIN}&profileArn=${encodeURIComponent(
    profileArn,
  )}`;
  const target = KIRO_MANAGEMENT_TARGET.listAvailableModels;
  const method = "POST";
  const requestBody = { origin: KIRO_CLI_ORIGIN, profileArn: redactProfileArn(profileArn) };
  const safeEndpoint = `https://management.${apiRegion}.kiro.dev/?origin=${KIRO_CLI_ORIGIN}&profileArn=${encodeURIComponent(
    REDACTED_PROFILE_ARN,
  )}`;
  const logContext = {
    method,
    endpoint: safeEndpoint,
    target,
    profileArn: redactProfileArn(profileArn),
  };
  const logError = (error: unknown, status?: number) => {
    log.error("model_catalog_error", {
      ...logContext,
      ...(status === undefined ? {} : { status }),
      error: redactCatalogError(error, accessToken, profileArn),
    });
  };

  log.debug("model_catalog_request", { ...logContext, request: requestBody });

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: kiroManagementHeaders(accessToken, target),
      body: JSON.stringify({ origin: KIRO_CLI_ORIGIN, profileArn }),
      signal: managementSignal(signal),
    });
  } catch (error) {
    logError(error);
    throw error;
  }

  if (!resp.ok) {
    const error = new Error(`ListAvailableModels failed: HTTP ${resp.status}`);
    log.debug("model_catalog_response", {
      ...logContext,
      status: resp.status,
      modelCount: 0,
      modelCatalog: [],
    });
    logError(error, resp.status);
    throw error;
  }

  try {
    const data = (await resp.json()) as { models?: KiroApiModel[] };
    const modelCatalog = data.models ?? [];
    const models = modelCatalog.filter((m) => m.modelId !== "auto");
    log.debug("model_catalog_response", {
      ...logContext,
      status: resp.status,
      modelCount: modelCatalog.length,
      returnedModelCount: models.length
    });
    return models;
  } catch (error) {
    logError(error, resp.status);
    throw error;
  }
}

/** Model families known to support reasoning/thinking. */
const REASONING_FAMILIES = new Set([
  "claude-fable", "claude-sonnet", "claude-opus",
  "deepseek", "kimi", "glm", "qwen", "agi-nova", "minimax", "gpt"
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
    const staticModel = kiroModels.find((model) => model.id === dashId);
    const supportedTypes = m.supportedInputTypes ?? ["TEXT"];
    const input: ("text" | "image")[] = supportedTypes.includes("IMAGE")
      ? ["text", "image"]
      : ["text"];

    // Extract supported effort levels from the model schema
    const schemaProperties = m.additionalModelRequestFieldsSchema?.properties;
    const effortRequestField = schemaProperties?.reasoning?.properties?.effort?.enum
      ? "reasoning"
      : schemaProperties?.output_config?.properties?.effort?.enum
        ? "output_config"
        : undefined;
    const effortEnum = effortRequestField === "reasoning"
      ? schemaProperties?.reasoning?.properties?.effort?.enum
      : schemaProperties?.output_config?.properties?.effort?.enum;
    const nativeEfforts = nativeSupportedEfforts(effortEnum);
    const supportedEfforts = normalizeSupportedEfforts(nativeEfforts);

    const supportsThinkingConfig = !!m.additionalModelRequestFieldsSchema?.properties?.thinking;
    const supportsMaxTokens = !!schemaProperties?.max_tokens;

    const rateMultiplier =
      typeof m.rateMultiplier === "number" && Number.isFinite(m.rateMultiplier)
        ? m.rateMultiplier
        : undefined;

    return {
      ...KIRO_DEFAULTS,
      id: dashId,
      name: m.modelName,
      reasoning: isReasoningModel(m.modelId) || Boolean(nativeEfforts?.length),
      input,
      contextWindow: m.tokenLimits?.maxInputTokens ?? 200_000,
      maxTokens: m.tokenLimits?.maxOutputTokens ?? 8_192,
      // The account catalog does not publish timeout policy. Preserve tuned
      // values for known models (notably GPT 5.6) instead of replacing them
      // with the generic dynamic-catalog defaults.
      firstTokenTimeout: staticModel?.firstTokenTimeout ?? modelTimeout(m.modelId, 90_000),
      idleTimeout: staticModel?.idleTimeout ?? modelTimeout(m.modelId, 60_000),
      // Per-model overrides for known special cases
      ...(rateMultiplier !== undefined ? { rateMultiplier } : {}),
      ...(nativeEfforts ? { nativeEfforts } : {}),
      ...(supportedEfforts ? { supportedEfforts } : {}),
      ...(effortRequestField ? { effortRequestField } : {}),
      ...(supportsMaxTokens ? { supportsMaxTokens } : {}),
      ...(supportsThinkingConfig ? { supportsThinkingConfig } : {}),
      ...(staticModel?.reasoningHidden ? { reasoningHidden: true } : {}),
    };
  });
}

// Module-level cache for dynamically loaded models
let cachedDynamicModels: KiroModel[] | null = null;

export function getCachedDynamicModels(): KiroModel[] | null {
  return cachedDynamicModels;
}

export function setCachedDynamicModels(models: KiroModel[] | null): void {
  for (const model of models ?? []) {
    KIRO_MODEL_IDS.add(model.id.replace(/(\d)-(\d)/g, "$1.$2"));
  }
  cachedDynamicModels = models;
}

/** Use the active account catalog when it is loaded; static models are fallback-only. */
export function findKiroModel(modelId: string): KiroModel | undefined {
  const dynamicModels = getCachedDynamicModels();
  return dynamicModels === null
    ? kiroModels.find((model) => model.id === modelId)
    : dynamicModels.find((model) => model.id === modelId);
}

/** Return an effort only when the selected catalog model explicitly advertises it. */
export function validateNativeKiroEffort(
  model: Pick<KiroModel, "nativeEfforts"> | undefined,
  effort: unknown,
): KiroNativeEffort | undefined {
  return isKiroNativeEffort(effort) && model?.nativeEfforts?.includes(effort) ? effort : undefined;
}
