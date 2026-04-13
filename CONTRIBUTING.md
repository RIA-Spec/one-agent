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

OpenTelemetry support is wired for SigNoz at `http://localhost:4318/v1/traces` by default.

If you want local traces, configure:

- `OTEL_SERVICE_NAME`
- `OTEL_EXPORTER_OTLP_ENDPOINT`

The default SigNoz UI is available at `http://localhost:8080/`.
