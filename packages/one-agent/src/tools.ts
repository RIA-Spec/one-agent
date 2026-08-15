import { mcpc } from "@mcpc-tech/core";
import { markdownLoaderPlugin } from "@mcpc-tech/plugin-markdown-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { reason } from "./interfaces/reason";
import { getToolFn } from "./interfaces/act";
import { agent as delegatedAgent } from "./interfaces/agent";
import type { AgentConfig, AgentResult } from "./interfaces/agent";
import { createBashTool } from "./interfaces/tools/bash.js";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createWebSearchTool,
  createWebFetchTool,
  createRiffTool,
} from "./interfaces/tools/index.js";
import { createPythonRAS } from "./ras/python.js";
import { createTypeScriptRAS } from "./ras/typescript.js";
import { createBashRAS } from "./ras/bash.js";
import { convertToAISDKTools } from "@mcpc-tech/core";
import { tool, jsonSchema } from "ai";

type RASReasonResult = {
  data?: unknown;
  error?: string;
};

type RASActResult = {
  content?: Array<{ type?: string; text?: unknown }>;
  isError?: boolean;
};

type RASAgentResult = AgentResult;

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return fallback;
}

const AGENT_EXTENSION_ENABLED = parseBooleanEnv("ONE_AGENT_EXTENSION_ENABLED", false);
const AGENT_EXTENSION_INJECT_SYSTEM_PROMPT = parseBooleanEnv(
  "ONE_AGENT_EXTENSION_INJECT_SYSTEM_PROMPT",
  true,
);
/**
 * Delegated worker policy injected into `agent(prompt, config)` when the extension is enabled.
 *
 * Contract:
 *   agent(prompt, config?) -> { data: { text, trajectory } } | { error }
 *
 * `trajectory` uses ATIF:
 * https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md
 *
 * Common config:
 * - budget: { maxSteps, maxMinutes, maxOutputTokens, maxRetries }
 * - model
 * - on_error: "fail" | "return_error" | "retry_within_budget"
 * - extension: { enabled, injectSystemPrompt, injectTools }
 */
const AGENT_EXTENSION_BASE_SYSTEM_PROMPT = `You are a bounded delegated worker. Complete only the delegated subtask using tools actually available in your own session. Base claims on observed evidence. Return a concise result with what was verified and what remains unknown. Stop on budget, permission, or runtime boundaries; do not claim unavailable capabilities.`;

const adaptedReasonHandler = async (prompt: string, example: unknown): Promise<RASReasonResult> => {
  const result = await reason(prompt, example);
  return {
    data: result.data,
    error: result.error ?? undefined,
  };
};

const adaptedActHandler =
  (server: unknown) =>
  (name: string, args: unknown): Promise<RASActResult> =>
    getToolFn(server as Parameters<typeof getToolFn>[0])(name, args) as Promise<RASActResult>;

const adaptedAgentHandler =
  (_server: unknown) =>
  async (prompt: string, config: unknown): Promise<RASAgentResult> => {
    if (!AGENT_EXTENSION_ENABLED) {
      return {
        error: "agent() extension is disabled. Set ONE_AGENT_EXTENSION_ENABLED=1 to enable it.",
      };
    }

    return delegatedAgent(prompt, buildDelegatedAgentConfig(config));
  };

