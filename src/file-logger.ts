// Dedicated file logger for debugging Kiro API interactions.
//
// All entry types (requests, responses, errors) for a single session are
// written to ONE file:  /tmp/kiro-logs/session-{id}.log
// Each line is a timestamped JSON object distinguished by its `type` field.
// This keeps every turn of a conversation grouped together regardless of
// which client (OpenCode, Claude Code, …) drove it.
//
// Files are created/appended on first write; safe to delete mid-session.

import { appendFileSync, mkdirSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

/** Root directory for ALL Kiro file logs (session logs, debug log, request dumps). */
export const LOG_DIR = "/tmp/kiro-logs";

let dirEnsured = false;

// TODO: gate behind KIRO_FILE_LOG=1 env var once the thinking signature bug is resolved
function isEnabled(): boolean {
  return true;
}

/** Ensure LOG_DIR exists. Best-effort and memoized; safe to call on every write. */
export function ensureLogDir(): void {
  if (dirEnsured) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    dirEnsured = true;
  } catch {
    // Best-effort; /tmp should always be writable.
  }
}

/**
 * Sanitize an arbitrary session identifier into a filesystem-safe slug.
 * Keeps logs grouped per session while preventing path traversal and
 * over-long names.
 */
function sanitizeSessionId(id: string): string {
  const slug = id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return slug.length > 0 ? slug : "default";
}

// ---- Per-session log routing (AsyncLocalStorage) ------------------------
//
// The leveled debug logger (debug.ts) is global and stateless, but during a
// request we want its output to land in that request's `session-{id}.log`
// alongside the structured entries. We thread the active session file through
// an AsyncLocalStorage so any `log.*()` call made within an `enterSessionLog`
// scope — including those inside streamKiro's detached async IIFE, which
// captures the context at creation time — resolves to the right file.

interface SessionLogContext {
  file: string;
  sessionId: string;
}

const sessionLogStore = new AsyncLocalStorage<SessionLogContext>();

/** File path of the session log active in the current async context, if any. */
export function currentSessionLogFile(): string | null {
  return sessionLogStore.getStore()?.file ?? null;
}

/**
 * Bind the given session id to the CURRENT async context (and its
 * continuations). Every subsequent `log.*()` in this request — including those
 * in the detached streamKiro IIFE and the SSE ReadableStream, both created
 * synchronously after this call — routes to `session-{id}.log`. Each request
 * runs in its own async context, so concurrent requests don't interfere.
 * Returns the sanitized id actually used.
 */
export function enterSessionLog(sessionId: string | undefined): string {
  const id = sanitizeSessionId(sessionId ?? "default");
  sessionLogStore.enterWith({ file: `${LOG_DIR}/session-${id}.log`, sessionId: id });
  return id;
}

function writeLine(file: string, data: Record<string, unknown>): void {
  if (!isEnabled()) return;
  ensureLogDir();
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

export interface SessionLogger {
  /** Absolute path of the file this logger writes to. */
  readonly file: string;
  /** Sanitized session id used in the filename. */
  readonly sessionId: string;

  /** Log the full request body sent to Kiro API. */
  logRequest(
    meta: {
      endpoint: string;
      model: string;
      historyLength: number;
      requestBodyChars: number;
      attempt: number;
      conversationId: string;
    },
    requestBody: string,
  ): void;

  /** Log a parsed response event from the Kiro stream. */
  logResponseEvent(event: { type: string; data: unknown; eventSeq: number }): void;

  /** Log the final response summary when the stream completes. */
  logResponseDone(meta: {
    stopReason: string;
    emittedToolCalls: number;
    usage: unknown;
    contentBlocks: number;
    model: string;
  }): void;

  /** Log HTTP error responses from the Kiro API. */
  logHttpError(meta: {
    status: number;
    statusText: string;
    body: string;
    endpoint: string;
    model: string;
    attempt: number;
    historyLength: number;
  }): void;

  /** Log stream-level errors (timeouts, parse errors, etc). */
  logStreamError(meta: { error: string; context: string; model: string; attempt: number }): void;

  /** Log caught exceptions from the top-level try/catch (with full error). */
  logCaughtError(
    meta: { stopReason: string; errorMessage: string; model: string },
    error?: unknown,
  ): void;
}

/**
 * Create a logger bound to a single session. Pass a stable id (conversation
 * id, client session id, …) so all turns share one file. When no id is given
 * every logger gets its own `session-default.log`.
 */
export function createSessionLogger(sessionId?: string): SessionLogger {
  const id = sanitizeSessionId(sessionId ?? "default");
  const file = `${LOG_DIR}/session-${id}.log`;

  // Every entry carries `sessionId` so a single line is self-describing even
  // when copied out of its file. `ts` (from writeLine) comes first, then
  // sessionId, then the type-specific payload.
  const emit = (data: Record<string, unknown>) => writeLine(file, { sessionId: id, ...data });

  return {
    file,
    sessionId: id,

    logRequest(meta, requestBody) {
      emit({
        type: "request",
        ...meta,
        body: safeParseJson(requestBody),
      });
    },

    logResponseEvent(event) {
      emit({
        type: "response_event",
        eventType: event.type,
        seq: event.eventSeq,
        data: event.data,
      });
    },

    logResponseDone(meta) {
      emit({ type: "response_done", ...meta });
    },

    logHttpError(meta) {
      emit({ type: "http_error", ...meta });
    },

    logStreamError(meta) {
      emit({ type: "stream_error", ...meta });
    },

    logCaughtError(meta, error) {
      emit({
        type: "caught_error",
        ...meta,
        error: error === undefined ? undefined : serializeError(error),
      });
    },
  };
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Recursively serialize an Error into a plain object, preserving the
 * stack trace and the full `cause` chain. Plain `JSON.stringify(error)`
 * drops `name`, `message`, and `stack` because they are non-enumerable,
 * which is why caught errors previously logged as `{}` or message-only.
 */
function serializeError(error: unknown, depth = 0): unknown {
  if (depth > 5) return "[cause chain truncated]";
  if (error instanceof Error) {
    const out: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    if (error.cause !== undefined) {
      out.cause = serializeError(error.cause, depth + 1);
    }
    // Capture any extra enumerable own-properties (e.g. status, code).
    for (const key of Object.keys(error)) {
      if (!(key in out)) out[key] = (error as unknown as Record<string, unknown>)[key];
    }
    return out;
  }
  if (error && typeof error === "object") return error;
  return String(error);
}
