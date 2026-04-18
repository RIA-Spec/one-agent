# @one-agent/act

Deterministic MCP tool runner for ONE.

Within this repository's Re in Act implementation, `@one-agent/act` is the external action layer: it is responsible for deterministic tool execution, while higher-level agent logic decides when to call `act()`.

`one-act` does not have a model auth flow. `one auth` configures the main `one` agent model, and `reason auth` configures the model used by `reason()`. `one-act` only reads MCP/tool server configuration.

## MCP Config

`one-act` reads MCP server config from `~/.config/one/act.json` or `ONE_ACT_MCP_SERVERS`.

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "transportType": "stdio",
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--autoConnect"],
      "env": {
        "FOO": "bar"
      },
      "daemon": true
    },
    "remote-http": {
      "transportType": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer token"
      }
    }
  }
}
```

Supported transport shapes follow `@mcpc-tech/core` `McpServerConfig`. `one-act` only recognizes per-server `daemon: true`: marked servers stay resident in the daemon, and unmarked servers connect on demand for each call. The daemon strips the flag before passing runtime config into `mcpc`.

Reference:

- https://github.com/mcpc-tech/mcpc/blob/main/packages/core/src/service/tools.ts