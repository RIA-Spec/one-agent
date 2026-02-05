# One Agent

An AI agent with one tool: Python code execution.

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
