# Contributing

## Development Setup

```bash
pnpm install
pnpm run build
pnpm run typecheck
```

If you need local runtime configuration, create a `.env` file from the package-level examples that apply to the area you are working on.

## RAS Modes

The core agent supports three RAS runtime modes via `RAS_MODE`:

```bash
export RAS_MODE=python
export RAS_MODE=typescript
export RAS_MODE=bash
```

Notes:

- `python` is the default mode.
- `typescript`, `ts`, `javascript`, and `js` resolve to the TypeScript RAS.
- Bash RAS runs direct shell code inside `just-bash`; use `act bash ...` when you need the real host bash tool.

Runtime docs live in [one-runner-python.md](one-runner-python.md) and [one-runner-bash.md](one-runner-bash.md).

## Common Commands

From the repository root:

```bash
pnpm run dev
pnpm run build
pnpm run build:agent
pnpm run build:web
pnpm run typecheck
pnpm test
pnpm run fmt
pnpm run fmt:check
pnpm run repl
```

## Workspace Notes

- `packages/one-agent` contains the core agent runtime, prompts, and RAS implementations.
- `packages/one-act`, `packages/one-reason`, and `packages/agent-extension` hold related runtime pieces.
- `apps/web` contains the web UI.

## Telemetry

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
