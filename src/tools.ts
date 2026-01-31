import { jsonSchema } from 'ai';
import { mcpc } from '@mcpc-tech/core';
import type { ComposeDefinition } from '@mcpc-tech/core';
import { runPy, getPythonPrompt } from '@mcpc/code-runner-mcp';

const nodeFSRoot = '/Users/beet/Downloads'
const nodeFSMountPoint = '/data';

const DESCRIPTION = `Execute Python code in a secure Pyodide sandbox with support for any PyPI package installation and ai(message) async function support.`;

const MANUAL = `Use for:
- Data analysis and scientific computing (pandas, numpy)
- Machine learning experiments (scikit-learn)
- Mathematical calculations and statistics
- Text processing and NLP tasks
- Algorithm validation and prototyping`;

const compose: ComposeDefinition = {
  name: "inside-runner",
  description: DESCRIPTION,
  manual: MANUAL,
  deps: { mcpServers: {} },
  options: { mode: "agentic" },
};

const DEV_MODE = true;

let server: Awaited<ReturnType<typeof mcpc>> | null = null;

export async function getServer() {
  if (!server || DEV_MODE) {
    server = await mcpc(
      [{ name: "inside", version: "1.0.0" }, { capabilities: { tools: {} } }],
      [compose],
      (server) => {
        console.log("\n=== BEFORE server.tool() ===");
        console.log("Public:", server.getPublicToolNames());
        console.log("Internal:", server.getInternalToolNames());

        server.tool(
          "run",
          `Run Python code with ai(message) async function support.
In your code, you can use
\`\`\` 
import asyncio

async def main():
    result = await ai("Hello")

asyncio.run(main())
\`\`\` 
to get response from LLM, it's a built-in function.
${getPythonPrompt(nodeFSRoot, nodeFSMountPoint)}
`,
          jsonSchema({
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Python source code to executePython code to execute. MUST use print() to see results.',
              },
              packages: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Map import names to PyPI package names. Use when names differ or for indirectly imported packages. Example: {"sklearn": "scikit-learn", "openpyxl": "openpyxl"}',
              },
            }
          }),
          async ({ code, packages }: { code: string, packages?: Record<string, string> }, extra) => {
            const { ai } = await import('./ai.js');
            const stream = await runPy(code, {
              handlers: { ai: ai },
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
          { internal: true }
        );

        console.log("\n=== AFTER server.tool() ===");
        console.log("Public:", server.getPublicToolNames());
        console.log("Internal:", server.getInternalToolNames());
      }
    );
  }
  return server;
}
