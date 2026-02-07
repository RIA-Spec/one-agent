# One Agent

An AI agent with Action Execution Runtime (AER) support for Python and Bash.

## Action Execution Runtime (AER)

AER defines the environment and interfaces for agents to reason in action. Two approaches:

### 1. Python AER (Code Interpreter) - Default

**The Programmatic Approach**: Manage control flows using code execution (conditions, loops, branches).

**Configuration**: Uses [one-runner-python.md](one-runner-python.md)

```python
import asyncio

async def main():
    log_content = open("build.log").read()
    analysis = await reason(log_content + "Did the build succeed?", {"success": False})
    if analysis['data']['success']:
        act("deploy", "deploy to production")
    else:
        act("notify", "notify about failure")

asyncio.run(main())
```

### 2. Bash AER (Unix Philosophy)

**The Unix Philosophy**: Control flow using pipes (|) and redirection (>).

**Configuration**: Uses [one-runner-bash.md](one-runner-bash.md)

```bash
cat api_docs.md | \
  reason --prompt "Read this API documentation:" \
     --prompt - \
     --prompt "Generate a summary of how to test this API." \
     --structure '{"summary": ""}' | \
  jq -r '.summary' | \
  act bash -
```

## Environment Variables

### AER Mode Selection

Control which Action Execution Runtime to enable (only one at a time):

```bash
# Enable Python AER (default)
export AER_MODE=python

# Enable Bash AER
export AER_MODE=bash
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

- ✅ AI model calls (DeepSeek, Claude Haiku)
- ✅ Tool executions
- ✅ Token usage and latency
- ✅ Prompts and responses
- ✅ Error traces
- ✅ Custom metadata (agent type, model provider)

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

## Scripts

- `pnpm run repl` - Start the interactive REPL
- `pnpm run build` - Build the project
- `pnpm run dev` - Development with watch mode
- `pnpm test` - Run tests
