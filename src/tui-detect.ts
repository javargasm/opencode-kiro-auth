// Pure provider-detection helper shared by the TUI bar and its tests.
// Kept in a plain .ts module (no JSX / opentui imports) so it can be unit
// tested without pulling in the opentui native runtime.

/**
 * Resolve the active providerID for a session. The session object carries the
 * currently-selected providerID in runtime; we fall back to the most recent
 * message's providerID when the session field is absent.
 */
export function pickProviderId(session: any, messages: any[]): string | undefined {
  const sp = session?.providerID ?? session?.model?.providerID;
  if (sp) return sp;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const pid = m?.providerID ?? m?.model?.providerID;
    if (pid) return pid;
  }
  return undefined;
}

/** True when the resolved provider is the Kiro provider. */
export function isKiroProvider(session: any, messages: any[]): boolean {
  return pickProviderId(session, messages) === "kiro";
}

/**
 * Extract a providerID from an OpenCode `event` hook payload.
 *
 * Confirmed against the opencode source (packages/plugin + SDK v2 types):
 *   - message.updated / message.removed → properties.info is a Message, which
 *     carries `providerID` on assistant messages.
 *   - session.updated / session.created → properties.info is a Session, whose
 *     runtime shape includes `model.providerID`.
 * OpenCode emits NO dedicated "model selected" event and does not expose the
 * TUI's selected model to plugins, so these events are the only provider
 * signal a server plugin receives — they fire on session restore (once
 * messages hydrate) and when a kiro turn is created.
 *
 * Returns undefined when the event carries no provider hint.
 */
export function providerIdFromEvent(event: any): string | undefined {
  const props = event?.properties;
  if (!props) return undefined;
  const info = props.info;
  return (
    info?.providerID ??
    info?.model?.providerID ??
    props.providerID ??
    props.model?.providerID ??
    undefined
  );
}
