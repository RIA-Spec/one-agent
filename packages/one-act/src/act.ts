import { mcpc, type ComposableMCPServer, type ToolRefXml } from "@mcpc-tech/core";
import { cac } from "cac";
import { cancel, confirm, intro, isCancel, outro, select, text } from "@clack/prompts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getOneConfigPath } from "./config-path.js";
import {
  computeDaemonConfigHash,
  ensureActDaemonClient,
  getActDaemonStatus,
  isDaemonRuntimeEnabled,
  normalizeMcpServersForRuntime,
  runActDaemonServer,
  startActDaemon,
  stopActDaemon,
  type ActDaemonClient,
  type ActDaemonSpawnOptions,
  type McpServersConfig,
} from "./daemon.js";

const ACT_CONFIG_PATH = getOneConfigPath("act.json");
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
  "File config keys: daemon, mcpServers",
  "Env override: ONE_ACT_MCP_SERVERS='<json>'",
  "Daemon override: ONE_ACT_DAEMON=true|false",
];
const HELP_DAEMON = [
  "act daemon start     Start background daemon and keep MCP servers alive",
  "act daemon status    Show daemon status",
  "act daemon restart   Restart daemon after config changes",
  "act daemon stop      Stop daemon and release MCP processes",
];
const HELP_EXAMPLES = [
  "act --manual",
  "act --manual chrome-devtools_navigate_page",
  'act chrome-devtools_new_page \'{"url":"https://example.com"}\'',
  "act daemon start",
  "ONE_ACT_MCP_SERVERS=" +
    '\'{"chrome-devtools":{"transportType":"stdio","command":"npx","args":["-y","chrome-devtools-mcp@latest","--autoConnect"]}}\' act --manual',
];

export function getToolFn(server: ComposableMCPServer) {
  const act = async (name: string, args: unknown) => {
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

    return server.callTool(name, args);
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
  return Object.entries(mcpServers)
    .filter(([, config]) => Boolean(config && typeof config === "object"))
    .map(([name]) => name);
}

function createGetServerFromMcpServers(mcpServers: McpServersConfig): GetServerFn {
  let cachedServer: ComposableMCPServer | null = null;

  return async () => {
    if (cachedServer) return cachedServer;

    const runtimeMcpServers = normalizeMcpServersForRuntime(mcpServers);
    const refs = getMcpServerNames(mcpServers).map(
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

  const daemonMode = await confirm({
    message: "keep this MCP server running in one-act daemon?",
    initialValue: transportType === "stdio",
  });
  if (isCancel(daemonMode)) {
    cancel("Operation cancelled.");
    return;
  }
  if (daemonMode) {
    serverConfig.daemon = true;
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

function formatCliOutput(result: unknown, forceJson: boolean) {
  if (forceJson) {
    return JSON.stringify(result, null, 2);
  }

  if (isRecord(result) && Array.isArray(result.content)) {
    const allText = result.content.every(
      (item) =>
        isRecord(item) &&
        item.type === "text" &&
        (item.text == null || typeof item.text === "string"),
    );
    if (allText) {
      return result.content
        .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
        .join("\n");
    }
  }

  return JSON.stringify(result, null, 2);
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

function createUnknownToolResult(server: ComposableMCPServer, name: string) {
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

  const server = options.getServer ? await options.getServer() : null;
  try {
    if (showManual) {
      const output = options.daemonClient
        ? manualToolName
          ? await options.daemonClient.formatManualTool(manualToolName)
          : await options.daemonClient.formatManualList(forceJson)
        : manualToolName
          ? formatManualTool(server as ComposableMCPServer, manualToolName)
          : formatManualList(server as ComposableMCPServer, forceJson);
      process.stdout.write(`${output}\n`);
      return;
    }

    const stdin = needsStdin ? await readStdin() : "";
    const toolArgs = parseJson(needsStdin ? stdin : argsSource, "--args");

    const result = options.daemonClient
      ? await options.daemonClient.callTool(toolName, toolArgs)
      : await getToolFn(server as ComposableMCPServer)(toolName, toolArgs);
    const output = formatCliOutput(result, forceJson);

    process.stdout.write(`${output}\n`);
    if (isRecord(result) && Boolean(result.isError)) {
      process.exitCode = 1;
    }
  } finally {
    if (options.shouldCleanupServer && server) {
      try {
        await server.close();
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
  const server = await createGetServerFromMcpServers(mcpServers)();
  const configHash = computeDaemonConfigHash(mcpServers);

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
  switch (action) {
    case "start": {
      const mcpServers = requireConfiguredMcpServers(configuredMcpServers);
      const spawnOptions = daemonSpawnOptions ?? createDaemonSpawnOptions();
      const status = await startActDaemon(spawnOptions, computeDaemonConfigHash(mcpServers));
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
      const mcpServers = requireConfiguredMcpServers(configuredMcpServers);
      const spawnOptions = daemonSpawnOptions ?? createDaemonSpawnOptions();
      await stopActDaemon();
      const status = await startActDaemon(spawnOptions, computeDaemonConfigHash(mcpServers));
      process.stdout.write(`${formatDaemonStatusOutput(status)}\n`);
      return;
    }
    case "status": {
      const status = await getActDaemonStatus(daemonConfigHash);
      process.stdout.write(`${formatDaemonStatusOutput(status)}\n`);
      if (status.running && !status.healthy) {
        process.exitCode = 1;
      }
      return;
    }
    case "serve": {
      await runActDaemonServe(requireConfiguredMcpServers(configuredMcpServers));
      return;
    }
    default:
      throw new Error("Unknown daemon command. Use: start | stop | restart | status");
  }
}

export async function runActCli(options?: { getServer?: GetServerFn; argv?: string[] }) {
  const args = options?.argv ?? process.argv.slice(2);
  if (args[0] === "auth") {
    throw new Error("'act auth' was removed. Use 'act config' instead.");
  }

  const actConfig = readActConfig();
  const configuredMcpServers = readConfiguredMcpServers(actConfig);
  const daemonEnabled =
    !options?.getServer &&
    Boolean(configuredMcpServers) &&
    isDaemonRuntimeEnabled(actConfig, configuredMcpServers as McpServersConfig);
  const daemonConfigHash = configuredMcpServers
    ? computeDaemonConfigHash(configuredMcpServers)
    : undefined;
  const daemonSpawnOptions = daemonEnabled ? createDaemonSpawnOptions() : undefined;
  const getServer =
    daemonEnabled || !configuredMcpServers
      ? options?.getServer
      : (options?.getServer ?? createGetServerFromMcpServers(configuredMcpServers));
  const shouldCleanupServer = !options?.getServer && !daemonEnabled;

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
    .command("daemon <action>", "Manage background daemon: start | status | restart | stop")
    .action((action: string) => {
      pending = runDaemonCommand(
        action,
        configuredMcpServers,
        daemonConfigHash,
        daemonSpawnOptions,
      );
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
          const daemonClient =
            daemonEnabled && daemonSpawnOptions && daemonConfigHash
              ? await ensureActDaemonClient(daemonSpawnOptions, daemonConfigHash)
              : undefined;

          await runActRequest({
            toolName,
            rawArgs: toolArgs,
            cliOptions,
            getServer,
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
}
