import { mcpc } from "@mcpc-tech/core";
import { markdownLoaderPlugin } from "@mcpc/plugin-markdown-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { reason } from "./interfaces/reason";
import { getToolFn } from "./interfaces/act";
import { createBashTool } from "./interfaces/tools/bash.js";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createWebSearchTool,
} from "./interfaces/tools/index.js";
import { createPythonAER } from "./aer/python.js";
import { createBashAER } from "./aer/bash.js";
import { convertToAISDKTools } from "@mcpc-tech/core";
import { tool, jsonSchema } from "ai";

type AERReasonResult = {
  data?: unknown;
  error?: string;
};

type AERActResult = {
  content?: Array<{ type?: string; text?: unknown }>;
  isError?: boolean;
};

const adaptedReasonHandler = async (prompt: string, example: unknown): Promise<AERReasonResult> => {
  const result = await reason(prompt, example);
  return {
    data: result.data,
    error: result.error ?? undefined,
  };
};

const adaptedActHandler =
  (server: unknown) =>
  (name: string, args: unknown): Promise<AERActResult> =>
    getToolFn(server as Parameters<typeof getToolFn>[0])(name, args) as Promise<AERActResult>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const nodeFSRoot = process.env.NODE_FS_ROOT || projectRoot;
const nodeFSMountPoint = process.env.NODE_FS_MOUNT_POINT || projectRoot;

// AER Mode: "bash" | "python"
// Controls which Action Execution Runtime to enable (only one at a time)
const AER_MODE = (process.env.AER_MODE || "python").toLowerCase();

// Use Markdown configuration file based on AER mode
const composeFile = resolve(
  __dirname,
  "..",
  AER_MODE === "bash" ? "one-runner-bash.md" : "one-runner-python.md",
);

const DEV_MODE = true;

let server: Awaited<ReturnType<typeof mcpc>> | null = null;

export async function getServer() {
  if (!server || DEV_MODE) {
    // Temporarily switch cwd to one-agent package root so that
    // npx can find locally installed MCP servers (e.g. @playwright/mcp)
    // when the process is launched from a different workspace package.
    const originalCwd = process.cwd();
    try {
      process.chdir(projectRoot);
      server = await mcpc(
        [{ name: "one", version: "1.0.0" }, { capabilities: { tools: {} } }],
        [composeFile],
        {
          plugins: [markdownLoaderPlugin() as any],
          setup: (server) => {
            // Register Bash AER (Unix Philosophy approach) - early return
            if (AER_MODE === "bash") {
              const bashAER = createBashAER({
                cwd: projectRoot,
                reasonHandler: adaptedReasonHandler,
                actHandler: adaptedActHandler,
              });
              server.tool(
                bashAER.name,
                bashAER.description,
                bashAER.parameters,
                async (args: any, extra: any) => bashAER.execute(args, extra, server),
                { internal: false },
              );

              // Register low-level web tools so Bash AER can call them via `act`.
              const webSearchTool = createWebSearchTool();
              server.tool(
                "websearch",
                webSearchTool.description,
                webSearchTool.parameters,
                webSearchTool.execute,
                { internal: true },
              );

              console.log(`✓ Bash AER enabled`);
              return;
            }

            // Register Python AER (Code Interpreter approach) - default mode
            if (AER_MODE !== "python") {
              console.warn(`⚠ Unknown AER_MODE: ${AER_MODE}, defaulting to Python`);
            }

            const pythonAER = createPythonAER({
              nodeFSRoot,
              nodeFSMountPoint,
              reasonHandler: adaptedReasonHandler,
              actHandler: adaptedActHandler,
            });
            server.tool(
              pythonAER.name,
              pythonAER.description,
              pythonAER.parameters,
              async (args: any, extra: any) => pythonAER.execute(args, extra, server),
              { internal: false },
            );
            console.log(`✓ Python AER enabled`);

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
