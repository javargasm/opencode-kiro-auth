#!/usr/bin/env bun
/**
 * E2E test: multi-turn reasoning pipeline.
 *
 * Mirrors the real Kiro CLI flow:
 *   Turn 1 → user asks a question with tools → model replies with tool_use
 *   Turn 2 → user sends tool_result → model processes and (ideally) reasons
 *
 * The real Kiro CLI capture shows reasoningContentEvent appearing on turn 2
 * when the model has tool results to process. This test validates the full
 * round-trip through the gateway.
 *
 * Usage: bun test/e2e-reasoning.ts
 */

import { startGatewayServer, _seedCredentials } from "../src/server";
import { importFromKiroCli } from "../src/kiro-cli-sync";
import { refreshKiroToken } from "../src/oauth";
import { streamKiro, HIDDEN_REASONING_COUNTDOWN_MS } from "../src/stream";
import { seedProfileArn, resolveApiRegion } from "../src/models";

const PORT = 19876;
const BASE = `http://127.0.0.1:${PORT}`;

// Tools matching the real Kiro CLI tool set
const TOOLS = [
  {
    name: "bash",
    description: "Executes a shell command in a persistent session. Use for system operations, builds, tests, and file manipulation.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        __tool_use_purpose: { type: "string", description: "A brief explanation why you are making this tool use." },
      },
      required: ["command"],
    },
  },
  {
    name: "read",
    description: "Read file contents, list directories, or view images.",
    input_schema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              mode: { type: "string", enum: ["File", "Directory"] },
              depth: { type: "integer" },
            },
          },
        },
        __tool_use_purpose: { type: "string", description: "A brief explanation why you are making this tool use." },
      },
      required: ["operations"],
    },
  },
  {
    name: "write",
    description: "Create or edit text files.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", enum: ["create", "strReplace", "insert"] },
        path: { type: "string" },
        content: { type: "string" },
        __tool_use_purpose: { type: "string", description: "A brief explanation why you are making this tool use." },
      },
      required: ["command", "path"],
    },
  },
  {
    name: "web_search",
    description: "Search the web for information.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query", maxLength: 200 },
        __tool_use_purpose: { type: "string", description: "A brief explanation why you are making this tool use." },
      },
      required: ["query"],
    },
  },
];

interface SSEResult {
  thinkingText: string;
  responseText: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: string;
  sawThinkingStart: boolean;
  eventCount: number;
}

/** Parse a streaming SSE response into structured results. */
async function parseSSE(resp: Response, label: string): Promise<SSEResult> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  const result: SSEResult = {
    thinkingText: "",
    responseText: "",
    toolCalls: [],
    stopReason: "",
    sawThinkingStart: false,
    eventCount: 0,
  };

  let currentToolCall: { id: string; name: string; input: string } | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });

    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop()!;

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const dataStr = line.substring(6).trim();
      if (dataStr === "[DONE]") continue;

      try {
        const event = JSON.parse(dataStr);
        result.eventCount++;

        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block?.type === "thinking") {
            result.sawThinkingStart = true;
          } else if (block?.type === "tool_use") {
            currentToolCall = { id: block.id, name: block.name, input: "" };
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta?.type === "thinking_delta") {
            result.thinkingText += delta.thinking;
          } else if (delta?.type === "text_delta") {
            result.responseText += delta.text;
          } else if (delta?.type === "input_json_delta" && currentToolCall) {
            currentToolCall.input += delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          if (currentToolCall) {
            try {
              result.toolCalls.push({
                id: currentToolCall.id,
                name: currentToolCall.name,
                input: currentToolCall.input ? JSON.parse(currentToolCall.input) : {},
              });
            } catch {
              result.toolCalls.push({
                id: currentToolCall.id,
                name: currentToolCall.name,
                input: { raw: currentToolCall.input },
              });
            }
            currentToolCall = null;
          }
        } else if (event.type === "message_delta") {
          result.stopReason = event.delta?.stop_reason || "";
        }
      } catch {
        // skip non-JSON
      }
    }
  }

  console.log(`  [${label}] events=${result.eventCount} thinking=${result.thinkingText.length}c text=${result.responseText.length}c tools=${result.toolCalls.length} stop=${result.stopReason}`);
  return result;
}

