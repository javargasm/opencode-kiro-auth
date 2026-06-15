export interface RequestMetrics {
  id: string;
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  stream: boolean;
}

const MAX_HISTORY = 100;

class DashboardStats {
  private requests: RequestMetrics[] = [];

  recordRequest(metrics: Omit<RequestMetrics, "timestamp">) {
    this.requests.unshift({ ...metrics, timestamp: Date.now() });
    if (this.requests.length > MAX_HISTORY) {
      this.requests.pop();
    }
  }

  getStats() {
    const totalRequests = this.requests.length;
    const totalTokens = this.requests.reduce((acc, r) => acc + r.inputTokens + r.outputTokens, 0);
    const totalCredits = this.requests.reduce((acc, r) => acc + r.credits, 0);

    return {
      totalRequests,
      totalTokens,
      totalCredits,
      requests: this.requests,
    };
  }
}

export const stats = new DashboardStats();
