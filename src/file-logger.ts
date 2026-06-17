// Dedicated file logger for debugging Kiro API interactions.
//
// Writes to /tmp/kiro-logs/{requests,responses,errors}.log.
// Enabled by setting KIRO_FILE_LOG=1. Each entry is a timestamped JSON line.
// Files are created/appended on first write; safe to delete mid-session.

import { appendFileSync, mkdirSync } from "node:fs";

const LOG_DIR = "/tmp/kiro-logs";
const REQUESTS_FILE = `${LOG_DIR}/requests.log`;
const RESPONSES_FILE = `${LOG_DIR}/responses.log`;
const ERRORS_FILE = `${LOG_DIR}/errors.log`;

let dirEnsured = false;

// TODO: gate behind KIRO_FILE_LOG=1 env var once the thinking signature bug is resolved
function isEnabled(): boolean {
  return true;
}

function ensureDir(): void {
  if (dirEnsured) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    dirEnsured = true;
  } catch {
    // Best-effort; /tmp should always be writable.
  }
}

function writeLine(file: string, data: Record<string, unknown>): void {
  if (!isEnabled()) return;
  ensureDir();
  const entry = {
    ts: new Date().toISOString(),
    ...data,
  };
  try {
    appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    // Silent — debug logging should never crash the provider.
  }
}

/** Log the full request body sent to Kiro API. */
export function logRequest(meta: {
  endpoint: string;
  model: string;
  historyLength: number;
  requestBodyChars: number;
  attempt: number;
  conversationId: string;
}, requestBody: string): void {
  writeLine(REQUESTS_FILE, {
    type: "request",
    ...meta,
    body: safeParseJson(requestBody),
  });
}

/** Log a parsed response event from the Kiro stream. */
export function logResponseEvent(event: {
  type: string;
  data: unknown;
  eventSeq: number;
}): void {
  writeLine(RESPONSES_FILE, {
    type: "response_event",
    eventType: event.type,
    seq: event.eventSeq,
    data: event.data,
  });
}

/** Log the final response summary when the stream completes. */
export function logResponseDone(meta: {
  stopReason: string;
  emittedToolCalls: number;
  usage: unknown;
  contentBlocks: number;
  model: string;
}): void {
  writeLine(RESPONSES_FILE, {
    type: "response_done",
    ...meta,
  });
}

/** Log HTTP error responses from the Kiro API. */
export function logHttpError(meta: {
  status: number;
  statusText: string;
  body: string;
  endpoint: string;
  model: string;
  attempt: number;
  historyLength: number;
}): void {
  writeLine(ERRORS_FILE, {
    type: "http_error",
    ...meta,
  });
}

/** Log stream-level errors (timeouts, parse errors, etc). */
export function logStreamError(meta: {
  error: string;
  context: string;
  model: string;
  attempt: number;
}): void {
  writeLine(ERRORS_FILE, {
    type: "stream_error",
    ...meta,
  });
}

/** Log caught exceptions from the top-level try/catch. */
export function logCaughtError(meta: {
  stopReason: string;
  errorMessage: string;
  model: string;
}): void {
  writeLine(ERRORS_FILE, {
    type: "caught_error",
    ...meta,
  });
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
