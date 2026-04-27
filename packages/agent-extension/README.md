# @one-agent/agent-extension

Optional delegated `agent()` extension for ONE.

This package implements the optional [Agent Interface Extension](https://re-in-act.org/extensions/agent-interface) described in the Re in Act specification. It lets code running inside a Reason-able Action Space (RAS) delegate a sub-task to a fully independent agent process over ACP, wait for the result, and continue — without escaping the bounded execution model.

## Install

```bash
npm install @one-agent/agent-extension
# or
pnpm add @one-agent/agent-extension
```

## Quick start

```typescript
import { agent } from "@one-agent/agent-extension";

const result = await agent("Summarise the diff in /tmp/patch.diff");

if ("error" in result) {
  console.error(result.error);
} else {
  console.log(result.data.text);
  console.log("Steps taken:", result.data.trajectory.steps.length);
}
```

## API

### `agent(prompt, config?)`

```typescript
agent(prompt: string, config?: AgentConfig): Promise<AgentResult>
```

Delegates `prompt` to a child agent process and returns once it is done.

#### `AgentConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `command` | `string` | `"claude-agent-acp"` | ACP server binary to spawn |
| `args` | `string[]` | `[]` | Extra CLI args for the ACP server |
| `env` | `Record<string, string>` | — | Additional env vars for the child process |
| `model` | `string` | `"default"` | Model ID passed to the ACP provider |
| `mode` | `string` | — | Optional mode hint forwarded to the ACP provider |
| `system` | `string` | — | Extra system prompt appended to the child agent's context |
| `budget.maxSteps` | `number` | `40` | Max agentic steps before the run is stopped |
| `budget.maxMinutes` | `number` | — | Wall-clock timeout in minutes |
| `budget.maxOutputTokens` | `number` | `4096` | Max output tokens per step |
| `budget.maxRetries` | `number` | `2` | Retry budget when `on_error` is `"retry_within_budget"` |
| `on_error` | `"fail" \| "return_error" \| "retry_within_budget"` | `"return_error"` | Error handling policy |
| `session.cwd` | `string` | `process.cwd()` | Working directory for the child agent |
| `session.mcpServers` | `McpServerConfig[]` | `[]` | MCP servers available to the child agent |
| `persistSession` | `boolean` | — | Keep the ACP session alive between calls |
| `extension.enabled` | `boolean` | — | Inject `injectSystemPrompt` / `injectTools` into the child |
| `extension.injectSystemPrompt` | `string \| false` | — | System prompt fragment to prepend |
| `extension.injectTools` | `McpServerConfig[] \| false` | — | Extra MCP servers to merge into the session |

#### `AgentResult`

```typescript
type AgentResult =
  | { data: { text: string; trajectory: AgentTrajectory } }
  | { error: string };
```

The `trajectory` field follows the [ATIF format](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md) (`schema_version: "atif-0.1"`).

## Environment variables

| Variable | Description |
|---|---|
| `ONE_AGENT_EXTENSION_ACP_COMMAND` | Override the default ACP server command |
| `ONE_AGENT_EXTENSION_ACP_ARGS` | Space-separated (or JSON array) extra args for the ACP server |
| `ONE_AGENT_EXTENSION_ACP_MODEL` | Override the model ID |
| `ONE_AGENT_EXTENSION_DEBUG` | Set to `1` / `true` to enable AI SDK devtools middleware |
| `ONE_AGENT_DEBUG` | Alias for the debug flag |
| `RIA_PROXY_DEBUG` | Alias for the debug flag |
| `DEBUG` | Lowest-priority alias for the debug flag |

## Related packages

| Package | Role |
|---|---|
| [`@one-agent/agent`](https://www.npmjs.com/package/@one-agent/agent) | Main ONE agent — uses this package for nested delegation |
| [`@one-agent/reason`](https://www.npmjs.com/package/@one-agent/reason) | `reason()` — required bounded judgment interface |
| [`@one-agent/act`](https://www.npmjs.com/package/@one-agent/act) | `act()` — optional MCP tool execution interface |
| [`@one-agent/ria-proxy`](https://www.npmjs.com/package/@one-agent/ria-proxy) | Re in Act plugin for OpenAI-compatible runtimes |

## Specification

- [Re in Act Working Draft](https://re-in-act.org/specification/draft/index)
- [Agent Interface Extension](https://re-in-act.org/extensions/agent-interface)

## License

Apache-2.0 — see `LICENSE` and `NOTICE` at the repository root.
