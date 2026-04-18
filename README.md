# One Agent

An AI agent with Reason-able Action Space (RAS) support for Python, TypeScript, and Bash.

## Re in Act

This monorepo is a reference implementation of the Re in Act working draft.

Core reference:

- [Working Draft Specification](https://re-in-act.org/specification/draft/index)

In this repository, that means:

- `reason()` is the required core interface and is used for schema-bounded local judgment inside the Reason-able Action Space (RAS).
- `act()` is an optional interface for external actions and tool execution inside the RAS.
- reusable workflows are modeled as `riff`s, or Reusable RAS Definitions.
- the agent can operate through Bash RAS and Code RAS runtime forms, with Python and TypeScript as the main code runtimes in this implementation.

The implementation here focuses on making those ideas executable in a real agent/runtime/web stack, rather than only documenting the spec terms.

## Packages

This monorepo is split into a small set of focused packages:

- [packages/one-agent/package.json](/Users/beet/github-repo/one-agent/packages/one-agent/package.json): the main ONE agent package and CLI, including `one repl`, the bundled RAS runtimes, riff commands, and top-level config/auth flows.
- [packages/one-reason/README.md](/Users/beet/github-repo/one-agent/packages/one-reason/README.md): the `reason()` implementation and CLI behind the required core interface described in the [Working Draft Specification](https://re-in-act.org/specification/draft/index).
- [packages/one-act/README.md](/Users/beet/github-repo/one-agent/packages/one-act/README.md): the `act()` implementation and CLI for MCP-backed action execution, aligned with the optional action interface in the [Working Draft Specification](https://re-in-act.org/specification/draft/index).
- [packages/agent-extension/package.json](/Users/beet/github-repo/one-agent/packages/agent-extension/package.json): the optional delegated `agent()` extension for bounded nested agent execution, aligned with the [Agent Interface Extension](https://re-in-act.org/extensions/agent-interface).
- [packages/ria-proxy/README.md](/Users/beet/github-repo/one-agent/packages/ria-proxy/README.md): the proxy/plugin package for bringing Re in Act semantics to OpenAI-compatible tool runtimes.

## Reason-able Action Space (RAS)

The RAS is the bounded action context and interfaces for reasoning in action. In the spec, it is the space where local feedback, deterministic control flow, and bounded `reason()` / optional `act()` steps stay local instead of bouncing every disturbance back to the outer loop. This repository currently ships three runtime surfaces.

### 1. Python RAS (Code RAS) - Default

**The Programmatic Approach**: Manage control flows using code execution (conditions, loops, branches).

**Configuration**: Uses [one-runner-python.md](one-runner-python.md)

```python
import asyncio
import os

async def main():
    log_content = open("build.log").read() if os.path.exists("build.log") else "No log"
    analysis = await reason(
        log_content + "\nDid the build succeed?",
        {"success": False, "reason": ""}
    )

    if analysis["data"]["success"]:
        await act("bash", {"command": "echo deploy to production"})
    else:
        print(f"Build failed: {analysis['data']['reason']}")

asyncio.run(main())
```

### 2. TypeScript RAS (Code RAS)

**The Programmatic Approach**: Manage control flows using TypeScript/JavaScript execution with `await reason(...)` and `await act(...)`.

**Configuration**: Uses [one-runner-python.md](one-runner-python.md) for the shared code-runner surface.

```typescript
const status = await act("bash", { command: "cat build.log" });
if (status?.isError) {
  console.log(status);
  process.exit(1);
}

const analysis = await reason(
  "Goal: decide if the build succeeded. Observation: " +
    String(status.content?.[0]?.text ?? "").slice(0, 4000) +
    ". Constraints: return success plus a short grounded reason.",
  { success: false, reason: "" }
);

if (analysis?.error) {
  console.log(analysis.error);
  process.exit(1);
}

if (analysis.data.success) {
  await act("bash", { command: "echo deploy to production" });
} else {
  console.log(`Build failed: ${analysis.data.reason}`);
}
```

### 3. Bash RAS (Unix Philosophy)

**The Unix Philosophy**: Control flow using pipes (|) and redirection (>).

**Configuration**: Uses [one-runner-bash.md](one-runner-bash.md)

```bash
cat api_docs.md | \
  reason - '{"summary":"","test_command":""}' | \
  tee /tmp/plan.json | \
  jq -r '.summary' && \
  jq -c '{command: .test_command}' /tmp/plan.json | \
  act bash -
```

Notes:

- direct shell execution runs inside a `just-bash` sandbox.
- use `act bash ...` when you explicitly need the real host bash tool.
- `reason` in Bash expects: `reason [prompt|-] [structure]`
- `act <tool> -` expects JSON from stdin (not plain text)

## Environment Variables

### RAS Mode Selection

Control which RAS runtime surface to enable (only one at a time):

```bash
# Enable Python RAS (default)
export RAS_MODE=python

# Enable TypeScript RAS
export RAS_MODE=typescript

# Aliases also supported
export RAS_MODE=ts

# Enable Bash RAS
export RAS_MODE=bash
```

### File System Configuration

```bash
# Root directory for file operations
export NODE_FS_ROOT=/path/to/root

# Mount point path visible in Python/TypeScript runtimes
export NODE_FS_MOUNT_POINT=/path/to/mount
```

## Usage

```typescript
import { agent } from "./src/agent";

await agent("Calculate fibonacci sequence up to 100");
```

## CLI Model Configuration

The `one` CLI and the built-in `reason()` function use different config scopes.

- `one auth` configures the main `one` agent model used by `one repl` and other top-level `one` CLI flows.
- `one reason auth` configures the model used by `reason()` inside the Reason-able Action Space.

By default these write separate config files under `~/.config/one/`:

- `one auth` writes `one.json`
- `one reason auth` writes `reason.json`

Example:

```bash
# Configure the main one agent model
one auth

# Configure the model used by reason()
one reason auth
```

This separation is intentional: you can use one model/provider for the main agent loop and a different model/provider for bounded `reason()` calls.

## Contributing

Development setup, local scripts, and contributor workflow now live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Telemetry & Observability

This project includes OpenTelemetry integration for monitoring AI SDK operations in SigNoz.

### Setup SigNoz

The project is configured to send traces to SigNoz at `http://localhost:4318/v1/traces`.

If you have SigNoz running locally, traces will be automatically sent. Access SigNoz UI at:

- **http://localhost:8080/**

### Configuration

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Configure the following environment variables:

- `OTEL_SERVICE_NAME` - Service name in SigNoz (default: "one-agent")
- `OTEL_EXPORTER_OTLP_ENDPOINT` - SigNoz endpoint (default: "http://localhost:4318/v1/traces")

### What's Tracked

The telemetry captures:

- AI model calls (provider/model metadata)
- Tool executions
- Token usage and latency
- Prompts and responses
- Error traces
- Custom metadata (agent type, model provider)

### Viewing Traces

1. Open SigNoz at http://localhost:8080/
2. Navigate to "Services" to see `one-agent`
3. Click on the service to view traces
4. Explore spans to see detailed AI operations

## License

This repository is licensed under Apache-2.0. See `LICENSE` and `NOTICE` at the repository root.
