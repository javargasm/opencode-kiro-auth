---
"@javargasm/opencode-kiro-auth": minor
---

Shared gateway (protocol v3), account-specific model catalog, native Kiro effort levels, reasoning replay, and Kiro request-body validation fixes.

Gateway:

- Share one compatible local gateway across OpenCode processes while isolating each request's workspace via the `x-opencode-cwd` header, so concurrent clients no longer clobber each other's working directory.
- Add domain-separated gateway auth (protocol v3): HMAC challenge/response and per-request signatures over token, timestamp, and nonce, advertised through capability negotiation.
- Add `probeGateway` / `startOrAttachGateway` so a new process attaches to a compatible running gateway instead of failing to bind the port.

Models:

- Load the account-specific Kiro model catalog before OpenCode builds its provider list, and refresh it per credential set (`loadGatewayModels`, `fetchGatewayModelsForCredentials`, `refreshGatewayModels`).
- Pass through per-request region and profile ARN via dedicated headers instead of relying on process-global state.

Reasoning and efforts:

- Support native Kiro effort levels (`none`, `low`, `medium`, `high`, `xhigh`, `max`) with validation and a dedicated effort header.
- Replay assistant reasoning to Bedrock: text reasoning is replayed only with a valid signature (avoids `THINKING_SIGNATURE_INVALID`), and redacted reasoning is replayed through its opaque `redactedContent` field, keyed by a deterministic per-message UUID.

Fixes:

- Fix `REQUEST_BODY_INVALID`: tool results are only sent as Kiro `json` blocks when the payload is a plain object; top-level arrays and scalars now use bounded text.
- Stop replaying images inside historical user messages (Kiro returns `IMAGE_FORMAT_UNSUPPORTED` for history images) while preserving images on the current message.
- Deduplicate concurrent owner-token refreshes and clear stale credentials to fix token rotation.
