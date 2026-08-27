import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { McpServer } from "../src/mcp/server.js";
import { awsTool, setAwsSpawnRunner, resetAwsSpawnRunner } from "../src/mcp/tools/aws.js";
import { webFetchTool } from "../src/mcp/tools/web-fetch.js";
import { usageTool } from "../src/mcp/tools/usage.js";
import { checkpointTool } from "../src/mcp/tools/checkpoint.js";
import * as serverModule from "../src/server.js";

describe("Model Context Protocol (MCP) Server & Tools Coverage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetAwsSpawnRunner();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAwsSpawnRunner();
  });

  describe("McpServer Core Protocol Handling", () => {
    it("handles initialize handshake and returns protocol version & tools capability", async () => {
      const server = new McpServer("test-server", "1.0.0");
      const resStr = await server.handleMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "opencode", version: "1.0.0" },
          },
        })
      );

      expect(resStr).not.toBeNull();
      const res = JSON.parse(resStr!);
      expect(res.jsonrpc).toBe("2.0");
      expect(res.id).toBe(1);
      expect(res.result.protocolVersion).toBe("2024-11-05");
      expect(res.result.capabilities.tools).toBeDefined();
      expect(res.result.serverInfo.name).toBe("test-server");
      expect(res.result.serverInfo.version).toBe("1.0.0");
    });

    it("handles ping method", async () => {
      const server = new McpServer();
      const resStr = await server.handleMessage(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })
      );
      const res = JSON.parse(resStr!);
      expect(res.id).toBe(2);
      expect(res.result).toEqual({});
    });

    it("lists all registered native tools in tools/list", async () => {
      const server = new McpServer();
      const resStr = await server.handleMessage(
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })
      );

      const res = JSON.parse(resStr!);
      expect(res.id).toBe(3);
      const tools = res.result.tools;
      expect(Array.isArray(tools)).toBe(true);

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain("use_aws");
      expect(toolNames).toContain("web_fetch");
      expect(toolNames).toContain("kiro_usage");
      expect(toolNames).toContain("kiro_checkpoint");
    });

    it("returns null for empty or whitespace messages", async () => {
      const server = new McpServer();
      expect(await server.handleMessage("")).toBeNull();
      expect(await server.handleMessage("   \n\t  ")).toBeNull();
    });

    it("returns -32700 Parse error for invalid JSON", async () => {
      const server = new McpServer();
      const resStr = await server.handleMessage("{ invalid json");
      const res = JSON.parse(resStr!);
      expect(res.error.code).toBe(-32700);
      expect(res.error.message).toContain("Parse error");
    });

    it("returns -32600 Invalid Request when jsonrpc is missing or not '2.0'", async () => {
      const server = new McpServer();
      const resStr = await server.handleMessage(JSON.stringify({ id: 1, method: "ping" }));
      const res = JSON.parse(resStr!);
      expect(res.error.code).toBe(-32600);
      expect(res.error.message).toContain("jsonrpc must be '2.0'");
    });

    it("handles notifications (no id) such as notifications/initialized silently", async () => {
      const server = new McpServer();
      const resStr = await server.handleMessage(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      );
      expect(resStr).toBeNull();
    });

    it("returns -32601 error for unknown tool call", async () => {
      const server = new McpServer();
      const resStr = await server.handleMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "non_existent_tool", arguments: {} },
        })
      );

      const res = JSON.parse(resStr!);
      expect(res.id).toBe(4);
      expect(res.error.code).toBe(-32601);
    });

    it("returns -32601 error for unsupported JSON-RPC method", async () => {
      const server = new McpServer();
      const resStr = await server.handleMessage(
        JSON.stringify({ jsonrpc: "2.0", id: 5, method: "unsupported/method" })
      );
      const res = JSON.parse(resStr!);
      expect(res.id).toBe(5);
      expect(res.error.code).toBe(-32601);
    });

    it("handles tool handler exceptions gracefully returning isError in result", async () => {
      const server = new McpServer();
      server.registerTool({
        tool: {
          name: "throwing_tool",
          description: "Throws an error",
          inputSchema: { type: "object", properties: {} },
        },
        handler: () => {
          throw new Error("Simulated tool crash");
        },
      });

      const resStr = await server.handleMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "throwing_tool", arguments: {} },
        })
      );

      const res = JSON.parse(resStr!);
      expect(res.id).toBe(6);
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0]!.text).toContain("Simulated tool crash");
    });
  });

  describe("use_aws Tool", () => {
    function createMockChildProcess() {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    }

    it("requires service_name and operation_name", async () => {
      const res1 = await awsTool.handler({});
      expect(res1.isError).toBe(true);
      expect(res1.content[0]!.text).toContain("service_name and operation_name are required");

      const res2 = await awsTool.handler({ service_name: "s3" });
      expect(res2.isError).toBe(true);

      const res3 = await awsTool.handler({ operation_name: "list-buckets" });
      expect(res3.isError).toBe(true);
    });

    it("formats service, operation, positional args, and parameters properly", async () => {
      let capturedArgs: any;
      setAwsSpawnRunner(((_cmd: any, args: any) => {
        capturedArgs = args;
        const child = createMockChildProcess();
        process.nextTick(() => {
          expect(args).toContain("s3api");
          expect(args).toContain("list-objects-v2");
          expect(args).toContain("my-bucket");
          expect(args).toContain("--prefix");
          expect(args).toContain("photos/");
          expect(args).toContain("--max-items");
          expect(args).toContain("100");
          expect(args).toContain("--fetch-owner");
          child.stdout.emit("data", Buffer.from(JSON.stringify({ Contents: [] })));
          child.emit("close", 0);
        });
        return child;
      }) as any);

      const res = await awsTool.handler({
        service_name: "--s3api",
        operation_name: "list-objects-v2",
        positional_args: ["my-bucket"],
        parameters: {
          prefix: "photos/",
          max_items: 100,
          fetch_owner: true,
          skip_me: false,
        },
      });

      expect(capturedArgs).toBeDefined();
      expect(res.isError).toBeUndefined();
      expect(res.content[0]!.text).toContain("Contents");
    });

    it("handles command success with empty output", async () => {
      setAwsSpawnRunner((() => {
        const child = createMockChildProcess();
        process.nextTick(() => {
          child.emit("close", 0);
        });
        return child;
      }) as any);

      const res = await awsTool.handler({
        service_name: "s3",
        operation_name: "mb",
        positional_args: ["s3://my-bucket"],
      });

      expect(res.content[0]!.text).toContain("Command executed successfully with no output");
    });

    it("surfaces CLI execution errors when exit code is non-zero", async () => {
      setAwsSpawnRunner((() => {
        const child = createMockChildProcess();
        process.nextTick(() => {
          child.stderr.emit("data", Buffer.from("An error occurred (NoSuchBucket) when calling the ListObjectsV2 operation"));
          child.emit("close", 254);
        });
        return child;
      }) as any);

      const res = await awsTool.handler({
        service_name: "s3api",
        operation_name: "list-objects-v2",
        parameters: { bucket: "invalid-bucket" },
      });

      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("AWS CLI command failed (exit code 254)");
      expect(res.content[0]!.text).toContain("NoSuchBucket");
    });

    it("handles missing 'aws' executable (ENOENT) with helpful instructions", async () => {
      setAwsSpawnRunner((() => {
        const child = createMockChildProcess();
        process.nextTick(() => {
          const err: any = new Error("spawn aws ENOENT");
          err.code = "ENOENT";
          child.emit("error", err);
        });
        return child;
      }) as any);

      const res = await awsTool.handler({
        service_name: "sts",
        operation_name: "get-caller-identity",
      });

      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("'aws' CLI executable was not found in PATH");
    });

    it("handles generic spawn errors", async () => {
      setAwsSpawnRunner((() => {
        const child = createMockChildProcess();
        process.nextTick(() => {
          child.emit("error", new Error("Permission denied"));
        });
        return child;
      }) as any);

      const res = await awsTool.handler({
        service_name: "sts",
        operation_name: "get-caller-identity",
      });

      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("Error executing AWS command: Permission denied");
    });
  });

  describe("web_fetch Tool", () => {
    it("rejects missing url", async () => {
      const res = await webFetchTool.handler({});
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("URL parameter is required");
    });

    it("rejects malformed URL strings", async () => {
      const res = await webFetchTool.handler({ url: "http://[invalid-url" });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("Invalid URL");
    });

    it("handles HTTP error status responses", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Not Found", { status: 404, statusText: "Not Found" })
      );

      const res = await webFetchTool.handler({ url: "https://example.com/missing" });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("HTTP Error 404 Not Found");
    });

    it("handles network failure exceptions", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Connection reset by peer"));

      const res = await webFetchTool.handler({ url: "https://example.com/timeout" });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("Failed to fetch URL");
      expect(res.content[0]!.text).toContain("Connection reset by peer");
    });

    it("converts rich HTML to clean Markdown with headings, code, links, and entity decoding", async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
          <head><style>.btn { color: red; }</style></head>
          <body>
            <script>console.log("tracker");</script>
            <nav><a href="/home">Home</a></nav>
            <h1>Main Title</h1>
            <h2>Subtitle Section</h2>
            <h3>Minor Heading</h3>
            <h4>Sub-heading</h4>
            <p>Welcome to our &quot;Awesome&quot; platform &amp; API &lt;v2&gt; &#39;test&#39;.</p>
            <p>Paragraph with a <a href="https://example.com/api">Direct Link</a> and a<br>break.</p>
            <pre><code>const a = 10;
console.log(a);</code></pre>
            <p>Use inline <code>console.log()</code>.</p>
            <ul>
              <li>Item 1</li>
              <li>Item 2</li>
            </ul>
            <form><input type="text"/></form>
            <footer>Copyright 2026</footer>
          </body>
        </html>
      `;

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(mockHtml, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      );

      const res = await webFetchTool.handler({
        url: "https://example.com/docs",
        mode: "full",
      });

      expect(res.isError).toBeUndefined();
      const text = res.content[0]!.text;
      expect(text).toContain("# Main Title");
      expect(text).toContain("## Subtitle Section");
      expect(text).toContain('Welcome to our "Awesome" platform & API <v2> \'test\'.');
      expect(text).toContain("[Direct Link](https://example.com/api)");
      expect(text).toContain("```\nconst a = 10;\nconsole.log(a);\n```");
      expect(text).toContain("`console.log()`");
      expect(text).toContain("* Item 1");
      expect(text).not.toContain("<script>");
      expect(text).not.toContain("console.log(\"tracker\");");
      expect(text).not.toContain("<nav>");
      expect(text).not.toContain("<footer>");
    });

    it("truncates long content in truncated mode", async () => {
      const longText = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(250);
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(longText, { status: 200, headers: { "content-type": "text/plain" } })
      );

      const res = await webFetchTool.handler({
        url: "https://example.com/long",
        mode: "truncated",
      });

      expect(res.content[0]!.text).toContain("Content truncated at 8,000 characters");
      expect(res.content[0]!.text.length).toBeLessThan(8500);
    });

    it("returns selective matches when search terms match specific paragraphs", async () => {
      const mockDoc = [
        "# Section 1: Introduction",
        "This is an intro to the product.",
        "# Section 2: Authentication",
        "Authentication is done via Bearer tokens in headers.",
        "# Section 3: Billing & Rates",
        "We offer standard pricing at $0.002 per token.",
        "# Section 4: Contact",
        "Contact support at help@example.com.",
      ].join("\n\n");

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(mockDoc, { status: 200, headers: { "content-type": "text/plain" } })
      );

      const res = await webFetchTool.handler({
        url: "https://example.com/guide",
        mode: "selective",
        search_terms: ["pricing", "Bearer tokens"],
      });

      expect(res.content[0]!.text).toContain("Selective Content Matches");
      expect(res.content[0]!.text).toContain("Authentication is done via Bearer tokens");
      expect(res.content[0]!.text).toContain("We offer standard pricing");
    });

    it("returns document preview when selective search terms have no matches", async () => {
      const mockDoc = "Welcome to our documentation. All features are covered here.";
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(mockDoc, { status: 200, headers: { "content-type": "text/plain" } })
      );

      const res = await webFetchTool.handler({
        url: "https://example.com/guide",
        mode: "selective",
        search_terms: ["nonexistent_keyword_xyz"],
      });

      expect(res.content[0]!.text).toContain("No direct matches found for search terms");
      expect(res.content[0]!.text).toContain("Welcome to our documentation");
    });
  });

  describe("kiro_usage Tool", () => {
    it("formats account limits, credits, percentage, and reset duration", async () => {
      vi.spyOn(serverModule, "fetchKiroUsageLimits").mockResolvedValueOnce({
        percentage: 45.5,
        creditsUsed: 227.5,
        creditsTotal: 500,
        planTitle: "Kiro Pro",
        monthlyResetsIn: "14d 6h",
      });

      const res = await usageTool.handler({ force: true });
      expect(res.isError).toBeUndefined();
      expect(res.content[0]!.text).toContain("## Kiro Account Usage & Limits");
      expect(res.content[0]!.text).toContain("**Plan**: Kiro Pro");
      expect(res.content[0]!.text).toContain("**Usage Percentage**: 45.5%");
      expect(res.content[0]!.text).toContain("**Credits**: 227.50 / 500.00");
      expect(res.content[0]!.text).toContain("**Monthly Reset In**: 14d 6h");
    });

    it("displays unlimited/unmetered when credits total is missing", async () => {
      vi.spyOn(serverModule, "fetchKiroUsageLimits").mockResolvedValueOnce({
        percentage: 0,
        creditsUsed: null as any,
        creditsTotal: null as any,
        planTitle: "Enterprise",
        monthlyResetsIn: null,
      });

      const res = await usageTool.handler({});
      expect(res.content[0]!.text).toContain("**Credits**: Unlimited / Unmetered");
      expect(res.content[0]!.text).toContain("**Monthly Reset In**: N/A");
    });

    it("includes notice when error property is present", async () => {
      vi.spyOn(serverModule, "fetchKiroUsageLimits").mockResolvedValueOnce({
        percentage: 0,
        creditsUsed: 0,
        creditsTotal: 0,
        planTitle: null,
        monthlyResetsIn: null,
        error: "Rate limit exceeded on usage endpoint",
      });

      const res = await usageTool.handler({});
      expect(res.content[0]!.text).toContain("> **Notice**: Rate limit exceeded on usage endpoint");
    });

    it("handles unexpected fetch errors gracefully", async () => {
      vi.spyOn(serverModule, "fetchKiroUsageLimits").mockRejectedValueOnce(new Error("Network timeout"));

      const res = await usageTool.handler({});
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("Failed to fetch Kiro usage limits: Network timeout");
    });
  });

  describe("kiro_checkpoint Tool", () => {
    it("handles action: 'list' in repository", async () => {
      const res = await checkpointTool.handler({ action: "list" });
      expect(res.content[0]!.text).toBeDefined();
    });

    it("handles action: 'diff' requiring checkpoint_id", async () => {
      const res = await checkpointTool.handler({ action: "diff" });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("Error: 'checkpoint_id' parameter is required");
    });

    it("handles action: 'restore' requiring checkpoint_id", async () => {
      const res = await checkpointTool.handler({ action: "restore" });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("Error: 'checkpoint_id' parameter is required");
    });

    it("returns error for unknown action", async () => {
      const res = await checkpointTool.handler({ action: "invalid_action" });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("Unknown action 'invalid_action'");
    });

    it("creates a new workspace checkpoint with action: 'create'", async () => {
      const res = await checkpointTool.handler({
        action: "create",
        message: "Test unit checkpoint",
      });

      expect(res.isError).toBeUndefined();
      expect(res.content[0]!.text).toContain("Checkpoint created successfully");
      expect(res.content[0]!.text).toContain("Test unit checkpoint");
    });
  });
});
