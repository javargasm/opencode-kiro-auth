# @javargasm/opencode-kiro-auth

Kiro provider plugin for [OpenCode](https://opencode.ai). Authenticates via AWS Builder ID or IAM Identity Center and exposes all Kiro models through an Anthropic-compatible local gateway.

## Features

- **AWS Builder ID / IAM Identity Center** — OAuth device-code login with automatic token refresh
- **Dynamic model discovery** — fetches available models from the Kiro API at runtime; falls back to a curated static catalog
- **Credit-aware model names** — appends each Kiro `rateMultiplier` to the model picker label, e.g. `Claude Sonnet 5 (1.3x)`
- **Local Anthropic gateway** — translates Anthropic Messages API requests to Kiro's CodeWhisperer streaming protocol
- **Transport retries** — retries transient socket/proxy disconnects with exponential backoff before any output is streamed
- **Adaptive thinking** — maps reasoning effort levels (`low` → `max`) through the `output_config.effort` parameter
- **Multi-region** — supports `us-east-1` and `eu-central-1` Kiro API regions with automatic SSO region mapping
- **Zero external dependencies** — self-contained plugin; no runtime deps beyond the OpenCode SDK

## Supported Models

| Model | Reasoning | Context | Rate | Effort Levels |
|:---|:---:|:---:|:---:|:---|
| Claude Sonnet 5 | ✅ | 1M | 1.3x | low, medium, high, xhigh, max |
| Claude Opus 4.8 | ✅ | 1M | 2.2x | low, medium, high, xhigh, max |
| Claude Opus 4.7 | ✅ | 1M | 2.2x | low, medium, high, xhigh, max |
| Claude Opus 4.6 | ✅ | 1M | 2.2x | low, medium, high, max |
| Claude Sonnet 4.6 | ✅ | 1M | 1.3x | low, medium, high, max |
| Claude Opus 4.5 | ✅ | 200K | 2.2x | — |
| Claude Sonnet 4.5 | ✅ | 200K | 1.3x | — |
| Claude Sonnet 4 | ✅ | 200K | 1.3x | — |
| Claude Haiku 4.5 | ❌ | 200K | 0.4x | — |
| DeepSeek V3.2 | ✅ | 164K | 0.25x | — |
| MiniMax M2.5 | ❌ | 196K | 0.25x | — |
| MiniMax M2.1 | ❌ | 196K | 0.15x | — |
| GLM-5 | ✅ | 200K | 0.5x | — |
| Qwen3 Coder Next | ✅ | 256K | 0.05x | — |
| Auto | ✅ | 1M | 1x | — |

> Models without effort levels listed use Kiro's default reasoning behavior. Additional models may appear dynamically via the `ListAvailableModels` API. The model picker displays the upstream `rateMultiplier` next to every model returned by the endpoint or fallback catalog. `Claude Fable 5 (disabled)` remains in the fallback catalog for compatibility but is not advertised as an active model.

## Installation

### From npm (recommended)

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@javargasm/opencode-kiro-auth"
  ]
}
```

OpenCode will auto-install the package on startup.

### From local source

1. Clone the repository:

```bash
git clone https://github.com/javargasm/opencode-kiro-auth.git
cd opencode-kiro-auth
```

2. Install dependencies and build:

```bash
bun install
bun run build
```

3. Register the plugin in your `opencode.json` using the absolute path to the built entry point:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "/absolute/path/to/opencode-kiro-auth/dist/index.js"
  ]
}
```

## Authentication

Once the plugin is loaded, authenticate through the OpenCode TUI:

1. Run `/connect` inside OpenCode
2. Select **Kiro (Builder ID / IAM Identity Center)**
3. Choose your login method:
   - **Builder ID** — press Enter at the SSO URL prompt (default)
   - **IAM Identity Center** — enter your organization's SSO Start URL (e.g. `https://mycompany.awsapps.com/start`) and optionally the SSO region
4. Complete the browser-based authorization using the provided verification code
5. Tokens are stored securely and refreshed automatically

## Usage

After authentication, select any Kiro model in the OpenCode model picker. The plugin:

1. Starts a local Anthropic-compatible gateway on a random port
2. Registers all available models as OpenCode provider entries
3. Routes requests through `@ai-sdk/anthropic` → local gateway → Kiro CodeWhisperer API

### Selecting a model

Use the model picker in the OpenCode TUI or set a default in your `opencode.json`:

```json
{
  "model": "kiro/claude-opus-4-7"
}
```

### Reasoning effort

Models that support adaptive thinking accept effort levels through OpenCode's reasoning configuration. The plugin passes them 1:1 to Kiro's `output_config.effort` parameter:

- `low` — speed/cost optimized
- `medium` — balanced general-purpose
- `high` — default, best balance
- `xhigh` — complex multi-step tasks (Fable 5, Opus 4.7, 4.8)
- `max` — maximum reasoning depth (Fable 5, Opus 4.7, 4.8)

Not all models support every level — see the model table above for supported efforts per model.

### Network retry behavior

The gateway retries transient transport failures before any assistant output reaches the client. This covers cases like a proxy/VPN disconnect where `fetch()` fails with `The socket connection was closed unexpectedly` or the response stream closes before the first token.

Retry policy:

