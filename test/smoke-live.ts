/**
 * Live smoke test: send a real request to the Kiro API using credentials
 * from ~/.pi/agent/auth.json and verify that sanitizeHistory prevents
 * TOOL_DUPLICATE and TOOL_USE_RESULT_MISMATCH errors.
 *
 * Usage:  bun run test/smoke-live.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { streamKiro } from "../src/stream";
import { seedProfileArn } from "../src/models";
import type { AssistantMessage, AssistantMessageEvent, Context, ToolResultMessage } from "../src/types";

// ---- Read auth.json ----
const authPath = join(homedir(), ".pi", "agent", "auth.json");
let authData: Record<string, any>;
try {
  authData = JSON.parse(readFileSync(authPath, "utf-8"));
} catch (e) {
  console.error("❌ Cannot read ~/.pi/agent/auth.json — run 'kiro login' first");
  process.exit(1);
}

const kiro = authData.kiro;
if (!kiro?.access) {
  console.error("❌ No kiro credentials in auth.json — run 'kiro login' first");
  process.exit(1);
}

const accessToken = kiro.access as string;
const profileArn = kiro.profileArn as string;
const region = (kiro.region as string) || "us-east-1";

const API_REGION_MAP: Record<string, string> = {
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "us-west-2": "us-east-1",
};
const apiRegion = API_REGION_MAP[region] ?? region;
const baseUrl = `https://runtime.${apiRegion}.kiro.dev`;

console.log(`🔑 Credentials loaded: region=${region} → apiRegion=${apiRegion}`);
console.log(`🔗 Endpoint: ${baseUrl}`);
console.log(`🧑 Profile: ${profileArn}`);

seedProfileArn(profileArn);

// ---- Helpers ----
const ts = Date.now();
const zeroUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): Context["messages"][number] {
  return { role: "user" as const, content: text, timestamp: ts };
}

function assistant(text: string, toolCalls: Array<{id: string; name: string; args: Record<string, unknown>}>): AssistantMessage {
  return {
    role: "assistant" as const,
    content: [
      { type: "text" as const, text },
      ...toolCalls.map(tc => ({
        type: "toolCall" as const,
        id: tc.id,
        name: tc.name,
        arguments: tc.args,
      })),
    ],
    api: "kiro-api" as const,
    provider: "kiro" as const,
    model: "claude-haiku-4-5",
    usage: zeroUsage,
    stopReason: "toolUse" as const,
    timestamp: ts,
  };
}

function toolResult(id: string, text: string): ToolResultMessage {
  return {
    role: "toolResult" as const,
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: ts,
  };
}

async function collect(stream: ReturnType<typeof streamKiro>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) {
    events.push(e);
    if (e.type === "done" || e.type === "error") return events;
  }
  return events;
}

// Minimal tool definitions — Bedrock requires toolConfig when tool_use/
// tool_result blocks exist in the history.
const smokeTools = [
  {
    name: "bash",
    description: "Run a shell command",
    parameters: {
      type: "object" as const,
      properties: {
        cmd: { type: "string", description: "The command to run" },
      },
      required: ["cmd"],
    },
  },
];

// ---- Test scenarios ----
const tests = [
  {
    name: "1. Normal agentic loop (baseline)",
    context: {
      systemPrompt: "You are a test assistant. Reply with one short sentence.",
      messages: [
        user("What is 2+2?"),
        assistant("Let me check", [{ id: "tooluse_AAA111", name: "bash", args: { cmd: "echo 4" } }]),
        toolResult("tooluse_AAA111", "4"),
        user("Thanks, now what is 3+3?"),
      ],
      tools: smokeTools,
    } as Context,
  },
  {
    name: "2. Cross-provider IDs (non-Kiro format → canonicalized)",
    context: {
      systemPrompt: "You are a test assistant. Reply with one short sentence.",
      messages: [
        user("Check something"),
        assistant("Let me look", [
          { id: "call_abc123|fc_def456", name: "bash", args: { cmd: "ls" } },
        ]),
        toolResult("call_abc123|fc_def456", "file1.ts file2.ts"),
        user("What did you find?"),
      ],
      tools: smokeTools,
    } as Context,
  },
  {
    name: "3. Orphan toolUse (missing result — sanitized away)",
    context: {
      systemPrompt: "You are a test assistant. Reply with one short sentence.",
      messages: [
        user("Do two things"),
        assistant("Running tools", [
          { id: "tooluse_RUN1", name: "bash", args: { cmd: "ls" } },
        ]),
        toolResult("tooluse_RUN1", "ok"),
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "Now doing more..." },
            { type: "toolCall" as const, id: "tooluse_ORPHAN", name: "bash", arguments: { cmd: "pwd" } },
          ],
          api: "kiro-api" as const,
          provider: "kiro" as const,
          model: "claude-haiku-4-5",
          usage: zeroUsage,
          stopReason: "stop" as const,
          timestamp: ts,
        },
        user("Continue please"),
      ],
      tools: smokeTools,
    } as Context,
  },
];

// ---- Run ----
const model = {
  id: "claude-haiku-4-5" as const,
  name: "Claude Haiku 4.5",
  api: "kiro-api" as const,
  provider: "kiro" as const,
  baseUrl,
  reasoning: false,
  input: ["text" as const, "image" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 65_536,
};

let passed = 0;
let failed = 0;

for (const test of tests) {
  process.stdout.write(`\n🧪 ${test.name}... `);
  try {
    const events = await collect(streamKiro(model, test.context, { apiKey: accessToken }));
    const error = events.find(e => e.type === "error");
    const done = events.find(e => e.type === "done");

    if (error && error.type === "error") {
      const msg = error.error.errorMessage ?? "";
      if (msg.includes("TOOL_DUPLICATE") || msg.includes("TOOL_USE_RESULT_MISMATCH")) {
        console.log(`❌ FAILED — Bedrock validation error:\n  ${msg}`);
        failed++;
      } else if (msg.includes("ThrottlingException") || msg.includes("429")) {
        console.log(`⚠️  THROTTLED — ${msg} (not a bug)`);
      } else {
        console.log(`❌ FAILED — unexpected error:\n  ${msg}`);
        failed++;
      }
    } else if (done && done.type === "done") {
      const text = done.message.content
        .filter(b => b.type === "text")
        .map(b => (b as {type: "text"; text: string}).text)
        .join("");
      console.log(`✅ PASSED — response: "${text.slice(0, 80)}"`);
      passed++;
    } else {
      console.log(`❌ FAILED — no done or error event`);
      failed++;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`❌ FAILED — exception: ${msg.slice(0, 120)}`);
    failed++;
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
process.exit(failed > 0 ? 1 : 0);
