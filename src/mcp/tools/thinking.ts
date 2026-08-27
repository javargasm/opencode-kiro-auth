import type { RegisteredTool, McpToolResult } from "../types.js";

export const thinkingTool: RegisteredTool = {
  tool: {
    name: "thinking",
    description:
      "Thinking is an internal reasoning mechanism improving the quality of complex tasks by breaking their atomic actions down; use it specifically for multi-step problems requiring step-by-step dependencies, reasoning through multiple constraints, synthesizing results from previous tool calls, planning intricate sequences of actions, troubleshooting complex errors, or making decisions involving multiple trade-offs. Avoid using it for straightforward tasks, basic information retrieval, summaries, always clearly define the reasoning challenge, structure thoughts explicitly, consider multiple perspectives, and summarize key insights before important decisions or complex tool interactions.",
    inputSchema: {
      type: "object",
      properties: {
        thought: {
          type: "string",
          description:
            "A reflective note or intermediate reasoning step outlining dependencies, constraints, or planned actions.",
        },
      },
      required: ["thought"],
    },
  },
  handler: async (args): Promise<McpToolResult> => {
    const thought = String(args.thought || "").trim();
    if (!thought) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'thought' parameter is required." }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `[Reasoning Step Recorded]\n${thought}\n\nProceed with the next planned step or tool invocation.`,
        },
      ],
    };
  },
};
