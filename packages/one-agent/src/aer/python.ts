/**
 * Python AER - Code-based Action Execution Runtime
 *
 * Agent controls flow via Python logic (conditions, loops, branches).
 * Built-in async reason() and act() functions for AI reasoning and MCP tool calls.
 */

import { jsonSchema } from "ai";
import { getPythonPrompt, runPy } from "@mcpc/code-runner-mcp";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

export interface PythonAERConfig {
  nodeFSRoot: string;
  nodeFSMountPoint: string;
  reasonHandler: (prompt: string, example: any) => Promise<any>;
  actHandler: (server: any) => (name: string, prompt: string) => Promise<any>;
}

export function createPythonAER(config: PythonAERConfig) {
  const { nodeFSRoot, nodeFSMountPoint, reasonHandler, actHandler } = config;

  return {
    name: "run",
    description: `Python AER - Execute Python with built-in reason() and act() functions.

  reason(prompt, example) → {data, error}  (async, use with asyncio.run)
  act(name, prompt) → result               (sync)
File system: ${nodeFSMountPoint} → ${nodeFSRoot}

Usage:
  import asyncio
  async def main():
      result = await reason('Summarize: ...', '')
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
          description:
            'Map import names to PyPI package names. Use when names differ or for indirectly imported packages. Example: {"sklearn": "scikit-learn", "openpyxl": "openpyxl"}',
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
        handlers: { reason: reasonHandler, act: actHandler(server) },
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
