# @javargasm/opencode-kiro-auth

## 0.2.2

### Patch Changes

- 9123de1: fix: sanitize history to prevent Bedrock TOOL_DUPLICATE and TOOL_USE_RESULT_MISMATCH errors

  Added `sanitizeHistory` defense-in-depth pass that runs after `collapseAgenticLoops`:

  - Deduplicates toolUseIds within each assistant message (prevents TOOL_DUPLICATE)
  - Removes orphan toolUses without matching toolResults (prevents TOOL_USE_RESULT_MISMATCH)
  - Removes orphan toolResults without matching toolUses

  These errors surfaced during retry loops where the same assistant message
  with tool calls could be re-injected into the history.

## 0.2.1

### Patch Changes

- fix: use reasoningContent with signature for thinking history instead of inline XML tags

  Bedrock rejects replayed history with THINKING_SIGNATURE_INVALID when thinking
  blocks use inline `<thinking>` XML tags without the cryptographic signature.
  Now accumulates thinking text and signature from upstream content blocks and
  sends them as proper `reasoningContent.reasoningText` with `text` + `signature`.
  Silently drops reasoning when the signature is missing rather than crashing.

  Also adds opt-in file-based debug logging (KIRO_FILE_LOG) for API interactions.

## 0.1.2

### Patch Changes

- fix: use vitest runner for CI-compatible stream tests

  Switched test runner from `bun test` to `vitest run` for stream tests
  so `vi.spyOn(globalThis, 'fetch')` works reliably in CI (Ubuntu/Node).
  Gateway tests (Bun.serve) remain under `bun test` and run locally.

## 0.1.1

### Patch Changes

- fix: align streaming HTTP headers with real Kiro CLI 2.7.1

  Updated all HTTP headers sent to the CodeWhisperer streaming endpoint to
  match the real Kiro CLI captured via Charles proxy:

  - Corrected `user-agent` format and SDK versions (1.3.15, 0.1.16551, 2.7.1)
  - Set `x-amz-user-agent` to its own value (`m/F` instead of `md/appVersion`)
  - Changed `Accept` from `application/json` to `*/*`
  - Changed `amz-sdk-request` from `max=1` to `max=3`
  - Added `Accept-Encoding: gzip`, `Pragma: no-cache`, `Cache-Control: no-cache`
  - Removed `x-amzn-kiro-agent-mode` (not present in real client)
  - Added stream test suite with 15 tests covering header fidelity
