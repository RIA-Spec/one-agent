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
  createWebFetchTool,
  createRiffTool,
} from "./interfaces/tools/index.js";
import { createPythonRAS } from "./ras/python.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const nodeFSRoot = process.env.NODE_FS_ROOT || projectRoot;
const nodeFSMountPoint = process.env.NODE_FS_MOUNT_POINT || projectRoot;

// RAS mode: "bash" | "python"
const RAS_MODE = (process.env.RAS_MODE || "python").toLowerCase();

// Use Markdown configuration file based on runtime mode.
const composeFile = resolve(
  __dirname,
  "..",
  RAS_MODE === "bash" ? "one-runner-bash.md" : "one-runner-python.md",
);

const DEV_MODE = true;

let server: Awaited<ReturnType<typeof mcpc>> | null = null;

export async function getServer() {
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
          plugins: [markdownLoaderPlugin() as any],
          setup: (server) => {
            // Register Bash RAS (Unix philosophy approach) - early return.
            if (RAS_MODE === "bash") {
              const bashRAS = createBashRAS({
                cwd: projectRoot,
                reasonHandler: adaptedReasonHandler,
                actHandler: adaptedActHandler,
              });
              server.tool(
                bashRAS.name,
                bashRAS.description,
                bashRAS.parameters,
                async (args: any, extra: any) => bashRAS.execute(args, extra, server),
                { internal: false },
              );

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

              const riffTool = createRiffTool(projectRoot);
              server.tool("riff", riffTool.description, riffTool.parameters, riffTool.execute, {
                internal: true,
              });

              console.log(`✓ Bash RAS enabled`);
              return;
            }

            // Register Python RAS (code interpreter approach) - default mode.
            if (RAS_MODE !== "python") {
              console.warn(`⚠ Unknown RAS_MODE: ${RAS_MODE}, defaulting to Python`);
            }

            const pythonRAS = createPythonRAS({
              nodeFSRoot,
              nodeFSMountPoint,
              reasonHandler: adaptedReasonHandler,
              actHandler: adaptedActHandler,
            });
            server.tool(
              pythonRAS.name,
              pythonRAS.description,
              pythonRAS.parameters,
              async (args: any, extra: any) => pythonRAS.execute(args, extra, server),
              { internal: false },
            );

            console.log(`✓ Python RAS enabled`);

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

            const riffTool = createRiffTool(nodeFSRoot);
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
