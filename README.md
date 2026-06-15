# @javargasm/opencode-kiro-auth

Kiro provider plugin for [OpenCode](https://opencode.ai). Authenticates via AWS Builder ID or IAM Identity Center and exposes all Kiro models through an Anthropic-compatible local gateway.

## Features

- **AWS Builder ID / IAM Identity Center** — OAuth device-code login with automatic token refresh
- **Dynamic model discovery** — fetches available models from the Kiro API at runtime; falls back to a curated static catalog
- **Local Anthropic gateway** — translates Anthropic Messages API requests to Kiro's CodeWhisperer streaming protocol
- **Adaptive thinking** — maps reasoning effort levels (`low` → `max`) through the `output_config.effort` parameter
- **Multi-region** — supports `us-east-1` and `eu-central-1` Kiro API regions with automatic SSO region mapping
- **Zero external dependencies** — self-contained plugin; no runtime deps beyond the OpenCode SDK

## Supported Models

| Model | Reasoning | Context | Effort Levels |
|:---|:---:|:---:|:---|
| Claude Fable 5 | ✅ | 1M | low, medium, high, xhigh, max |
| Claude Opus 4.8 | ✅ | 1M | low, medium, high, xhigh, max |
| Claude Opus 4.7 | ✅ | 1M | low, medium, high, xhigh, max |
| Claude Opus 4.6 | ✅ | 1M | low, medium, high, max |
| Claude Sonnet 4.6 | ✅ | 1M | low, medium, high, max |
| Claude Opus 4.5 | ✅ | 200K | — |
| Claude Sonnet 4.5 | ✅ | 200K | — |
| Claude Sonnet 4 | ✅ | 200K | — |
| Claude Haiku 4.5 | ❌ | 200K | — |
| DeepSeek 3.2 | ✅ | 128K | — |
| Kimi K2.5 | ✅ | 200K | — |
| MiniMax M2.1 / M2.5 | ❌ | 196K | — |
| GLM 4.7 / 4.7 Flash | ✅/❌ | 128K | — |
| Qwen3 Coder Next | ✅ | 256K | — |
| Qwen3 Coder 480B | ✅ | 128K | — |
| AGI Nova Beta | ✅ | 1M | — |

> Models without effort levels listed use Kiro's default reasoning behavior. Additional models may appear dynamically via the `ListAvailableModels` API.

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
bun test

# Run tests in watch mode
bun test --watch

# Build for distribution
bun run build
```

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
└── debug.ts            # Structured logging
test/
└── gateway.test.ts     # Gateway integration tests (health, auth, streaming, non-streaming)
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
