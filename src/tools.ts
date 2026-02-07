import { mcpc } from "@mcpc-tech/core";
import { markdownLoaderPlugin } from "@mcpc/plugin-markdown-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { reason } from "./interfaces/reason";
import { getToolFn } from "./interfaces/act";
import { createBashTool } from "./interfaces/tools/bash.js";
import { createPythonAER } from "./aer/python.js";
import { createBashAER } from "./aer/bash.js";

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
    server = await mcpc(
      [{ name: "one", version: "1.0.0" }, { capabilities: { tools: {} } }],
      [composeFile],
      {
        plugins: [markdownLoaderPlugin() as any],
        setup: (server) => {
          // Register Python AER (Code Interpreter approach)
          if (AER_MODE === "python") {
            const pythonAER = createPythonAER({
              nodeFSRoot,
              nodeFSMountPoint,
              reasonHandler: reason,
              actHandler: getToolFn,
            });
            server.tool(
              pythonAER.name,
              pythonAER.description,
              pythonAER.parameters,
              async (args: any, extra: any) => pythonAER.execute(args, extra, server),
              { internal: false },
            );
            console.log(`✓ Python AER enabled`);

            // Register low-level bash tool for Python mode (to call shell commands from Python)
            const bashTool = createBashTool(nodeFSRoot);
            server.tool("bash", bashTool.description, bashTool.parameters, bashTool.execute, {
              internal: true,
            });
          }
          // Register Bash AER (Unix Philosophy approach)
          else if (AER_MODE === "bash") {
            const bashAER = createBashAER({
              cwd: projectRoot,
              reasonHandler: reason,
              actHandler: getToolFn,
            });
            server.tool(
              bashAER.name,
              bashAER.description,
              bashAER.parameters,
              async (args: any, extra: any) => bashAER.execute(args, extra, server),
              { internal: false },
            );
            console.log(`✓ Bash AER enabled`);
          } else {
            console.warn(`⚠ Unknown AER_MODE: ${AER_MODE}, defaulting to Python`);
            const pythonAER = createPythonAER({
              nodeFSRoot,
              nodeFSMountPoint,
              reasonHandler: reason,
              actHandler: getToolFn,
            });
            server.tool(
              pythonAER.name,
              pythonAER.description,
              pythonAER.parameters,
              async (args: any, extra: any) => pythonAER.execute(args, extra, server),
              { internal: false },
            );
            console.log(`✓ Python AER enabled (default)`);

            // Register low-level bash tool for Python mode (to call shell commands from Python)
            const bashTool = createBashTool(nodeFSRoot);
            server.tool("bash", bashTool.description, bashTool.parameters, bashTool.execute, {
              internal: true,
            });
          }
        },
      },
    );
  }
  return server;
}
