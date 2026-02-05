import { jsonSchema } from "ai";
import { mcpc } from "@mcpc-tech/core";
import { getPythonPrompt, runPy } from "@mcpc/code-runner-mcp";
import { markdownLoaderPlugin } from "@mcpc/plugin-markdown-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ai } from "./functions/ai";
import { getToolFn, getToolFnNext } from "./functions/tool";
import { createBashTool } from "./tools/bash.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const nodeFSRoot = process.env.NODE_FS_ROOT || projectRoot;
const nodeFSMountPoint = process.env.NODE_FS_MOUNT_POINT || projectRoot;

// Use Markdown configuration file
const composeFile = resolve(__dirname, "..", "one-runner-next.md");

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
          server.tool(
            "run",
            `ONE Runner - Execute Python with built-in ai() function.

Features:
  • Built-in async ai(prompt, example) function for intelligent analysis
  • Returns {data, error} with structured data (booleans, arrays, objects) for dynamic decisions
  • Combine code computation with AI intelligence
  • File system access at ${nodeFSMountPoint} (maps to ${nodeFSRoot})

CRITICAL: ai() MUST be used inside async function with asyncio.run():

import asyncio

async def main():
    result = await ai('Summarize in 1 sentence: Python is a programming language.', '')
    print(result['data'])

asyncio.run(main())

DO NOT use 'await ai()' directly - will cause SyntaxError!
See manual for complete examples.

${getPythonPrompt(nodeFSRoot, nodeFSMountPoint)}
`,
            jsonSchema({
              type: "object",
              properties: {
                code: {
                  type: "string",
                  description: "Python code to execute. MUST use print() to see results.",
                },
                packages: {
                  type: "object",
                  additionalProperties: { type: "string" },
                  description:
                    'Map import names to PyPI package names. Use when names differ or for indirectly imported packages. Example: {"sklearn": "scikit-learn", "openpyxl": "openpyxl"}',
                },
              },
              required: ["code"],
            }),
            async (
              {
                code,
                packages,
              }: {
                code: string;
                packages?: Record<string, string>;
              },
              extra,
            ) => {
              const stream = await runPy(code, {
                handlers: {
                  ai,
                  // tool: getToolFn(server)
                  tool: getToolFnNext(server),
                },
                packages,
                nodeFSRoot,
                nodeFSMountPoint,
              });
              const decoder = new TextDecoder();
              let output = "";
              for await (const chunk of stream) {
                output += decoder.decode(chunk);
              }
              return {
                content: [{ type: "text", text: output || "(no output)" }],
              };
            },
            { internal: true },
          );

          // Register bash tool
          const bashTool = createBashTool(nodeFSRoot);
          server.tool("bash", bashTool.description, bashTool.parameters, bashTool.execute);
        },
      },
    );
  }
  return server;
}
