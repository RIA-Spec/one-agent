# @one-agent/act

Deterministic MCP tool runner for ONE.

Within this repository's Re in Act implementation, `@one-agent/act` is the external action layer for the optional `act()` interface: it is responsible for deterministic tool execution while higher-level agent logic decides when to call `act()` inside the RAS.

Relevant public reference:

- [Working Draft Specification](https://re-in-act.org/specification/draft/index)

Important boundary: the Re in Act spec requires `reason()` and makes `act()` optional. `one-act` is this repository's MCP-backed implementation of that optional action interface.

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
    },
    "secure-mcp": {
      "transportType": "streamable-http",
      "url": "https://mcp-server.example.com",
      "auth": "oauth",
      "resource": "https://mcp-server.example.com"
    }
  }
}
```

Supported transport shapes follow `@mcpc-tech/core` `McpServerConfig`. `one-act` only recognizes per-server `daemon: true`: marked servers stay resident in the daemon, and unmarked servers connect on demand for each call. The daemon strips the flag before passing runtime config into `mcpc`.

### OAuth 2.1 PKCE & Resource Indicators (RFC 8707)

For secure streamable-http/sse servers, enable PKCE by setting `"auth": "oauth"`.

To bypass dynamic protected resource metadata discovery (which may fail due to strict authentication filters or CORS locks at the gateway level), declare a static `"resource"` URL inside the config. This acts as the **RFC 8707 Resource Indicator** in all login and background refresh loops, eliminating discovery deadlocks.

#### Use Case: Bypassing Strict Enterprise Zero-Trust Gateways

In strict enterprise Zero-Trust architectures, centralized identity providers use **RFC 8707 Resource Indicators** to issue audience-restricted tokens. 

Because secure API gateways enforce pre-authentication for all sub-paths, dynamic Protected Resource Metadata discovery (`GET /.well-known/oauth-protected-resource`) fails with a `401/403` discovery deadlock. Configuring a static `"resource"` bypasses discovery entirely, providing a clean solution for enterprise Zero-Trust integrations.

To log in via the CLI:

```bash
act oauth login secure-mcp
```

---

## Programmatic API (SDK)

`@one-agent/act` can be imported directly as a Node.js library. It provides inline config overrides, automatic interactive login prompts, and robust session management.

### Call a Tool

```typescript
import { act } from "@one-agent/act";

const result = await act(
  "secure-mcp_some_tool",
  { arg1: "val" },
  {
    autoLogin: true, // Automatically triggers the PKCE browser flow if unauthorized
    mcpServers: {
      "secure-mcp": {
        transportType: "streamable-http",
        url: "https://mcp-server.example.com",
        auth: "oauth",
        resource: "https://mcp-server.example.com",
      },
    },
  },
);
```

### Proactive Credential Checking

While setting `autoLogin: true` (as shown above) is the simplest and recommended way to automatically trigger the browser authentication flow on demand, you may sometimes need explicit control over the user experience.

For instance, if you need to block UI elements, display pre-login prompts, or verify credentials before starting a heavy task, you can proactively check credentials (Preflight Check) using the exported `ensureOAuthToken` and `runOAuthLogin` utilities:

```typescript
import { act, ensureOAuthToken, runOAuthLogin } from "@one-agent/act";

const serverName = "secure-mcp";
const serverUrl = "https://mcp-server.example.com";
const resource = "https://mcp-server.example.com";

// 1. Silent Preflight Check: checks cache and auto-refreshes if close to expiry
const token = await ensureOAuthToken(serverName, serverUrl, resource);

if (!token) {
  console.log("No valid credentials found. Launching browser to authorize...");
  // 2. Proactively trigger login if credentials are missing
  await runOAuthLogin(serverName, serverUrl, undefined, resource);
}

// 3. Invoke tool call securely with 100% confidence
const result = await act("secure-mcp_some_tool", { arg: "val" });
```

### Manage Sessions

Use a persistent `ActSession` to run multiple sequential tool calls without spawning processes/connections repeatedly (e.g. keeping a browser session active):

```typescript
import { createActSession } from "@one-agent/act";

const session = await createActSession({ autoLogin: true });
try {
  await session.act("chrome-devtools_new_page", { url: "https://example.com" });
  await session.act("chrome-devtools_take_snapshot", {});
} finally {
  await session.close();
}
```

### Exported Utilities

For advanced control over authentication and system environment integrations:

- **OAuth Actions:**
  - `runOAuthLogin(serverName, serverUrl, clientId?, resource?)`: Interactively triggers the PKCE browser authorization sequence.
  - `ensureOAuthToken(serverName, serverUrl, resource?)`: Retrieves a valid cached token, automatically executing a background refresh if needed.
  - `clearOAuthState(serverName)`: Removes cached sessions and tokens.
  - `listOAuthStates()`: Returns an overview of stored authentication status.
- **System Actions:**
  - `openBrowser(url)`: A lightweight, cross-platform system default browser opener supporting Windows, macOS, and Linux (with fallback warnings in headless setups).

---

## References

- [Re in Act Working Draft Specification](https://re-in-act.org/specification/draft/index)
- [MCP Protected Resource Metadata (RFC 9728)](https://datatracker.ietf.org/doc/html/rfc9728)
- [Resource Indicators for OAuth 2.0 (RFC 8707)](https://datatracker.ietf.org/doc/html/rfc8707)
- https://github.com/mcpc-tech/mcpc/blob/main/packages/core/src/service/tools.ts