export function buildDelegatedAgentConfig(config: unknown): AgentConfig {
  const baseConfig =
    config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  const extensionBase =
    baseConfig.extension && typeof baseConfig.extension === "object"
      ? (baseConfig.extension as Record<string, unknown>)
      : {};

  const injectedSystem = AGENT_EXTENSION_INJECT_SYSTEM_PROMPT
    ? AGENT_EXTENSION_BASE_SYSTEM_PROMPT
    : "";

  return {
    ...(baseConfig as AgentConfig),
    extension: {
      ...extensionBase,
      enabled: true,
      ...(injectedSystem ? { injectSystemPrompt: injectedSystem } : {}),
    },
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const nodeFSRoot = process.env.NODE_FS_ROOT || projectRoot;
const nodeFSMountPoint = process.env.NODE_FS_MOUNT_POINT || projectRoot;

const DEV_MODE = true;

let server: Awaited<ReturnType<typeof mcpc>> | null = null;

export async function getServer() {
  // Read RAS_MODE lazily so callers (e.g. tests) can override process.env before calling.
  const rawRASMode = (process.env.RAS_MODE || "python").toLowerCase();
  const RAS_MODE =
    rawRASMode === "bash"
      ? "bash"
      : rawRASMode === "typescript" ||
          rawRASMode === "ts" ||
          rawRASMode === "javascript" ||
          rawRASMode === "js"
        ? "typescript"
        : "python";

  // Use Markdown configuration file based on runtime mode.
  const composeFile = resolve(
    __dirname,
    "..",
    RAS_MODE === "bash" ? "one-runner-bash.md" : "one-runner-python.md",
  );
  if (!server || DEV_MODE) {
    // Temporarily switch cwd to one-agent package root so npx-based MCP server
    // resolution remains stable when launched from a different workspace package.
    const originalCwd = process.cwd();
    try {
      process.chdir(projectRoot);
      server = await mcpc(
        [{ name: "one", version: "1.0.0" }, { capabilities: { tools: {} } }],
        [composeFile],
        {
          silent: true,
          plugins: [markdownLoaderPlugin() as any],
          setup: (server) => {
            // Register Bash RAS (Unix philosophy approach) - early return.
            if (RAS_MODE === "bash") {
              const bashRAS = createBashRAS({
                cwd: projectRoot,
                reasonHandler: adaptedReasonHandler,
                actHandler: adaptedActHandler,
                agentHandler: adaptedAgentHandler,
              });

              const hostBashTool = createBashTool(projectRoot);
              server.tool(
                "bash",
                hostBashTool.description,
                hostBashTool.parameters,
                hostBashTool.execute,
                { internal: true },
              );

              server.tool(
                bashRAS.name,
                bashRAS.description,
                bashRAS.parameters,
                async (args: any, extra: any) => bashRAS.execute(args, extra, server),
                { internal: false },
              );

              const readTool = createReadTool(projectRoot);
              server.tool("read", readTool.description, readTool.parameters, readTool.execute, {
                internal: true,
              });

              const writeTool = createWriteTool(projectRoot);
              server.tool("write", writeTool.description, writeTool.parameters, writeTool.execute, {
                internal: true,
              });

              const editTool = createEditTool(projectRoot);
              server.tool("edit", editTool.description, editTool.parameters, editTool.execute, {
                internal: true,
              });

              // Register low-level web tools so Bash RAS can call them via `act`.
              const webSearchTool = createWebSearchTool();
              server.tool(
                "websearch",
                webSearchTool.description,
                webSearchTool.parameters,
                webSearchTool.execute,
                { internal: true },
              );

              const webFetchTool = createWebFetchTool();
              server.tool(
                "webfetch",
                webFetchTool.description,
                webFetchTool.parameters,
                webFetchTool.execute,
                { internal: true },
              );

              const riffTool = createRiffTool(projectRoot, "bash");
              server.tool("riff", riffTool.description, riffTool.parameters, riffTool.execute, {
                internal: true,
              });

              return;
            }

            // Register code RAS modes (Python/TypeScript).
            if (RAS_MODE === "typescript") {
              const tsRAS = createTypeScriptRAS({
                nodeFSRoot,
                nodeFSMountPoint,
                reasonHandler: adaptedReasonHandler,
                actHandler: adaptedActHandler,
                agentHandler: adaptedAgentHandler,
              });
              server.tool(
                tsRAS.name,
                tsRAS.description,
                tsRAS.parameters,
                async (args: any, extra: any) => tsRAS.execute(args, extra, server),
                { internal: false },
              );
            } else {
              const pythonRAS = createPythonRAS({
                nodeFSRoot,
                nodeFSMountPoint,
                reasonHandler: adaptedReasonHandler,
                actHandler: adaptedActHandler,
                agentHandler: adaptedAgentHandler,
              });
              server.tool(
                pythonRAS.name,
                pythonRAS.description,
                pythonRAS.parameters,
                async (args: any, extra: any) => pythonRAS.execute(args, extra, server),
                { internal: false },
              );
            }

            // Register low-level tools for Python mode
            const bashTool = createBashTool(nodeFSRoot);
            server.tool("bash", bashTool.description, bashTool.parameters, bashTool.execute, {
              internal: true,
            });

            const readTool = createReadTool(nodeFSRoot);
            server.tool("read", readTool.description, readTool.parameters, readTool.execute, {
              internal: true,
            });

            const writeTool = createWriteTool(nodeFSRoot);
            server.tool("write", writeTool.description, writeTool.parameters, writeTool.execute, {
              internal: true,
            });

            const editTool = createEditTool(nodeFSRoot);
            server.tool("edit", editTool.description, editTool.parameters, editTool.execute, {
              internal: true,
            });

            const webSearchTool = createWebSearchTool();
            server.tool(
              "websearch",
              webSearchTool.description,
              webSearchTool.parameters,
              webSearchTool.execute,
              { internal: true },
            );

            const webFetchTool = createWebFetchTool();
            server.tool(
              "webfetch",
              webFetchTool.description,
              webFetchTool.parameters,
              webFetchTool.execute,
              { internal: true },
            );

            const riffTool = createRiffTool(nodeFSRoot, "python");
            server.tool("riff", riffTool.description, riffTool.parameters, riffTool.execute, {
              internal: true,
            });
          },
        },
      );
    } finally {
      process.chdir(originalCwd);
    }
  }
  return server;
}

/**
 * Helper function for Chat SDK integration.
 * Returns AI SDK compatible tools object from the MCP server.
 */
export async function getOneTools() {
  const one = convertToAISDKTools(await getServer(), {
    tool: tool,
    jsonSchema: jsonSchema,
  })?.["one"];
  return { one };
}
