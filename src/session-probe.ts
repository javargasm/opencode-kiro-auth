// Server-side session probing helpers (pure, unit-tested).
//
// Confirmed against the opencode source:
//   - There is NO "model selected" event; the selected model is TUI-local
//     state (packages/tui/src/context/local.tsx).
//   - The runtime Session object DOES carry `model.providerID` (observed in
//     real session.updated payloads: infoKeys=...,agent,model,...), even though
//     the generated SDK `Session` type omits it.
//   - `client.session.list()` returns Session[] ordered arbitrarily, so we pick
//     the most-recently-updated one as the "active/restored" session.
//
// These helpers extract the provider from those shapes without any I/O so the
// startup-probe logic in index.ts can be tested in isolation.

/** Pick the most-recently-updated session from a session list. */
export function mostRecentSession(sessions: any[]): any | undefined {
  if (!Array.isArray(sessions) || sessions.length === 0) return undefined;
  let best: any = undefined;
  let bestUpdated = -Infinity;
  for (const s of sessions) {
    const updated = s?.time?.updated ?? s?.time?.created ?? 0;
    if (updated >= bestUpdated) {
      bestUpdated = updated;
      best = s;
    }
  }
  return best;
}

/** Extract providerID from a session info object (runtime shape: session.model.providerID). */
export function providerFromSession(session: any): string | undefined {
  return session?.model?.providerID ?? session?.providerID ?? undefined;
}

/**
 * Extract providerID from a messages list (newest-first scan). Accepts both the
 * HTTP shape (`{ info, parts }[]`) and a bare message array. Assistant messages
 * carry `providerID`; user messages do not, so we scan back to the last one
 * that has it.
 */
export function providerFromMessages(messages: any[]): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info ?? messages[i];
    const pid = info?.providerID ?? info?.model?.providerID;
    if (pid) return pid;
  }
  return undefined;
}
