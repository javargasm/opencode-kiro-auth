import type { RegisteredTool, McpToolResult } from "../types.js";
import { fetchKiroUsageLimits } from "../../server.js";

export const usageTool: RegisteredTool = {
  tool: {
    name: "kiro_usage",
    description:
      "Show account-level usage limits, remaining credits, active plan title, and monthly reset duration for the active Kiro session.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Force refresh limits from the remote API instead of using the local cache.",
        },
      },
    },
  },
  handler: async (args): Promise<McpToolResult> => {
    try {
      const usage = await fetchKiroUsageLimits({ force: !!args.force, timeoutMs: 10000 });

      const pct = typeof usage.percentage === "number" ? `${usage.percentage}%` : "N/A";
      const credits =
        typeof usage.creditsUsed === "number" && typeof usage.creditsTotal === "number"
          ? `${usage.creditsUsed.toFixed(2)} / ${usage.creditsTotal.toFixed(2)}`
          : "Unlimited / Unmetered";

      const infoLines: string[] = [
        "## Kiro Account Usage & Limits",
        `- **Plan**: ${usage.planTitle || "Standard"}`,
        `- **Usage Percentage**: ${pct}`,
        `- **Credits**: ${credits}`,
        `- **Monthly Reset In**: ${usage.monthlyResetsIn || "N/A"}`,
      ];

      if (usage.error) {
        infoLines.push(`\n> **Notice**: ${usage.error}`);
      }

      return {
        content: [{ type: "text", text: infoLines.join("\n") }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to fetch Kiro usage limits: ${err.message || String(err)}` }],
      };
    }
  },
};
