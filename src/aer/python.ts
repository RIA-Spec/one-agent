/**
 * Python AER - Code-based Action Execution Runtime
 *
 * Agent controls flow via Python logic (conditions, loops, branches).
 * Built-in async ai() and tool() functions for AI reasoning and MCP tool calls.
 */

import { jsonSchema } from "ai";
import { getPythonPrompt, runPy } from "@mcpc/code-runner-mcp";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

export interface PythonAERConfig {
  nodeFSRoot: string;
  nodeFSMountPoint: string;
  aiHandler: (prompt: string, example: any) => Promise<any>;
  toolHandler: (server: any) => (name: string, prompt: string) => Promise<any>;
}

export function createPythonAER(config: PythonAERConfig) {
  const { nodeFSRoot, nodeFSMountPoint, aiHandler, toolHandler } = config;

  return {
    name: "run",
    description: `Python AER - Execute Python with built-in ai() and tool() functions.

ai(prompt, example) → {data, error}  (async, use with asyncio.run)
tool(name, prompt) → result           (sync)
File system: ${nodeFSMountPoint} → ${nodeFSRoot}

Usage:
  import asyncio
  async def main():
      result = await ai('Summarize: ...', '')
      print(result['data'])
  asyncio.run(main())

${getPythonPrompt(nodeFSRoot, nodeFSMountPoint)}`,
    parameters: jsonSchema({
      type: "object",
      properties: {
        code: { type: "string", description: "Python code to execute. Use print() for output." },
        packages: {
          type: "object",
          additionalProperties: { type: "string" },
          description: 'Import-to-PyPI map, e.g. {"sklearn": "scikit-learn"}',
        },
      },
      required: ["code"],
    }),
    execute: async (
      { code, packages }: { code: string; packages?: Record<string, string> },
      _extra?: any,
      server?: any,
    ) => {
      if (!existsSync("./data")) mkdirSync("./data", { recursive: true });
      writeFileSync(`./data/${Date.now()}.py`, code);

      const stream = await runPy(code, {
        handlers: { ai: aiHandler, tool: toolHandler(server) },
        packages,
        nodeFSRoot,
        nodeFSMountPoint,
      });

      const decoder = new TextDecoder();
      let output = "";
      for await (const chunk of stream) output += decoder.decode(chunk);

      return { content: [{ type: "text" as const, text: output || "(no output)" }] };
    },
  };
}
