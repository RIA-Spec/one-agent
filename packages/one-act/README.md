# @one/act

Deterministic MCP tool runner for ONE.

## MCP Config

`one-act` reads MCP server config from `~/.config/one/act.json` or `ONE_ACT_MCP_SERVERS`.

```json
{
  "daemon": true,
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

Supported transport shapes follow `@mcpc-tech/core` `McpServerConfig`. `one-act` adds per-server `daemon: true` and strips it before passing runtime config into `mcpc`.

Reference:

- https://github.com/mcpc-tech/mcpc/blob/main/packages/core/src/service/tools.ts