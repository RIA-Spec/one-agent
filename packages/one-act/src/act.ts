import { mcpc, type ComposableMCPServer, type ToolRefXml } from "@mcpc-tech/core";
import { cac } from "cac";
import { cancel, confirm, intro, isCancel, outro, select, text } from "@clack/prompts";
import {
  CallToolResultSchema,
  type AudioContent,
  type BlobResourceContents,
  type CallToolResult,
  type ContentBlock,
  type EmbeddedResource,
  type ImageContent,
  type ResourceLink,
  type TextContent,
  type TextResourceContents,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { getOneConfigPath } from "./config-path.js";
import { clearOAuthState, ensureOAuthToken, listOAuthStates, runOAuthLogin } from "./oauth.js";
import {
  computeDaemonConfigHash,
  ensureActDaemonClient,
  getActDaemonStatus,
  normalizeMcpServersForRuntime,
  runActDaemonServer,
  selectEnabledMcpServers,
  selectDaemonMcpServers,
  startActDaemon,
  stopActDaemon,
  type ActDaemonClient,
  type ActDaemonSpawnOptions,
  type McpServersConfig,
} from "./daemon.js";

const ACT_CONFIG_PATH = getOneConfigPath("act.json");
const ACT_OUTPUT_DIR = getOneConfigPath("act-output");
const MANUAL_TOOL_NAME = "__manual__";
const HELP_DESCRIPTION =
  "Deterministic MCP tool runner: discover tools, inspect schemas, call one tool with exact JSON, and optionally reuse a daemon.";
const HELP_QUICKSTART = [
  "List tools: act --manual",
  "Inspect one schema: act --manual <tool>",
  'Call one tool: act <tool> \'{"key":"value"}\'',
  "Pipe generated JSON: jq -c '{...}' file.json | act <tool> -",
];
const HELP_CONFIGURATION = [
  `Default config file: ${ACT_CONFIG_PATH}`,
  "File config key: mcpServers",
  "Env override: ONE_ACT_MCP_SERVERS='<json>'",
];
const HELP_MCP_FORMAT = [
  "Common fields: disabled, disabledReason, toolCallTimeout",
  'stdio: {"transportType":"stdio","command":"npx","args":[...],"env":{"KEY":"VALUE"}}',
  'http: {"transportType":"streamable-http"|"sse","url":"https://...","headers":{"Authorization":"Bearer ..."}}',
  'one-act extension: {"daemon":true} keeps that server resident in the daemon; other servers stay on demand',
  'oauth: add {"auth":"oauth"} to a streamable-http/sse server to use OAuth 2.1 PKCE; run: act oauth login <server>',
];
const HELP_DAEMON = [
  "Per-server `daemon: true` keeps that MCP server resident in the background",
  "Use `act daemon start|status|restart|stop` to manage only daemon-enabled servers",
];
const HELP_EXAMPLES = [
  "act --manual",
  "act daemon start",
  "act --manual chrome-devtools_navigate_page",
  'act chrome-devtools_new_page \'{"url":"https://example.com"}\'',
  "ONE_ACT_MCP_SERVERS=" +
    '\'{"chrome-devtools":{"transportType":"stdio","command":"npx","args":["-y","chrome-devtools-mcp@latest","--autoConnect"]}}\' act --manual',
  "act oauth login github",
  "act oauth status",
  "ONE_ACT_MCP_SERVERS=" +
    '\'{"github":{"transportType":"streamable-http","url":"https://api.githubcopilot.com/mcp/","auth":"oauth"}}\' act --manual',
];

export type { McpServersConfig, OneActMcpServerConfig } from "./daemon.js";
export type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Options shared by {@link act} and {@link createActSession}.
 */
export type ActOptions = {
  /**
   * Inline MCP servers config. When provided, overrides the config file
   * and the `ONE_ACT_MCP_SERVERS` / `MCP_SERVERS` environment variables.
   */
  mcpServers?: McpServersConfig;
};

/**
 * A session that holds an open connection to one or more MCP servers so that
 * multiple tool calls can share the same server process.
 *
 * Obtain a session with {@link createActSession} and always call
 * `session.close()` when finished (or use a `try/finally` block).
 *
 * @example
 * ```ts
 * import { createActSession } from "@one-agent/act";
 *
 * const session = await createActSession();
 * try {
 *   await session.act("playwright_navigate", { url: "https://example.com" });
 *   await session.act("playwright_screenshot", {});
 * } finally {
 *   await session.close();
 * }
 * ```
 */
export type ActSession = {
  /** Call a tool within this session. */
  act(toolName: string, args: unknown): Promise<CallToolResult>;
  /** Close all server connections opened by this session. */
  close(): Promise<void>;
};

/**
 * Call a single MCP tool by name with the given arguments.
 *
 * This is the high-level programmatic entry point for `@one-agent/act`.
 * It handles reading the MCP server configuration, building the server,
 * invoking the tool, and cleaning up — in a single call.
 *
 * Configuration resolution order (first match wins):
 *   1. `options.mcpServers` — inline config passed to this call
 *   2. `ONE_ACT_MCP_SERVERS` env var (JSON string)
 *   3. `MCP_SERVERS` env var (JSON string)
 *   4. `~/.config/one/act.json` → `mcpServers` field
 *
 * @example
 * ```ts
 * import { act } from "@one-agent/act";
 *
 * const result = await act("playwright_navigate", { url: "https://example.com" });
 * console.log(result.content);
 * ```
 *
 * @example With inline config:
 * ```ts
 * import { act } from "@one-agent/act";
 *
 * const result = await act(
 *   "playwright_navigate",
 *   { url: "https://example.com" },
 *   {
 *     mcpServers: {
 *       playwright: {
 *         transportType: "stdio",
 *         command: "npx",
 *         args: ["-y", "@playwright/mcp@latest", "--isolated"],
 *       },
 *     },
 *   },
 * );
 * ```
 */
export async function act(
  toolName: string,
  args: unknown,
  options?: ActOptions,
): Promise<CallToolResult> {
  const mcpServers = await injectOAuthHeaders(
    options?.mcpServers ?? readConfiguredMcpServers(readActConfig()),
  );
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    throw new Error(
      "No MCP server configuration found. Provide options.mcpServers, set ONE_ACT_MCP_SERVERS, or configure mcpServers in ~/.config/one/act.json.",
    );
  }

  const daemonMcpServers = selectDaemonMcpServers(mcpServers);
  const onDemandServers = selectOnDemandMcpServers(mcpServers);
  const useDaemon = isDaemonToolName(toolName, daemonMcpServers);

  // If the tool belongs to a daemon-enabled server, try to connect to a
  // running daemon first. Programmatic callers cannot spawn a daemon (the
  // daemon needs the CLI script path), so fall through to on-demand if the
  // daemon is not already running.
  if (useDaemon) {
    const daemonConfigHash = computeDaemonConfigHash(daemonMcpServers);
    const daemonStatus = await getActDaemonStatus(daemonConfigHash);
    if (daemonStatus.running && daemonStatus.healthy) {
      // ensureActDaemonClient won't spawn when the daemon is already healthy
      const daemonClient = await ensureActDaemonClient(
        { execPath: process.execPath, execArgv: [], scriptPath: "" },
        daemonConfigHash,
      );
      return daemonClient.callTool(toolName, args);
    }
    // Daemon not running — fall through to on-demand using the daemon servers.
    const getServer = createGetServerFromMcpServers(daemonMcpServers);
    const server = await getServer();
    try {
      return await getToolFn(server)(toolName, args);
    } finally {
      try {
        await Promise.race([
          server.close(),
          new Promise<void>((resolve) => {
            setTimeout(resolve, SERVER_CLOSE_TIMEOUT_MS);
          }),
        ]);
      } catch {
        // Ignore cleanup errors so tool result remains primary.
      }
    }
  }

  // On-demand server: start, call, close.
  if (!onDemandServers || Object.keys(onDemandServers).length === 0) {
    throw new Error(`Tool "${toolName}" not found in any configured MCP server.`);
  }

  const getServer = createGetServerFromMcpServers(onDemandServers);
  const server = await getServer();
  try {
    return await getToolFn(server)(toolName, args);
  } finally {
    try {
      await Promise.race([
        server.close(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, SERVER_CLOSE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // Ignore cleanup errors so tool result remains primary.
    }
  }
}

/**
 * Create a persistent session for making multiple MCP tool calls without
 * restarting the server process on every call.
 *
 * Use this when you need to call several tools sequentially — for example a
 * sequence of Playwright steps where the browser must remain open between
 * calls. The underlying MCP server(s) are started lazily on the first
 * {@link ActSession.act} call and remain connected until you call
 * {@link ActSession.close}.
 *
 * **Always close the session** when you are done, preferably in a
 * `try/finally` block, to release the server process.
 *
 * Configuration resolution is identical to {@link act}:
 *   1. `options.mcpServers` — inline config passed to this call
 *   2. `ONE_ACT_MCP_SERVERS` env var (JSON string)
 *   3. `MCP_SERVERS` env var (JSON string)
 *   4. `~/.config/one/act.json` → `mcpServers` field
 *
 * @example
 * ```ts
 * import { createActSession } from "@one-agent/act";
 *
 * const session = await createActSession({
 *   mcpServers: {
 *     playwright: {
 *       transportType: "stdio",
 *       command: "npx",
 *       args: ["-y", "@playwright/mcp@latest", "--isolated"],
 *     },
 *   },
 * });
 *
 * try {
 *   await session.act("playwright_navigate", { url: "https://example.com" });
 *   const shot = await session.act("playwright_screenshot", {});
 *   console.log(shot.content);
 * } finally {
 *   await session.close();
 * }
 * ```
 */
export async function createActSession(options?: ActOptions): Promise<ActSession> {
  const mcpServers = await injectOAuthHeaders(
    options?.mcpServers ?? readConfiguredMcpServers(readActConfig()),
  );
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    throw new Error(
      "No MCP server configuration found. Provide options.mcpServers, set ONE_ACT_MCP_SERVERS, or configure mcpServers in ~/.config/one/act.json.",
    );
  }

  // Build a single server from ALL configured MCP servers (both daemon-flagged
  // and on-demand). Within a session the caller owns the lifetime, so there is
  // no reason to delegate to the background daemon; we start everything here
  // and keep it alive until close() is called.
  const getServer = createGetServerFromMcpServers(mcpServers);
  let server: ComposableMCPServer | null = null;

  return {
    async act(toolName: string, args: unknown): Promise<CallToolResult> {
      if (!server) {
        server = await getServer();
      }
      return getToolFn(server)(toolName, args);
    },

    async close(): Promise<void> {
      if (!server) return;
      const current = server;
      server = null;
      try {
        await Promise.race([
          current.close(),
          new Promise<void>((resolve) => {
            setTimeout(resolve, SERVER_CLOSE_TIMEOUT_MS);
          }),
        ]);
      } catch {
        // Ignore cleanup errors — primary result has already been returned.
      }
    },
  };
}

export function getToolFn(server: ComposableMCPServer) {
  const act = async (name: string, args: unknown): Promise<CallToolResult> => {
    if (name === MANUAL_TOOL_NAME) {
      const manualArgs = (args ?? {}) as { name?: string };
      const text = manualArgs.name
        ? formatManualTool(server, manualArgs.name)
        : formatManualList(server, false);
      return { content: [{ type: "text" as const, text }] };
    }

    const toolDef = server.getComposedTool(name);
    if (!toolDef) {
      return createUnknownToolResult(server, name);
    }

    return parseCallToolResult(await server.callTool(name, args));
  };

  return act;
}

type GetServerFn = () => Promise<ComposableMCPServer>;
type ComposedToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
};

type ActCommandOptions = {
  name?: string;
  args?: string;
  manual?: string | boolean;
  json?: boolean;
};

type ToolListingServer = ComposableMCPServer & {
  getInternalTools?: () => unknown;
  getAllComposedTools?: () => unknown;
  getAllTools?: () => unknown;
  getPublicTools?: () => unknown;
};

type SerializedImageContent = Omit<ImageContent, "data"> & {
  filePath: string;
};

type SerializedAudioContent = Omit<AudioContent, "data"> & {
  filePath: string;
};

type SerializedBlobResourceContents = Omit<BlobResourceContents, "blob"> & {
  filePath: string;
};

type SerializedEmbeddedResource = Omit<EmbeddedResource, "resource"> & {
  resource: TextResourceContents | SerializedBlobResourceContents;
};

type SerializedContentBlock =
  | TextContent
  | SerializedImageContent
  | SerializedAudioContent
  | ResourceLink
  | SerializedEmbeddedResource;

type SerializedCallToolResult = Omit<CallToolResult, "content"> & {
  content: SerializedContentBlock[];
};

const SERVER_CLOSE_TIMEOUT_MS = 1_500;

function parseMcpServersValue(value: unknown): McpServersConfig | null {
  if (value == null || value === "") return null;

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as McpServersConfig) : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid MCP servers JSON: ${message}`);
    }
  }

  if (typeof value === "object") {
    return value as McpServersConfig;
  }

  return null;
}

function readConfiguredMcpServers(actConfig: Record<string, unknown>): McpServersConfig | null {
  const envValue = process.env.ONE_ACT_MCP_SERVERS ?? process.env.MCP_SERVERS;
  const envParsed = parseMcpServersValue(envValue);
  if (envParsed) return envParsed;

  const configParsed =
    parseMcpServersValue(actConfig.MCP_SERVERS) ?? parseMcpServersValue(actConfig.mcpServers);
  return configParsed;
}

function getMcpServerNames(mcpServers: McpServersConfig): string[] {
  return Object.entries(selectEnabledMcpServers(mcpServers))
    .filter(([, config]) => Boolean(config && typeof config === "object"))
    .map(([name]) => name);
}

function selectOnDemandMcpServers(mcpServers: McpServersConfig): McpServersConfig {
  return Object.fromEntries(
    Object.entries(selectEnabledMcpServers(mcpServers)).filter(
      ([, config]) => config?.daemon !== true,
    ),
  ) as McpServersConfig;
}

function findToolServerName(toolName: string, mcpServers: McpServersConfig | null): string | null {
  if (!toolName || !mcpServers) return null;

  for (const serverName of Object.keys(selectEnabledMcpServers(mcpServers))) {
    if (
      toolName === serverName ||
      toolName.startsWith(`${serverName}_`) ||
      toolName.startsWith(`${serverName}.`)
    ) {
      return serverName;
    }
  }

  return null;
}

function isDaemonToolName(toolName: string, daemonMcpServers: McpServersConfig | null): boolean {
  return Boolean(findToolServerName(toolName, daemonMcpServers));
}

function createGetServerFromMcpServers(
  mcpServers: McpServersConfig,
  options?: { daemonOnly?: boolean },
): GetServerFn {
  let cachedServer: ComposableMCPServer | null = null;

  return async () => {
    if (cachedServer) return cachedServer;

    const selectedMcpServers = options?.daemonOnly
      ? selectDaemonMcpServers(mcpServers)
      : mcpServers;
    const runtimeMcpServers = normalizeMcpServersForRuntime(selectedMcpServers);
    const refs = getMcpServerNames(selectedMcpServers).map(
      (name) => `<tool name="${name}.__ALL__"/>` as ToolRefXml,
    );
    const composeEntry = {
      name: "one-act-runtime",
      description: "MCP tool runtime for act",
      deps: { mcpServers: runtimeMcpServers },
      options: { refs },
    };

    cachedServer = await mcpc(
      [{ name: "one-act", version: "1.0.0" }, { capabilities: { tools: {} } }],
      [composeEntry],
      { silent: true },
    );

    return cachedServer;
  };
}

function readActConfig(): Record<string, unknown> {
  if (!existsSync(ACT_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(ACT_CONFIG_PATH, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeActConfig(config: Record<string, unknown>) {
  mkdirSync(dirname(ACT_CONFIG_PATH), { recursive: true });
  writeFileSync(ACT_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function normalizeEnvMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      String(entryValue),
    ]),
  );
}

function parseEnvInput(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{")) {
    const parsed = parseJson(trimmed, "env");
    return normalizeEnvMap(parsed);
  }

  const result: Record<string, string> = {};
  const lines = trimmed
    .split(/\n|,|;/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid env entry: ${line}. Expected KEY=VALUE`);
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) {
      throw new Error(`Invalid env entry: ${line}. Key is required`);
    }
    result[key] = value;
  }

  return result;
}

