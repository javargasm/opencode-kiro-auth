import { McpServer } from "./server.js";

export * from "./types.js";
export * from "./server.js";
export { awsTool, setAwsSpawnRunner, resetAwsSpawnRunner } from "./tools/aws.js";
export { webFetchTool } from "./tools/web-fetch.js";
export { webSearchTool } from "./tools/web-search.js";
export { thinkingTool } from "./tools/thinking.js";
export { usageTool } from "./tools/usage.js";
export { checkpointTool, setGitSpawnRunner, resetGitSpawnRunner } from "./tools/checkpoint.js";

export function startMcpServer(): void {
  const server = new McpServer();
  server.listenStdio();
}

// Auto-start if executed directly via CLI
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv.includes("--mcp")
) {
  startMcpServer();
}
