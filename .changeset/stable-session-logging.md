---
"@javargasm/opencode-kiro-auth": minor
---

Stable session headers and opt-in file logging

- Inject `x-session-id` header via the `chat.headers` hook so the gateway derives a stable Kiro `conversationId` from OpenCode's session id — one per conversation, constant across turns and restarts (`opencode -s <id>`)
- Make structured file logging opt-in via `KIRO_FILE_LOG` environment variable (previously always-on). Accepted values: `1`, `true`, `yes`, `on`
- Fix `stream.ts` to gate the `.last-request.json` dump on `isFileLoggingEnabled()` instead of `log.isDebug()`
- Add tests for file-logger, oauth, and kiro-cli protocol sync