- `fetch()` socket failures before an HTTP response: exponential backoff (`1s`, `2s`, `4s`, capped at `10s`)
- response-stream transport failures before the first token: same backoff policy
- HTTP transient responses (`429`/`5xx`): retry with jitter
- after partial text/tool output: no reset-and-retry, because already-sent SSE deltas cannot be retracted without duplicating output

### Usage bar (TUI)

The plugin ships a TUI component that displays your Kiro credit usage directly in the OpenCode prompt area. It only appears when a Kiro model is active.

```
Kiro Free C ████████░░ 78.00% ⟳ 12d (390/500)
```

**Setup** — OpenCode loads server plugins from `opencode.json` and TUI plugins from `tui.json`. The server plugin is already configured via the [Installation](#installation) section. To enable the usage bar, also add the plugin to your `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "@javargasm/opencode-kiro-auth"
  ]
}
```

This file lives at `~/.config/opencode/tui.json` (global) or in your project root (project-scoped). You can also install via CLI:

```bash
opencode plugin @javargasm/opencode-kiro-auth
```

> The bar auto-detects the active Kiro provider and only renders when a Kiro model is selected.

**How it works:**

- The TUI runs in a **separate process** from the server plugin (they share no state)
- Provider detection polls the session state every 2s and listens to `session.updated` / `message.updated` events
- Usage data is fetched over HTTP from the local gateway at `http://127.0.0.1:7438/dashboard/api/usage` every 30s
- Thresholds: green (< 70%), yellow (≥ 70%), red (≥ 90%)

## Development

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- TypeScript ≥ 5.0

### Commands

```bash
# Type-check + run tests
bun run check

# Type-check only
bun run typecheck

# Run tests
bun run test

# Run Bun gateway tests
bun run test:bun

# Run tests in watch mode
bun test --watch

# Build for distribution
bun run build
```

### Release

Patch/minor releases are tagged with `vX.Y.Z`. Pushing a tag triggers `.github/workflows/release.yaml`, which runs checks, builds the package, and publishes to npm with provenance through npm trusted publishing.

Required npm setup:

- Configure npm trusted publishing for `@javargasm/opencode-kiro-auth` and allow the GitHub workflow `.github/workflows/release.yaml`

Release commands:

```bash
bun run check
bun run build
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

### Debug logging

Structured file logging is **opt-in** via the `KIRO_FILE_LOG` environment
variable. When enabled, every turn of a conversation is written to
`/tmp/kiro-logs/session-{id}.log` (full request/response bodies) plus a
`session-{id}.last-request.json` dump of the most recent request. The id is
derived from OpenCode's session id, so all turns of one conversation — including
after a restart (`opencode -s <id>`) — share a single file.

It is **off by default** because the logs are verbose and may contain sensitive
prompt content. Enable it for the current shell:

```bash
export KIRO_FILE_LOG=1
```

To keep it always on, add it to your shell profile (macOS uses zsh):

```bash
echo 'export KIRO_FILE_LOG=1' >> ~/.zshrc && source ~/.zshrc
```

Accepted truthy values: `1`, `true`, `yes`, `on` (case-insensitive). Rebuild the
plugin (`bun run build`) and restart OpenCode after changing it.

### Project Structure

```
src/
├── index.ts            # Plugin entry: auth hooks, model registration, gateway lifecycle
├── types.ts            # Local type definitions and runtime utilities
├── server.ts           # Bun.serve Anthropic gateway (Messages API → Kiro SSE)
├── stream.ts           # Kiro streaming orchestrator (request build, retry, event parsing)
├── models.ts           # Model catalog, region mapping, dynamic model discovery
├── oauth.ts            # OIDC device-code auth (Builder ID + Identity Center)
├── transform.ts        # Message format conversion (OpenCode ↔ Kiro wire format)
├── thinking-parser.ts  # Streaming <thinking> tag parser for inline reasoning
├── event-parser.ts     # Kiro JSON event stream parser
├── kiro-defaults.ts    # Static protocol constants (system seed, tool schemas)
├── health.ts           # Permanent error classification
├── tokenizer.ts        # Lightweight token estimation
├── debug.ts            # Structured logging
├── tui.tsx             # TUI usage bar component (OpenTUI / Solid)
├── tui-detect.ts       # Provider detection helpers for the TUI bar
└── session-probe.ts    # Session/message provider resolution
test/
├── stream.test.ts          # Stream orchestrator tests
├── kiro-detector.test.ts   # Provider detection unit tests
└── session-probe.test.ts   # Session probe unit tests
```

## Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│   OpenCode   │────▶│  Local Gateway      │────▶│  Kiro API        │
│  (@ai-sdk/   │     │  (Bun.serve)        │     │  (CodeWhisperer  │
│   anthropic) │◀────│                     │◀────│   Streaming)     │
│              │ SSE │  POST /v1/messages   │     │                  │
└──────────────┘     └─────────────────────┘     └──────────────────┘
                        ▲
                        │ Translates:
                        │ • Anthropic Messages → Kiro request body
                        │ • Kiro JSON events → Anthropic SSE events
                        │ • Handles retry, capacity, context truncation
```

The gateway runs on `127.0.0.1` on a random port. It accepts standard Anthropic Messages API requests and translates them bidirectionally to Kiro's proprietary CodeWhisperer streaming protocol.

## License

MIT