function splitCommandLine(input: string): string[] {
  return input
    .trim()
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function runActConfigCli() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("act config requires an interactive terminal (TTY)");
  }

  const readRequiredText = async (message: string) => {
    const value = await text({
      message,
      validate(input) {
        return input?.trim() ? undefined : `${message} is required`;
      },
    });
    if (isCancel(value)) return null;
    return value.trim();
  };

  const readOptionalText = async (message: string) => {
    const value = await text({ message });
    if (isCancel(value)) return null;
    return value.trim();
  };

  intro("Configure act mcpServers");

  const serverName = await readRequiredText("MCP server name (e.g. playwright)");
  if (!serverName) {
    cancel("Operation cancelled.");
    return;
  }

  const transportType = await select<"stdio" | "streamable-http" | "sse">({
    message: "Transport type",
    initialValue: "stdio",
    options: [
      { label: "stdio", value: "stdio" },
      { label: "streamable-http", value: "streamable-http" },
      { label: "sse", value: "sse" },
    ],
  });

  if (isCancel(transportType)) {
    cancel("Operation cancelled.");
    return;
  }

  const serverConfig: Record<string, unknown> = { transportType };

  if (transportType === "stdio") {
    const commandLine = await readRequiredText(
      "command line (e.g. npx -y @playwright/mcp@latest --isolated)",
    );
    if (!commandLine) {
      cancel("Operation cancelled.");
      return;
    }

    const parts = splitCommandLine(commandLine);
    if (parts.length === 0) {
      throw new Error("command line must include a command");
    }

    serverConfig.command = parts[0];
    if (parts.length > 1) {
      serverConfig.args = parts.slice(1);
    }

    const envRaw = await readOptionalText(
      "env vars (optional, KEY=VALUE pairs like A=1,B=2 or JSON object)",
    );
    if (envRaw == null) {
      cancel("Operation cancelled.");
      return;
    }
    if (envRaw) {
      serverConfig.env = parseEnvInput(envRaw);
    }
  }

  if (transportType === "stdio") {
    const daemonMode = await confirm({
      message: "keep this MCP server running in one-act daemon?",
      initialValue: true,
    });
    if (isCancel(daemonMode)) {
      cancel("Operation cancelled.");
      return;
    }
    if (daemonMode) {
      serverConfig.daemon = true;
    }
  }

  if (transportType === "streamable-http" || transportType === "sse") {
    const url = await readRequiredText("url");
    if (!url) {
      cancel("Operation cancelled.");
      return;
    }
    serverConfig.url = url;

    const headersRaw = await readOptionalText(
      "headers (optional, KEY=VALUE pairs like A=1,B=2 or JSON object)",
    );
    if (headersRaw == null) {
      cancel("Operation cancelled.");
      return;
    }
    if (headersRaw) {
      serverConfig.headers = parseEnvInput(headersRaw);
    }

    const useOAuth = await confirm({
      message: "enable OAuth 2.1 PKCE auth? (run `act oauth login <name>` after setup)",
      initialValue: false,
    });
    if (isCancel(useOAuth)) {
      cancel("Operation cancelled.");
      return;
    }
    if (useOAuth) {
      serverConfig.auth = "oauth";
    } else {
      const daemonMode = await confirm({
        message: "keep this MCP server running in one-act daemon?",
        initialValue: false,
      });
      if (isCancel(daemonMode)) {
        cancel("Operation cancelled.");
        return;
      }
      if (daemonMode) {
        serverConfig.daemon = true;
      }
    }
  }

  const nextConfig = readActConfig();
  const previousMcpServers =
    nextConfig.mcpServers && typeof nextConfig.mcpServers === "object"
      ? (nextConfig.mcpServers as Record<string, unknown>)
      : {};

  nextConfig.mcpServers = {
    ...previousMcpServers,
    [serverName]: serverConfig,
  };

  writeActConfig(nextConfig);
  outro(`Saved config to ${ACT_CONFIG_PATH}`);
}