async function main() {
  console.log("▶ Importing and refreshing Kiro credentials…");
  const imported = await importFromKiroCli();
  if (!imported) {
    console.error("✗ No Kiro credentials found. Run /login kiro first.");
    process.exit(1);
  }

  const parts = [imported.refreshToken, imported.clientId || "", imported.clientSecret || "", imported.authMethod].join("|");
  const fresh = await refreshKiroToken(parts, imported.region, imported.authMethod);
  console.log("✓ Token refreshed, expires:", new Date(fresh.expires).toISOString());

  _seedCredentials(fresh.access, imported.region);

  const apiRegion = resolveApiRegion(imported.region);
  const runtimeUrl = `https://runtime.${apiRegion}.kiro.dev/`;
  if (imported.profileArn) {
    seedProfileArn(imported.profileArn, fresh.access, apiRegion);
    console.log("✓ ProfileArn seeded:", imported.profileArn.substring(0, 50) + "…");
  }

  console.log("▶ Starting gateway on port", PORT);
  const server = await startGatewayServer(PORT);

  const health = await fetch(`${BASE}/health`);
  if (health.status !== 200) {
    console.error("✗ Health check failed:", health.status);
    server.stop();
    process.exit(1);
  }
  console.log("✓ Health OK\n");

  const headers = { "Content-Type": "application/json" };

  // ── TURN 1: User asks, expects tool_use ────────────────────────────
  console.log("═══ TURN 1: User → tool_use ═══");
  const turn1Body = {
    model: "claude-opus-4-8",
    max_tokens: 4096,
    output_config: { effort: "max" },
    tools: TOOLS,
    messages: [
      {
        role: "user",
        content: "dame un resumen completo del directorio actual, piensa paso a paso",
      },
    ],
    stream: true,
  };

  const resp1 = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(turn1Body),
  });

  if (!resp1.ok) {
    const err = await resp1.text();
    console.error("✗ Turn 1 failed:", resp1.status, err.substring(0, 500));
    server.stop();
    process.exit(1);
  }

  const turn1 = await parseSSE(resp1, "Turn1");
  console.log(`  Text: "${turn1.responseText.substring(0, 100)}…"`);
  if (turn1.toolCalls.length > 0) {
    console.log(`  Tool calls: ${turn1.toolCalls.map(t => `${t.name}(${JSON.stringify(t.input).substring(0, 60)})`).join(", ")}`);
  }

  if (turn1.sawThinkingStart) {
    console.log(`  ★ Reasoning on Turn 1! (${turn1.thinkingText.length} chars)`);
    console.log(`  Preview: "${turn1.thinkingText.substring(0, 200)}…"`);
  }

  // If no tool calls, we can't do turn 2. Still check if reasoning appeared.
  if (turn1.toolCalls.length === 0) {
    console.log("\n⚠ No tool calls in Turn 1 — cannot do Turn 2.");
    const pass = turn1.sawThinkingStart || turn1.responseText.length > 0;
    console.log(pass ? "✅ PASS — Got response (no tool use)" : "❌ FAIL");
    server.stop();
    process.exit(pass ? 0 : 1);
  }

  // ── TURN 2: Tool result → reasoning expected ──────────────────────
  console.log("\n═══ TURN 2: tool_result → reasoning? ═══");

  // Build the assistant content blocks from turn 1
  const assistantContent: Array<Record<string, unknown>> = [];
  if (turn1.thinkingText) {
    assistantContent.push({ type: "thinking", thinking: turn1.thinkingText });
  }
  if (turn1.responseText) {
    assistantContent.push({ type: "text", text: turn1.responseText });
  }
  for (const tc of turn1.toolCalls) {
    assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
  }

  // Build tool result messages
  const toolResults = turn1.toolCalls.map(tc => ({
    role: "user" as const,
    content: [
      {
        type: "tool_result" as const,
        tool_use_id: tc.id,
        content: tc.name === "read" || tc.name === "bash"
          ? "total 48\ndrwxr-xr-x  15 user  staff   480 Jun 15 16:30 .\ndrwxr-xr-x   5 user  staff   160 Jun 10 09:00 ..\n-rw-r--r--   1 user  staff   350 Jun 15 16:30 package.json\n-rw-r--r--   1 user  staff  1200 Jun 15 16:30 tsconfig.json\ndrwxr-xr-x   8 user  staff   256 Jun 15 16:30 src\ndrwxr-xr-x   4 user  staff   128 Jun 15 16:30 test\n-rw-r--r--   1 user  staff   850 Jun 15 16:30 README.md"
          : "OK",
      },
    ],
  }));

  const turn2Body = {
    model: "claude-opus-4-8",
    max_tokens: 4096,
    output_config: { effort: "max" },
    tools: TOOLS,
    messages: [
      // Original user message
      { role: "user", content: "dame un resumen completo del directorio actual, piensa paso a paso" },
      // Assistant response with tool calls
      { role: "assistant", content: assistantContent },
      // Tool results
      ...toolResults,
    ],
    stream: true,
  };

  const resp2 = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(turn2Body),
  });

  if (!resp2.ok) {
    const err = await resp2.text();
    console.error("✗ Turn 2 failed:", resp2.status, err.substring(0, 500));
    server.stop();
    process.exit(1);
  }

  const turn2 = await parseSSE(resp2, "Turn2");
  if (turn2.responseText) {
    console.log(`  Text: "${turn2.responseText.substring(0, 200)}…"`);
  }
  if (turn2.sawThinkingStart) {
    console.log(`  ★ Reasoning on Turn 2! (${turn2.thinkingText.length} chars)`);
    console.log(`  Preview: "${turn2.thinkingText.substring(0, 200)}…"`);
  }

  // ── Request verification ─────────────────────────────────────────
  let requestOk = false;
  try {
    const fs = await import("fs");
    const reqDump = JSON.parse(fs.readFileSync("/tmp/kiro-last-request.json", "utf-8"));
    const thinking = reqDump.additionalModelRequestFields?.thinking;
    const effort = reqDump.additionalModelRequestFields?.output_config?.effort;
    const toolCount = reqDump.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools?.length ?? 0;
    const historyLen = reqDump.conversationState?.history?.length ?? 0;
    const hasToolResults = !!reqDump.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults;
    const hasReasoning = reqDump.conversationState?.history?.some(
      (e: Record<string, unknown>) => !!(e as { assistantResponseMessage?: { reasoningContent?: unknown } }).assistantResponseMessage?.reasoningContent,
    );

    console.log(`\nRequest verification (Turn 2):`);
    console.log(`  thinking:        ${thinking === undefined ? "✓ not set (correct)" : "✗ " + JSON.stringify(thinking)}`);
    console.log(`  effort:          ${effort ? "✓ " + effort : "✗ missing"}`);
    console.log(`  tools:           ${toolCount > 0 ? "✓ " + toolCount + " tools" : "✗ no tools"}`);
    console.log(`  history:         ${historyLen} entries`);
    console.log(`  toolResults:     ${hasToolResults ? "✓ present" : "✗ missing"}`);
    console.log(`  reasoningContent: ${hasReasoning ? "✓ in history" : "— not present (no reasoning on turn 1)"}`);
    requestOk = thinking === undefined && !!effort;
  } catch {
    console.log(`\n  ✗ Could not read request dump`);
  }

  // ── Final verdict ─────────────────────────────────────────────────
  console.log("\n═══ SUMMARY ═══");
  console.log(`Turn 1: thinking=${turn1.sawThinkingStart} text=${turn1.responseText.length}c tools=${turn1.toolCalls.length}`);
  console.log(`Turn 2: thinking=${turn2.sawThinkingStart} text=${turn2.responseText.length}c tools=${turn2.toolCalls.length}`);

  const hasAnyReasoning = turn1.sawThinkingStart || turn2.sawThinkingStart;
  const hasAnyOutput = turn1.responseText.length > 0 || turn2.responseText.length > 0 || turn2.toolCalls.length > 0;
  const pass = requestOk && hasAnyOutput;

  if (hasAnyReasoning) {
    const which = turn1.sawThinkingStart && turn2.sawThinkingStart ? "both turns" : turn1.sawThinkingStart ? "turn 1" : "turn 2";
    console.log(`\n★ Reasoning appeared on ${which}!`);
  } else {
    console.log(`\n⚠ No reasoning events on either turn — Kiro may not send them for this session`);
  }

  console.log(`${pass ? "✅ PASS — Multi-turn E2E pipeline works!" : "❌ FAIL"}`);

  server.stop();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
