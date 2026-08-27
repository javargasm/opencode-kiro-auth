import { McpServer } from "./server.js";

export * from "./types.js";
export * from "./server.js";
export * from "./tools/aws.js";
export * from "./tools/web-fetch.js";
export * from "./tools/usage.js";
export * from "./tools/checkpoint.js";

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
