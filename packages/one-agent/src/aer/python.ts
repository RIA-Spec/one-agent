/**
 * Python AER - Code-based Action Execution Runtime
 *
 * Agent controls flow via Python logic (conditions, loops, branches).
 * Built-in async reason() and act() functions for AI reasoning and MCP tool calls.
 *
 * Uses TS-side AST extraction (code-to-ast) for step plan generation,
 * and Python-side step tracking markers for real-time progress events.
 */

import { jsonSchema } from "ai";
import { getPythonPrompt, runPy } from "@mcpc/code-runner-mcp";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { emitProgress } from "../progress.js";
import { codeToAST } from "./code-to-ast.js";

export interface PythonAERConfig {
  nodeFSRoot: string;
  nodeFSMountPoint: string;
  reasonHandler: (prompt: string, example: any) => Promise<any>;
  actHandler: (server: any) => (name: string, args: unknown) => Promise<any>;
}

/**
 * Python code to wrap act/reason with step tracking.
 * Must be run AFTER handlers are injected but BEFORE user code.
 */
const STEP_TRACKING = `
_one_step_counter = [0]
_one_original_act = act
_one_original_reason = reason

async def _one_tracked_act(*args, **kwargs):
    _idx = _one_step_counter[0]
    _one_step_counter[0] += 1
    print(f'[ONE:STEP_START:{_idx}]', flush=True)
    try:
        _result = await _one_original_act(*args, **kwargs)
        print(f'[ONE:STEP_END:{_idx}:ok]', flush=True)
        return _result
    except Exception as _e:
        print(f'[ONE:STEP_END:{_idx}:error:{str(_e)[:100]}]', flush=True)
        raise

async def _one_tracked_reason(*args, **kwargs):
    _idx = _one_step_counter[0]
    _one_step_counter[0] += 1
    print(f'[ONE:STEP_START:{_idx}]', flush=True)
    try:
        _result = await _one_original_reason(*args, **kwargs)
        print(f'[ONE:STEP_END:{_idx}:ok]', flush=True)
        return _result
    except Exception as _e:
        print(f'[ONE:STEP_END:{_idx}:error:{str(_e)[:100]}]', flush=True)
        raise

act = _one_tracked_act
reason = _one_tracked_reason
`;

/** Markers emitted via stdout for step tracking */
const STEP_START_RE = /\[ONE:STEP_START:(\d+)\]/;
const STEP_END_RE = /\[ONE:STEP_END:(\d+):(ok|error)(?::([^\]]*))?\]/;

export function createPythonAER(config: PythonAERConfig) {
  const { nodeFSRoot, nodeFSMountPoint, reasonHandler, actHandler } = config;

  return {
    name: "run",
    description: `Python AER - Execute Python with built-in reason() and act() functions.

  reason(prompt, example) → {data, error}  (async, use with asyncio.run)
  act(name, args) → result                 (sync)
  act('__manual__', {}) → list tools       (async)
  act('__manual__', {'name': 'bash'}) → tool definition
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

      // TS-side AST extraction → emit plan before execution starts
      const steps = codeToAST(code, "python");
      if (steps.length > 0) {
        emitProgress({ type: "plan", steps });
      }

      // Build instrumented code:
      // 1. Step tracking wrappers (runtime markers for progress)
      // 2. Original user code
      const instrumentedCode = `
${STEP_TRACKING}

# === User Code ===
${code}
`;

      const stream = await runPy(instrumentedCode, {
        handlers: { reason: reasonHandler, act: actHandler(server) },
        packages,
        nodeFSRoot,
        nodeFSMountPoint,
      });

      const decoder = new TextDecoder();
      let output = "";

      for await (const chunk of stream) {
        const text = decoder.decode(chunk);

        // Process each line for step tracking markers
        const lines = text.split("\n");
        const cleanLines: string[] = [];

        for (const line of lines) {
          const trimmed = line.trim();

          // Parse step-start marker
          const startMatch = trimmed.match(STEP_START_RE);
          if (startMatch) {
            const stepIndex = parseInt(startMatch[1], 10);
            emitProgress({ type: "step-start", stepIndex });
            continue;
          }

          // Parse step-end marker
          const endMatch = trimmed.match(STEP_END_RE);
          if (endMatch) {
            const stepIndex = parseInt(endMatch[1], 10);
            const status = endMatch[2] as "ok" | "error";
            const error = endMatch[3] || undefined;
            emitProgress({ type: "step-end", stepIndex, status, error });
            continue;
          }

          // Regular output line
          cleanLines.push(line);
        }

        // Append clean output (without markers)
        output += cleanLines.join("\n");
      }

      return { content: [{ type: "text" as const, text: output || "(no output)" }] };
    },
  };
}
