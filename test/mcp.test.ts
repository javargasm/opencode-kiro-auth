import { describe, it, expect, vi } from "vitest";
import { McpServer } from "../src/mcp/server.js";

describe("Model Context Protocol (MCP) Server", () => {
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

  describe("web_fetch tool", () => {
    it("rejects missing url", async () => {
      const server = new McpServer();
      const res = JSON.parse(
        (await server.handleMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 20,
            method: "tools/call",
            params: { name: "web_fetch", arguments: {} },
          })
        ))!
      );
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain("URL parameter is required");
    });

    it("fetches and performs selective extraction with search terms", async () => {
      const server = new McpServer();
      const mockHtml = `
        <html>
          <body>
            <nav>Header Nav</nav>
            <h1>Product Documentation</h1>
            <p>Welcome to our platform overview and getting started guide.</p>
            <h2>Pricing and Plans</h2>
            <p>Our Pro plan costs $20/month with unlimited API calls and dedicated support.</p>
            <h2>Installation</h2>
            <p>Run npm install to install the SDK locally.</p>
            <footer>Footer Links</footer>
          </body>
        </html>
      `;

      vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
        return new Response(mockHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      });

      const res = JSON.parse(
        (await server.handleMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 21,
            method: "tools/call",
            params: {
              name: "web_fetch",
              arguments: {
                url: "https://example.com/docs",
                mode: "selective",
                search_terms: ["pricing", "Pro plan"],
              },
            },
          })
        ))!
      );

      expect(res.result.content[0].text).toContain("Pricing and Plans");
      expect(res.result.content[0].text).toContain("$20/month");
      // Header and Footer should be stripped
      expect(res.result.content[0].text).not.toContain("Header Nav");
      expect(res.result.content[0].text).not.toContain("Footer Links");
    });
  });

  describe("use_aws tool", () => {
    it("requires service_name and operation_name", async () => {
      const server = new McpServer();
      const res = JSON.parse(
        (await server.handleMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 30,
            method: "tools/call",
            params: { name: "use_aws", arguments: { service_name: "s3" } },
          })
        ))!
      );
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain("service_name and operation_name are required");
    });
  });

  describe("kiro_checkpoint tool", () => {
    it("lists checkpoints or reports no checkpoints in current workspace", async () => {
      const server = new McpServer();
      const res = JSON.parse(
        (await server.handleMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 40,
            method: "tools/call",
            params: { name: "kiro_checkpoint", arguments: { action: "list" } },
          })
        ))!
      );
      expect(res.result.content[0].text).toBeDefined();
    });
  });
});
