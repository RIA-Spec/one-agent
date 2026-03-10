import type { ComposableMCPServer } from "@mcpc-tech/core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

const ACT_CONFIG_PATH = join(process.cwd(), ".config", "one", "act.json");
const MANUAL_TOOL_NAME = "__manual__";
const HELP_TOOL_NAME = "__help__";

export function getToolFn(server: ComposableMCPServer) {
  const act = async (name: string, args: unknown) => {
    if (name === MANUAL_TOOL_NAME) {
      const manualArgs = (args ?? {}) as { name?: string };
      const text = manualArgs.name
        ? formatManualTool(server, manualArgs.name)
        : formatManualList(server, false);
      return { content: [{ type: "text" as const, text }] };
    }

    if (name === HELP_TOOL_NAME) {
      const text = `${getUsageText()}\n${formatManualList(server, false)}`.trim();
      return { content: [{ type: "text" as const, text }] };
    }

    const toolDef = server.getComposedTool(name);
    if (!toolDef) {
      return createUnknownToolResult(server, name);
    }

    return server.callTool(name, args as any);
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

async function loadGetServer(serverModule: string): Promise<GetServerFn> {
  const specifier =
    serverModule.startsWith(".") || serverModule.startsWith("/")
      ? pathToFileURL(resolvePath(process.cwd(), serverModule)).href
      : serverModule;

  const loaded = await import(specifier);
  const getServer = loaded.getServer as GetServerFn | undefined;
  if (!getServer) {
    throw new Error(`Module ${serverModule} does not export getServer()`);
  }
  return getServer;
}

function getUsageLines() {
  return [
    "Usage: act <tool> '{\"key\":\"value\"}' [--server-module ./server.ts] [--json]",
    "       act <tool> - [--server-module ./server.ts] [--json]",
    "       act --name <tool> --args '{\"key\":\"value\"}' [--server-module ./server.ts] [--json]",
    "       act --name <tool> --args - [--server-module ./server.ts] [--json]",
    "       act --manual [tool] [--server-module ./server.ts] [--json]",
    "       act --help",
  ];
}

function getUsageText() {
  return getUsageLines().join("\n");
}

function printUsage() {
  for (const line of getUsageLines()) {
    console.error(line);
  }
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

function readActValueFromEnvOrConfig(config: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const envValue = process.env[key];
    if (envValue != null && envValue !== "") return envValue;
    const configValue = config[key];
    if (typeof configValue === "string" && configValue !== "") return configValue;
  }
  return "";
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function formatCliOutput(result: any, forceJson: boolean) {
  if (forceJson) {
    return JSON.stringify(result, null, 2);
  }

  if (result && Array.isArray(result.content) && result.content.every((item: any) => item.type === "text")) {
    return result.content.map((item: any) => item.text ?? "").join("\n");
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

function normalizeToolDefinitions(server: ComposableMCPServer): ComposedToolDefinition[] {
  const rawTools = (server as any).getAllComposedTools?.();
  if (Array.isArray(rawTools)) {
    return rawTools
      .filter((tool): tool is Record<string, unknown> => Boolean(tool && typeof tool === "object"))
      .map((tool) => ({
        ...tool,
        name: String(tool.name ?? ""),
      }))
      .filter((tool) => tool.name);
  }

  if (rawTools instanceof Map) {
    return [...rawTools.entries()].map(([name, tool]) => ({
      ...(tool as Record<string, unknown>),
      name: String((tool as any)?.name ?? name),
    }));
  }

  if (rawTools && typeof rawTools === "object") {
    return Object.entries(rawTools).map(([name, tool]) => ({
      ...((tool as Record<string, unknown>) ?? {}),
      name: String((tool as any)?.name ?? name),
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

  return {
    content: [
      {
        type: "text" as const,
        text: `Tool ${name} not found. Available tools:\n${available}`,
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

export async function runActCli(options?: { getServer?: GetServerFn; argv?: string[] }) {
  const args = options?.argv ?? process.argv.slice(2);

  const actConfig = readActConfig();
  let toolName = "";
  let manualToolName = "";
  let argsSource = "";
  let needsStdin = false;
  let showManual = false;
  let showHelp = false;
  let serverModule = readActValueFromEnvOrConfig(actConfig, "ONE_ACT_SERVER_MODULE", "SERVER_MODULE");
  let forceJson = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--name") {
      toolName = args[++index] || "";
      continue;
    }

    if (arg === "--args") {
      const value = args[++index];
      if (!value) throw new Error("Missing value for --args");
      if (value === "-") {
        needsStdin = true;
      } else {
        argsSource = value;
      }
      continue;
    }

    if (arg === "--manual") {
      showManual = true;
      const next = args[index + 1];
      if (next && !next.startsWith("-")) {
        manualToolName = next;
        index++;
      }
      continue;
    }

    if (arg === "--server-module") {
      serverModule = args[++index] || "";
      continue;
    }

    if (arg === "--json") {
      forceJson = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }

    if (!arg.startsWith("-")) {
      if (!toolName && !showManual) {
        toolName = arg;
        continue;
      }

      if (!argsSource && !needsStdin && !showManual) {
        if (arg === "-") {
          needsStdin = true;
        } else {
          argsSource = arg;
        }
        continue;
      }
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  const getServer =
    options?.getServer ??
    (serverModule ? await loadGetServer(serverModule) : undefined);

  if (showHelp) {
    printUsage();
    if (!getServer) {
      return;
    }

    const server = await getServer();
    const output = formatManualList(server, forceJson);
    if (output) process.stdout.write(`${output}\n`);
    return;
  }

  if (!getServer) {
    throw new Error("No getServer() provider available. Pass --server-module or inject getServer programmatically.");
  }

  const server = await getServer();

  if (showManual) {
    const output = manualToolName
      ? formatManualTool(server, manualToolName)
      : formatManualList(server, forceJson);
    process.stdout.write(`${output}\n`);
    return;
  }

  if (!toolName || (!argsSource && !needsStdin)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const stdin = needsStdin ? await readStdin() : "";
  const toolArgs = parseJson(needsStdin ? stdin : argsSource, "--args");

  const act = getToolFn(server);
  const result: any = await act(toolName, toolArgs);
  const output = formatCliOutput(result, forceJson);

  process.stdout.write(`${output}\n`);
  if (result?.isError) {
    process.exitCode = 1;
  }
}
