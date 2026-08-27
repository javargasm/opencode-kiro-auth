import * as readline from "readline";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  RegisteredTool,
  McpTool,
} from "./types.js";
import { awsTool } from "./tools/aws.js";
import { webFetchTool } from "./tools/web-fetch.js";
import { webSearchTool } from "./tools/web-search.js";
import { thinkingTool } from "./tools/thinking.js";
import { usageTool } from "./tools/usage.js";
import { checkpointTool } from "./tools/checkpoint.js";

export class McpServer {
  private tools: Map<string, RegisteredTool> = new Map();
  private name: string;
  private version: string;

  constructor(name = "@javargasm/opencode-kiro-auth", version = "8.3.0") {
    this.name = name;
    this.version = version;

    // Register built-in native tools
    this.registerTool(awsTool);
    this.registerTool(webFetchTool);
    this.registerTool(webSearchTool);
    this.registerTool(thinkingTool);
    this.registerTool(usageTool);
    this.registerTool(checkpointTool);
  }

  public registerTool(registeredTool: RegisteredTool): void {
    this.tools.set(registeredTool.tool.name, registeredTool);
  }

  public getTools(): McpTool[] {
    return Array.from(this.tools.values()).map((r) => r.tool);
  }

  public async handleMessage(rawMessage: string): Promise<string | null> {
    const trimmed = rawMessage.trim();
    if (!trimmed) return null;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed);
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: Invalid JSON" },
      });
    }

    if (!request || typeof request !== "object" || request.jsonrpc !== "2.0") {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: request?.id ?? null,
        error: { code: -32600, message: "Invalid Request: jsonrpc must be '2.0'" },
      });
    }

    // Notifications (no id)
    if (request.id === undefined || request.id === null) {
      if (request.method === "notifications/initialized") {
        // Client ACK, do nothing
      }
      return null;
    }

    const { id, method, params } = request;

    switch (method) {
      case "initialize": {
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {
                listChanged: false,
              },
            },
            serverInfo: {
              name: this.name,
              version: this.version,
            },
          },
        };
        return JSON.stringify(response);
      }

      case "ping": {
        return JSON.stringify({ jsonrpc: "2.0", id, result: {} });
      }

      case "tools/list": {
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            tools: this.getTools(),
          },
        };
        return JSON.stringify(response);
      }

      case "tools/call": {
        const toolName = String(params?.name || "");
        const toolArgs = (params?.arguments as Record<string, any>) || {};

        const registered = this.tools.get(toolName);
        if (!registered) {
          return JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method / tool not found: ${toolName}`,
            },
          });
        }

        try {
          const result = await registered.handler(toolArgs);
          const response: JsonRpcResponse = {
            jsonrpc: "2.0",
            id,
            result,
          };
          return JSON.stringify(response);
        } catch (err: any) {
          const response: JsonRpcResponse = {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Tool execution error: ${err.message || String(err)}` }],
            },
          };
          return JSON.stringify(response);
        }
      }

      default: {
        return JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not supported: ${method}`,
          },
        });
      }
    }
  }

  public listenStdio(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    process.stderr.write(`[Kiro-MCP] Server started (@javargasm/opencode-kiro-auth v${this.version})\n`);

    rl.on("line", async (line) => {
      const response = await this.handleMessage(line);
      if (response) {
        process.stdout.write(`${response}\n`);
      }
    });

    rl.on("close", () => {
      process.exit(0);
    });
  }
}
