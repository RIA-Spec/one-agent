# One Agent

An AI agent with Reason-able Action Space (RAS) support for Python and Bash.

## Re in Act

This monorepo implements the Re in Act programming model described in [RIA-Spec/re-in-act](https://github.com/RIA-Spec/re-in-act).

In this repository, that means:

- `reason()` is used for bounded local thinking that must return structured data.
- `act()` is used for external actions and tool execution.
- reusable workflows are modeled as `riff`s.
- the agent can operate through either a Python or Bash runtime surface.

The implementation here focuses on making those ideas executable in a real agent/runtime/web stack, rather than only documenting the spec terms.

## Reason-able Action Space (RAS)

RAS defines the bounded environment and interfaces for agents to reason in action. Two approaches:

### 1. Python RAS (Code Interpreter) - Default

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

    if analysis['data']['success']:
    await act("bash", {"command": "echo deploy to production"})
    else:
    print(f"Build failed: {analysis['data']['reason']}")

asyncio.run(main())
```

### 2. Bash RAS (Unix Philosophy)

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

- `reason` in Bash expects: `reason [prompt|-] [structure]`
- `act <tool> -` expects JSON from stdin (not plain text)

## Environment Variables

### RAS Mode Selection

Control which RAS runtime surface to enable (only one at a time):

```bash
# Enable Python RAS (default)
export RAS_MODE=python

# Enable Bash RAS
export RAS_MODE=bash
```

### File System Configuration

```bash
# Root directory for file operations
export NODE_FS_ROOT=/path/to/root

# Mount point path visible in Python/Bash
export NODE_FS_MOUNT_POINT=/path/to/mount
```

## Usage

```typescript
import { agent } from "./src/agent";

await agent("Calculate fibonacci sequence up to 100");
```

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

## Development

```bash
pnpm install
pnpm run build
pnpm run typecheck
```

## License

This repository is licensed under Apache-2.0. See `LICENSE` and `NOTICE` at the repository root.

## Scripts

- `pnpm run repl` - Start the interactive REPL
- `pnpm run build` - Build the project
- `pnpm run dev` - Development with watch mode
- `pnpm test` - Run tests
