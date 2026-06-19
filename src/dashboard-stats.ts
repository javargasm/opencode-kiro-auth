export interface RequestMetrics {
  id: string;
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  stream: boolean;
  effort?: string;
  usd?: number;
}

const MAX_HISTORY = 100;

interface TokenPrice {
  input: number;  // USD per 1M tokens
  output: number; // USD per 1M tokens
}

const MODEL_PRICING: Record<string, TokenPrice> = {
  // Claude Fable 5 (Exempt from cleanup)
  "claude-fable-5": { input: 10.00, output: 50.00 },

  // Claude Opus 4 Series
  "claude-opus-4-8": { input: 5.00, output: 25.00 },
  "claude-opus-4-7": { input: 5.00, output: 25.00 },
  "claude-opus-4-6": { input: 5.00, output: 25.00 },
  "claude-opus-4-5": { input: 5.00, output: 25.00 },

  // Claude Sonnet 4 Series
  "claude-sonnet-4-6": { input: 3.00, output: 15.00 },
  "claude-sonnet-4-5": { input: 3.00, output: 15.00 },
  "claude-sonnet-4": { input: 3.00, output: 15.00 },

  // Claude Haiku Series
  "claude-haiku-4-5": { input: 1.00, output: 5.00 },

  // Other active models
  "minimax-m2-5": { input: 0.15, output: 1.20 },
  "minimax-m2-1": { input: 0.30, output: 1.20 },
  "qwen3-coder-next": { input: 0.30, output: 1.00 },
  "auto": { input: 3.00, output: 15.00 },
};

export function getModelPricing(modelId: string): TokenPrice {
  const normId = modelId.replace(/\./g, "-").toLowerCase();
  
  if (MODEL_PRICING[normId]) {
    return MODEL_PRICING[normId]!;
  }

  // Sort keys by length descending to match more specific models first (e.g. claude-opus-4-6 before claude-opus-4)
  const sortedKeys = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (normId.startsWith(key)) {
      return MODEL_PRICING[key]!;
    }
  }

  return { input: 3.00, output: 15.00 };
}

class DashboardStats {
  private requests: RequestMetrics[] = [];
  private totalRequests = 0;
  private totalTokens = 0;
  private totalCredits = 0;
  private totalUsd = 0;

  recordRequest(metrics: Omit<RequestMetrics, "timestamp" | "usd">) {
    const pricing = getModelPricing(metrics.model);
    const usd = ((metrics.inputTokens * pricing.input) + (metrics.outputTokens * pricing.output)) / 1_000_000;

    this.totalRequests++;
    this.totalTokens += metrics.inputTokens + metrics.outputTokens;
    this.totalCredits += metrics.credits;
    this.totalUsd += usd;

    this.requests.unshift({ ...metrics, usd, timestamp: Date.now() });
    if (this.requests.length > MAX_HISTORY) {
      this.requests.pop();
    }
  }

  getStats() {
    return {
      totalRequests: this.totalRequests,
      totalTokens: this.totalTokens,
      totalCredits: this.totalCredits,
      totalUsd: this.totalUsd,
      requests: this.requests,
    };
  }
}

export const stats = new DashboardStats();
