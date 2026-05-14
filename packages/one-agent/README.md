# @one-agent/agent

ONE Agent — an AI agent with Reason-able Action Space (RAS) support for Python, TypeScript, and Bash.

This package is a reference implementation of the [Re in Act working draft specification](https://re-in-act.org/specification/draft/index). It ships the main agent loop, three RAS runtime surfaces, a REPL, a stdio interface, and the `one` CLI entry point.

## Install

```bash
npm install @one-agent/agent
# or
pnpm add @one-agent/agent
```

## Quick start

```typescript
import { agent, agentStream } from "@one-agent/agent";

// Single-shot: returns the final text
const result = await agent("List the failing tests in this repo and suggest fixes.");
if ("error" in result) {
  console.error(result.error);
} else {
  console.log(result.data.text);
}

// Streaming
const stream = agentStream("Summarise the last 10 git commits.");
for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

## CLI

```bash
# Interactive REPL
one repl

# Authenticate (set model/provider for the main agent loop)
one auth

# Configure the model used by reason() inside the RAS
one reason auth

# Pipe a prompt via stdio
echo "What files changed last week?" | one stdio
```

Binary aliases installed alongside `one-agent`:

| Binary       | Maps to              |
| ------------ | -------------------- |
| `one-agent`  | main CLI entry point |
| `one-reason` | `reason` CLI         |
| `one-act`    | `act` CLI            |
| `one-stdio`  | stdio interface      |
| `reason`     | `reason` CLI (short) |
| `act`        | `act` CLI (short)    |

## Reason-able Action Space (RAS)

The RAS is a bounded execution context where local feedback, deterministic control flow, and structured `reason()` / optional `act()` steps stay local instead of bouncing every decision back to the outer model loop.

Three runtime surfaces are available:

### Python RAS (default)

```python
import asyncio, os

async def main():
    log = open("build.log").read() if os.path.exists("build.log") else "No log"
    analysis = await reason(
        log + "\nDid the build succeed?",
        {"success": False, "reason": ""}
    )
    if analysis["data"]["success"]:
        await act("bash", {"command": "echo deploy"})
    else:
        print(f"Build failed: {analysis['data']['reason']}")

asyncio.run(main())
```

### TypeScript RAS

```typescript
const status = await act("bash", { command: "cat build.log" });
const analysis = await reason(
  "Goal: decide if the build succeeded. Observation: " + status.content?.[0]?.text,
  { success: false, reason: "" },
);
if (analysis.data.success) {
  await act("bash", { command: "echo deploy" });
}
```

### Bash RAS

```bash
cat build.log | \
  reason - '{"success":false,"reason":""}' | \
  jq -r '.reason'
```

Select the runtime via `RAS_MODE`:

```bash
export RAS_MODE=python      # default
export RAS_MODE=typescript  # or: ts
export RAS_MODE=bash
```

## Environment variables

| Variable                      | Default  | Description                                               |
| ----------------------------- | -------- | --------------------------------------------------------- |
| `RAS_MODE`                    | `python` | RAS runtime surface (`python`, `typescript`/`ts`, `bash`) |
| `ONE_CHAT_MODEL`              | —        | Override the main agent model ID                          |
| `ONE_AGENT_MODEL`             | —        | Fallback model ID (lower priority than `ONE_CHAT_MODEL`)  |
| `MODEL`                       | —        | Lowest-priority model ID fallback                         |
| `NODE_FS_ROOT`                | —        | Root directory for file operations                        |
| `NODE_FS_MOUNT_POINT`         | —        | Mount point visible inside Python/TypeScript runtimes     |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | —        | Enable OpenTelemetry trace export                         |

## API

```typescript
// Run agent, returns AgentResult (success or error)
agent(prompt: string, options?: AgentOptions): Promise<AgentResult>

// Run agent, returns an async iterable of text chunks
agentStream(prompt: string, options?: AgentStreamOptions): AsyncIterable<string>

// Low-level: resolve a model by ID using the same logic as the CLI
resolveOneModel(modelId?: string): LanguageModel

// Message compaction (trim conversation history to stay within context)
autoCompactMessages(messages: ModelMessage[], options?: CompactionOptions): Promise<ModelMessage[]>
```

## Model configuration

The `one` CLI keeps two separate auth scopes so you can use different models for different jobs:

```bash
# Model for the outer agent loop (one repl, one stdio, …)
one auth

# Model for bounded reason() calls inside the RAS
one reason auth
```

Config files are written to `~/.config/one/`:

- `one auth` → `one.json`
- `one reason auth` → `reason.json`

Environment variables always override file config.

## Related packages

| Package                                                                                  | Role                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`@one-agent/reason`](https://www.npmjs.com/package/@one-agent/reason)                   | `reason()` — required bounded judgment interface |
| [`@one-agent/act`](https://www.npmjs.com/package/@one-agent/act)                         | `act()` — optional MCP tool execution interface  |
| [`@one-agent/agent-extension`](https://www.npmjs.com/package/@one-agent/agent-extension) | `agent()` — optional nested agent delegation     |
| [`@one-agent/ria-proxy`](https://www.npmjs.com/package/@one-agent/ria-proxy)             | Re in Act plugin for OpenAI-compatible runtimes  |

## Specification

- [Re in Act Working Draft](https://re-in-act.org/specification/draft/index)

## License

Apache-2.0 — see `LICENSE` and `NOTICE` at the repository root.