async function readStdin() {
  if (process.stdin.isTTY) {
    throw new Error('--args - requires piped stdin (example: echo \'{"k":"v"}\' | act tool -)');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCallToolResult(result: unknown): CallToolResult {
  const parsed = CallToolResultSchema.safeParse(result);
  if (parsed.success) {
    return parsed.data;
  }

  throw new Error(`Invalid MCP tool result: ${parsed.error.message}`);
}

function sanitizeFileName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "artifact";

  return trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getMimeExtension(mimeType?: string) {
  switch ((mimeType ?? "").toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/svg+xml":
      return ".svg";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/ogg":
      return ".ogg";
    case "audio/flac":
      return ".flac";
    case "audio/webm":
      return ".webm";
    case "application/pdf":
      return ".pdf";
    case "application/json":
      return ".json";
    case "text/plain":
      return ".txt";
    case "text/html":
      return ".html";
    case "text/csv":
      return ".csv";
    case "application/xml":
    case "text/xml":
      return ".xml";
    default:
      return "";
  }
}

function getUriExtension(uri?: string) {
  if (!uri) return "";

  try {
    const parsed = new URL(uri);
    return extname(parsed.pathname);
  } catch {
    return extname(uri);
  }
}

function getUriBaseName(uri?: string) {
  if (!uri) return "artifact";

  try {
    const parsed = new URL(uri);
    const name = basename(parsed.pathname);
    return name || "artifact";
  } catch {
    const name = basename(uri);
    return name || "artifact";
  }
}

function createArtifactFilePath(options: {
  kind: string;
  index: number;
  mimeType?: string;
  uri?: string;
}) {
  mkdirSync(ACT_OUTPUT_DIR, { recursive: true });

  const uriBaseName = sanitizeFileName(getUriBaseName(options.uri));
  const baseName = uriBaseName === "artifact" ? options.kind : uriBaseName;
  const derivedExtension =
    getUriExtension(options.uri) || getMimeExtension(options.mimeType) || ".bin";
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const fileName = `${timestamp}-${process.pid}-${options.index}-${sanitizeFileName(baseName)}${derivedExtension}`;
  return getOneConfigPath(`act-output/${fileName}`);
}

function writeBinaryArtifact(options: {
  kind: string;
  index: number;
  data: string;
  mimeType?: string;
  uri?: string;
}) {
  const filePath = createArtifactFilePath(options);
  writeFileSync(filePath, Buffer.from(options.data, "base64"));
  return filePath;
}

type CliRenderedItem = {
  text: string;
  json: SerializedContentBlock;
};

function renderTextContent(item: TextContent): CliRenderedItem {
  return {
    text: item.text,
    json: item,
  };
}

function renderImageContent(item: ImageContent, index: number, total: number): CliRenderedItem {
  const filePath = writeBinaryArtifact({
    kind: "image",
    index,
    data: item.data,
    mimeType: item.mimeType,
  });

  return {
    text: total === 1 ? filePath : `[image saved to ${filePath}]`,
    json: {
      type: item.type,
      mimeType: item.mimeType,
      annotations: item.annotations,
      _meta: item._meta,
      filePath,
    },
  };
}

function renderAudioContent(item: AudioContent, index: number, total: number): CliRenderedItem {
  const filePath = writeBinaryArtifact({
    kind: "audio",
    index,
    data: item.data,
    mimeType: item.mimeType,
  });

  return {
    text: total === 1 ? filePath : `[audio saved to ${filePath}]`,
    json: {
      type: item.type,
      mimeType: item.mimeType,
      annotations: item.annotations,
      _meta: item._meta,
      filePath,
    },
  };
}

function renderResourceLink(item: ResourceLink, total: number): CliRenderedItem {
  return {
    text: total === 1 ? item.uri : `[resource link ${item.uri}]`,
    json: item,
  };
}

function renderEmbeddedResource(
  item: EmbeddedResource,
  index: number,
  total: number,
): CliRenderedItem {
  const resource = item.resource;

  if ("text" in resource) {
    const textResource: TextResourceContents = resource;
    return {
      text:
        total === 1 || !textResource.uri
          ? textResource.text
          : `[resource ${textResource.uri}]\n${textResource.text}`,
      json: {
        ...item,
        resource: textResource,
      },
    };
  }

  const blobResource: BlobResourceContents = resource;
  const filePath = writeBinaryArtifact({
    kind: "resource",
    index,
    data: blobResource.blob,
    mimeType: blobResource.mimeType,
    uri: blobResource.uri,
  });

  return {
    text: total === 1 ? filePath : `[resource saved to ${filePath}]`,
    json: {
      ...item,
      resource: {
        uri: blobResource.uri,
        mimeType: blobResource.mimeType,
        _meta: blobResource._meta,
        filePath,
      },
    },
  };
}

function renderContentItem(item: ContentBlock, index: number, total: number): CliRenderedItem {
  switch (item.type) {
    case "text":
      return renderTextContent(item);
    case "image":
      return renderImageContent(item, index, total);
    case "audio":
      return renderAudioContent(item, index, total);
    case "resource_link":
      return renderResourceLink(item, total);
    case "resource":
      return renderEmbeddedResource(item, index, total);
  }
}

function serializeCliResult(result: CallToolResult): SerializedCallToolResult {
  const content = result.content;

  return {
    ...result,
    content: content.map((item, index) => renderContentItem(item, index + 1, content.length).json),
  };
}

function formatCliOutput(result: CallToolResult, forceJson: boolean) {
  if (forceJson) {
    return JSON.stringify(serializeCliResult(result), null, 2);
  }

  const content = result.content;
  const allText = content.every((item): item is TextContent => item.type === "text");
  if (allText) {
    return content.map((item) => item.text).join("\n");
  }

  return content
    .map((item, index) => renderContentItem(item, index + 1, content.length).text)
    .join("\n\n");
}

function parseJson(value: string, label: string) {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for ${label}: ${message}`);
  }
}

function restoreTerminalState() {
  // Best-effort reset for terminal modes that can leak if dependencies enable them.
  // Includes kitty CSI-u keyboard protocol and bracketed paste mode.
  const reset = "\u001b[<u\u001b[?2004l\u001b[?25h\u001b[0m\u001b>";
  if (process.stderr.isTTY) {
    process.stderr.write(reset);
  } else if (process.stdout.isTTY) {
    process.stdout.write(reset);
  }
}

function normalizeToolDefinitions(server: ComposableMCPServer): ComposedToolDefinition[] {
  const serverAny = server as ToolListingServer;
  const rawTools: unknown =
    serverAny.getInternalTools?.() ??
    serverAny.getAllComposedTools?.() ??
    serverAny.getAllTools?.() ??
    serverAny.getPublicTools?.();
  if (Array.isArray(rawTools)) {
    return rawTools
      .map((tool) => {
        if (!isRecord(tool)) return null;
        return {
          ...tool,
          name: String(tool.name ?? ""),
        };
      })
      .filter((tool): tool is ComposedToolDefinition => Boolean(tool))
      .filter((tool) => tool.name);
  }

  if (typeof rawTools === "object" && rawTools instanceof Map) {
    return [...rawTools.entries()].map(([name, tool]) => ({
      ...(tool as Record<string, unknown>),
      name: String((isRecord(tool) ? tool.name : undefined) ?? name),
    }));
  }

  if (rawTools && typeof rawTools === "object") {
    return Object.entries(rawTools).map(([name, tool]) => ({
      ...((tool as Record<string, unknown>) ?? {}),
      name: String((isRecord(tool) ? tool.name : undefined) ?? name),
    }));
  }

  return [];
}

function getAvailableToolNames(server: ComposableMCPServer) {
  return normalizeToolDefinitions(server)
    .map((tool) => tool.name)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function createUnknownToolResult(server: ComposableMCPServer, name: string): CallToolResult {
  const toolNames = getAvailableToolNames(server);
  const available = toolNames.length > 0 ? toolNames.join("\n") : "(no tools available)";
  const deUnderscoredName = name.replace(/^_+|_+$/g, "");
  const suggestion =
    deUnderscoredName && deUnderscoredName !== name && toolNames.includes(deUnderscoredName)
      ? `\nDid you mean: ${deUnderscoredName}`
      : "";

  return {
    content: [
      {
        type: "text" as const,
        text: `Tool ${name} not found.${suggestion}\nAvailable tools:\n${available}`,
      },
    ],
    isError: true,
  };
}

function formatManualList(server: ComposableMCPServer, forceJson: boolean) {
  const tools = normalizeToolDefinitions(server)
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (forceJson) {
    return JSON.stringify(tools, null, 2);
  }

  return tools
    .map((tool) => (tool.description ? `${tool.name}\t${tool.description}` : tool.name))
    .join("\n");
}

function formatManualTool(server: ComposableMCPServer, name: string) {
  const tool = server.getComposedTool(name) as Record<string, unknown> | undefined;
  if (!tool) {
    return JSON.stringify(createUnknownToolResult(server, name), null, 2);
  }

  return JSON.stringify(
    {
      name,
      ...tool,
    },
    null,
    2,
  );
}

type ManualListItem = {
  name: string;
  description: string;
};

function parseManualListOutput(output: string, forceJson: boolean): ManualListItem[] {
  if (!output.trim()) return [];

  if (forceJson) {
    const parsed = parseJson(output, "manual list");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => isRecord(item) && typeof item.name === "string")
      .map((item) => ({
        name: String(item.name),
        description: typeof item.description === "string" ? item.description : "",
      }));
  }

  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [name, ...descriptionParts] = line.split("\t");
      return {
        name: name.trim(),
        description: descriptionParts.join("\t").trim(),
      };
    })
    .filter((item) => item.name);
}

function formatMergedManualList(items: ManualListItem[], forceJson: boolean): string {
  const merged = [...new Map(items.map((item) => [item.name, item])).values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  if (forceJson) {
    return JSON.stringify(merged, null, 2);
  }

  return merged
    .map((item) => (item.description ? `${item.name}\t${item.description}` : item.name))
    .join("\n");
}

function isUnknownToolText(output: string, toolName: string): boolean {
  return output.includes(`Tool ${toolName} not found.`);
}

function isUnknownToolResult(result: CallToolResult, toolName: string): boolean {
  return Boolean(
    result.isError &&
    result.content.some(
      (item) => item.type === "text" && item.text.includes(`Tool ${toolName} not found.`),
    ),
  );
}

async function runActRequest(options: {
  toolName?: string;
  rawArgs?: string;
  cliOptions: ActCommandOptions;
  getServer?: GetServerFn;
  daemonClient?: ActDaemonClient;
  shouldCleanupServer: boolean;
  outputHelp: () => void;
}) {
  const showManual = Boolean(options.cliOptions?.manual);
  const manualToolName =
    typeof options.cliOptions?.manual === "string" ? options.cliOptions.manual : "";
  const forceJson = Boolean(options.cliOptions?.json);

  const namedTool =
    typeof options.cliOptions?.name === "string" && options.cliOptions.name.trim()
      ? options.cliOptions.name.trim()
      : "";
  const positionalTool = options.toolName ?? "";
  const toolName = namedTool || positionalTool;

  let needsStdin = options.cliOptions?.args === "-";
  let argsSource =
    typeof options.cliOptions?.args === "string" && options.cliOptions.args !== "-"
      ? options.cliOptions.args
      : (options.rawArgs ?? "");

  if (!needsStdin && argsSource === "-") {
    needsStdin = true;
    argsSource = "";
  }

  if (!showManual && (!toolName || (!argsSource && !needsStdin))) {
    options.outputHelp();
    process.exitCode = 1;
    return;
  }

  if (!options.getServer && !options.daemonClient) {
    throw new Error(
      "No MCP server configuration found. Configure mcpServers in ~/.config/one/act.json (or ONE_ACT_MCP_SERVERS).",
    );
  }

  let server: ComposableMCPServer | null = null;

  const ensureServer = async () => {
    if (!options.getServer) {
      throw new Error(
        "No MCP server configuration found. Configure mcpServers in ~/.config/one/act.json (or ONE_ACT_MCP_SERVERS).",
      );
    }

    if (!server) {
      server = await options.getServer();
    }

    return server;
  };

  try {
    if (showManual) {
      const runtimeServer = options.getServer ? await ensureServer() : null;
      let output: string;

      if (manualToolName) {
        const daemonOutput = options.daemonClient
          ? await options.daemonClient.formatManualTool(manualToolName)
          : null;
        output =
          daemonOutput && runtimeServer && isUnknownToolText(daemonOutput, manualToolName)
            ? formatManualTool(runtimeServer, manualToolName)
            : (daemonOutput ??
              formatManualTool(runtimeServer as ComposableMCPServer, manualToolName));
      } else if (options.daemonClient && runtimeServer) {
        const daemonItems = parseManualListOutput(
          await options.daemonClient.formatManualList(true),
          true,
        );
        const runtimeItems = parseManualListOutput(formatManualList(runtimeServer, true), true);
        output = formatMergedManualList([...daemonItems, ...runtimeItems], forceJson);
      } else if (runtimeServer) {
        output = formatManualList(runtimeServer, forceJson);
      } else {
        output = await options.daemonClient!.formatManualList(forceJson);
      }

      process.stdout.write(`${output}\n`);
      return;
    }

    const stdin = needsStdin ? await readStdin() : "";
    const toolArgs = parseJson(needsStdin ? stdin : argsSource, "--args");

    const daemonResult = options.daemonClient
      ? await options.daemonClient.callTool(toolName, toolArgs)
      : null;
    const result: CallToolResult =
      daemonResult && options.getServer && isUnknownToolResult(daemonResult, toolName)
        ? await getToolFn(await ensureServer())(toolName, toolArgs)
        : (daemonResult ?? (await getToolFn(await ensureServer())(toolName, toolArgs)));
    const output = formatCliOutput(result, forceJson);

    process.stdout.write(`${output}\n`);
    if (result.isError) {
      process.exitCode = 1;
    }
  } finally {
    const currentServer = server as { close: () => Promise<void> } | null;
    if (options.shouldCleanupServer && currentServer) {
      try {
        await Promise.race([
          currentServer.close(),
          new Promise<void>((resolve) => {
            setTimeout(resolve, SERVER_CLOSE_TIMEOUT_MS);
          }),
        ]);
      } catch {
        // Ignore cleanup errors so command result remains primary.
      }
    }

    // Always restore terminal modes because dependencies can leak keyboard
    // protocol / bracketed-paste state even when we reuse a server instance.
    restoreTerminalState();
  }
}

function createDaemonSpawnOptions(): ActDaemonSpawnOptions {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Cannot determine act CLI entrypoint for daemon startup.");
  }

  return {
    execPath: process.execPath,
    execArgv: process.execArgv,
    scriptPath,
  };
}

function requireConfiguredMcpServers(mcpServers: McpServersConfig | null): McpServersConfig {
  if (mcpServers) return mcpServers;
  throw new Error(
    "No MCP server configuration found. Configure mcpServers in ~/.config/one/act.json (or ONE_ACT_MCP_SERVERS).",
  );
}

async function runActDaemonServe(mcpServers: McpServersConfig) {
  const daemonMcpServers = selectDaemonMcpServers(mcpServers);
  const server = await createGetServerFromMcpServers(daemonMcpServers, { daemonOnly: true })();
  const configHash = computeDaemonConfigHash(daemonMcpServers);

  await runActDaemonServer({
    configHash,
    handlers: {
      formatManualList: (forceJson) => formatManualList(server, forceJson),
      formatManualTool: (name) => formatManualTool(server, name),
      callTool: (name, args) => getToolFn(server)(name, args),
      close: async () => {
        await server.close();
      },
    },
  });
}

function formatDaemonStatusOutput(status: Awaited<ReturnType<typeof getActDaemonStatus>>) {
  if (!status.running) {
    return `one-act daemon: stopped (${status.reason})`;
  }

  if (!status.healthy) {
    return `one-act daemon: unhealthy (${status.reason}) pid=${status.pid ?? "?"} port=${status.port ?? "?"}`;
  }

  return `one-act daemon: running pid=${status.pid} port=${status.port} started=${status.startedAt}`;
}

async function runDaemonCommand(
  action: string | undefined,
  configuredMcpServers: McpServersConfig | null,
  daemonConfigHash: string | undefined,
  daemonSpawnOptions: ActDaemonSpawnOptions | undefined,
) {
  const mcpServers = requireConfiguredMcpServers(configuredMcpServers);
  const daemonServers = selectDaemonMcpServers(mcpServers);

  if (Object.keys(daemonServers).length === 0) {
    throw new Error(
      "No daemon-enabled MCP servers found. Set daemon: true on a server in ~/.config/one/act.json.",
    );
  }

  const spawnOptions = daemonSpawnOptions ?? createDaemonSpawnOptions();
  const configHash = daemonConfigHash ?? computeDaemonConfigHash(daemonServers);

  switch (action) {
    case "start": {
      const status = await startActDaemon(spawnOptions, configHash);
      process.stdout.write(`${formatDaemonStatusOutput(status)}\n`);
      return;
    }
    case "stop": {
      const stopped = await stopActDaemon();
      process.stdout.write(
        `${stopped ? "one-act daemon: stopped" : "one-act daemon: not running"}\n`,
      );
      return;
    }
    case "restart": {
      await stopActDaemon();
      const status = await startActDaemon(spawnOptions, configHash);
      process.stdout.write(`${formatDaemonStatusOutput(status)}\n`);
      return;
    }
    case "status": {
      const status = await getActDaemonStatus(configHash);
      process.stdout.write(`${formatDaemonStatusOutput(status)}\n`);
      if (status.running && !status.healthy) {
        process.exitCode = 1;
      }
      return;
    }
    case "serve": {
      await runActDaemonServe(daemonServers);
      return;
    }
    default:
      throw new Error("Unknown daemon command. Use: start | status | restart | stop");
  }
}

/**
 * For every on-demand server that has `auth: "oauth"`, fetch (or refresh) its
 * access token and inject it as an `Authorization: Bearer` header.  Daemon
 * servers are intentionally skipped — they are long-lived processes that
 * cannot reliably track token expiry.
 */
async function injectOAuthHeaders(
  mcpServers: McpServersConfig | null,
): Promise<McpServersConfig | null> {
  if (!mcpServers) return null;

  const result: McpServersConfig = {};

  for (const [name, config] of Object.entries(mcpServers)) {
    const configRecord = config as unknown as Record<string, unknown>;

    if (
      config?.auth === "oauth" &&
      config.daemon !== true &&
      typeof configRecord.url === "string"
    ) {
      const token = await ensureOAuthToken(name, configRecord.url);
      if (token) {
        result[name] = {
          ...config,
          headers: {
            ...((configRecord.headers as Record<string, string> | undefined) ?? {}),
            Authorization: `Bearer ${token}`,
          },
        } as McpServersConfig[string];
        continue;
      }

      process.stderr.write(
        `Warning: no valid OAuth token for server "${name}". Run: act oauth login ${name}\n`,
      );
    }

    result[name] = config;
  }

  return result;
}

async function runOAuthCommand(
  subcommand: string | undefined,
  serverName: string | undefined,
  mcpServers: McpServersConfig | null,
): Promise<void> {
  switch (subcommand) {
    case "login": {
      if (!serverName) throw new Error("Usage: act oauth login <server-name>");

      const serverConfig = mcpServers?.[serverName];
      const serverRecord = serverConfig as Record<string, unknown> | undefined;
      if (!serverRecord || typeof serverRecord.url !== "string") {
        throw new Error(`Server "${serverName}" not found or has no URL in the current config`);
      }

      process.stderr.write(`Logging in to "${serverName}"...\n`);
      await runOAuthLogin(serverName, serverRecord.url);
      process.stderr.write(`Successfully logged in to "${serverName}".\n`);
      return;
    }

    case "logout": {
      if (!serverName) throw new Error("Usage: act oauth logout <server-name>");
      clearOAuthState(serverName);
      process.stderr.write(`Logged out of "${serverName}".\n`);
      return;
    }

    case "status": {
      const states = listOAuthStates();
      if (Object.keys(states).length === 0) {
        process.stdout.write("No OAuth sessions stored.\n");
        return;
      }
      for (const [name, info] of Object.entries(states)) {
        const tokenStatus = !info.hasToken
          ? "no token"
          : info.expiresAt && Date.now() > info.expiresAt
            ? "expired"
            : "active";
        const expiry = info.expiresAt ? new Date(info.expiresAt).toLocaleString() : "unknown";
        const expiryStr = info.hasToken && info.expiresAt ? ` (expires ${expiry})` : "";
        process.stdout.write(`  ${name}: ${tokenStatus}${expiryStr}\n`);
      }
      return;
    }

    default:
      throw new Error("Unknown oauth command. Use: login | logout | status");
  }
}

export async function runActCli(options?: { getServer?: GetServerFn; argv?: string[] }) {
  const args = options?.argv ?? process.argv.slice(2);
  if (args[0] === "auth") {
    throw new Error("'act auth' was removed. Use 'act config' instead.");
  }

  // Read raw config first so the oauth command can look up server URLs before
  // any token injection takes place.
  const _rawMcpServers = readConfiguredMcpServers(readActConfig());

  if (args[0] === "oauth" && !args.includes("--help") && !args.includes("-h")) {
    await runOAuthCommand(args[1], args[2], _rawMcpServers);
    return;
  }

  // Inject OAuth tokens into headers for on-demand servers that have auth:"oauth".
  const configuredMcpServers = await injectOAuthHeaders(_rawMcpServers);
  const _allDaemonServers = configuredMcpServers
    ? selectDaemonMcpServers(configuredMcpServers)
    : null;
  // selectDaemonMcpServers returns {} when no server has daemon:true — treat that as "no daemon"
  const daemonMcpServers =
    _allDaemonServers && Object.keys(_allDaemonServers).length > 0 ? _allDaemonServers : null;
  const onDemandMcpServers = configuredMcpServers
    ? selectOnDemandMcpServers(configuredMcpServers)
    : null;
  const daemonConfigHash = daemonMcpServers ? computeDaemonConfigHash(daemonMcpServers) : undefined;
  const daemonSpawnOptions = daemonMcpServers ? createDaemonSpawnOptions() : undefined;
  const getServer =
    options?.getServer ??
    (onDemandMcpServers && Object.keys(onDemandMcpServers).length > 0
      ? createGetServerFromMcpServers(onDemandMcpServers)
      : undefined);
  const shouldCleanupServer = !options?.getServer;

  if (args[0] === "daemon" && !args.includes("--help") && !args.includes("-h")) {
    await runDaemonCommand(args[1], configuredMcpServers, daemonConfigHash, daemonSpawnOptions);
    return;
  }

  const cli = cac("act");

  cli.usage(`${HELP_DESCRIPTION}\n\n[--manual [tool]] | <tool> <json|-> | daemon <command>`);
  cli.help((sections) => {
    sections.push({
      title: "Description",
      body: HELP_DESCRIPTION,
    });
    sections.push({
      title: "Quickstart",
      body: HELP_QUICKSTART.map((line) => `  ${line}`).join("\n"),
    });
    sections.push({
      title: "Configuration",
      body: HELP_CONFIGURATION.map((line) => `  ${line}`).join("\n"),
    });
    sections.push({
      title: "MCP Config Format",
      body: HELP_MCP_FORMAT.map((line) => `  ${line}`).join("\n"),
    });
    sections.push({
      title: "Daemon",
      body: HELP_DAEMON.map((line) => `  ${line}`).join("\n"),
    });
    sections.push({
      title: "Examples",
      body: HELP_EXAMPLES.map((line) => `  ${line}`).join("\n"),
    });
    return sections;
  });

  let pending: Promise<void> | null = null;

  cli.command("config", "Interactive setup for mcpServers config").action(() => {
    pending = runActConfigCli();
  });

  cli
    .command(
      "daemon <action>",
      "Manage daemon-enabled background MCP servers: start | status | restart | stop",
    )
    .action((action: string) => {
      pending = runDaemonCommand(
        action,
        configuredMcpServers,
        daemonConfigHash,
        daemonSpawnOptions,
      );
    });

  cli
    .command("oauth <action> [server]", "Manage OAuth sessions: login | logout | status")
    .action((action: string, server: string | undefined) => {
      pending = runOAuthCommand(action, server, _rawMcpServers);
    });

  cli
    .command("[tool] [toolArgs]", "Deterministic MCP tool invocation")
    .option("--name <tool>", "Tool name (equivalent to positional <tool>)")
    .option("--args <json|->", "Tool args JSON, or '-' to read JSON from stdin")
    .option("--manual [tool]", "Show tool list or one tool schema")
    .option("--json", "Force JSON output")
    .action(
      (
        toolName: string | undefined,
        toolArgs: string | undefined,
        cliOptions: ActCommandOptions,
      ) => {
        pending = (async () => {
          const manualToolName =
            typeof cliOptions.manual === "string" && cliOptions.manual.trim()
              ? cliOptions.manual.trim()
              : "";
          const routedToolName = manualToolName || toolName || cliOptions.name || "";
          const useDaemonOnly = isDaemonToolName(routedToolName, daemonMcpServers);
          const daemonClient =
            daemonSpawnOptions && daemonConfigHash && useDaemonOnly
              ? await ensureActDaemonClient(daemonSpawnOptions, daemonConfigHash)
              : undefined;
          const routedGetServer = useDaemonOnly ? undefined : getServer;

          await runActRequest({
            toolName,
            rawArgs: toolArgs,
            cliOptions,
            getServer: routedGetServer,
            daemonClient,
            shouldCleanupServer,
            outputHelp: () => cli.outputHelp(),
          });
        })();
      },
    );

  cli.parse(["node", "act", ...args]);

  if (args.includes("--help") || args.includes("-h")) {
    return;
  }

  if (pending) {
    await pending;
  }

  if (!options?.getServer) {
    process.exit(process.exitCode ?? 0);
  }
}
