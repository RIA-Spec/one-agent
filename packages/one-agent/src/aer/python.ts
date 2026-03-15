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
import { runPy } from "@mcpc/code-runner-mcp";
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

function extractUsefulFrame(lines: string[]): string | null {
  const execFrame = lines
    .slice()
    .reverse()
    .find((line) => /^\s*File\s+"<exec>",\s+line\s+\d+,\s+in\s+/.test(line));
  if (execFrame) return execFrame.trim();

  const pyFrame = lines
    .slice()
    .reverse()
    .find((line) => /^\s*File\s+".+",\s+line\s+\d+,\s+in\s+/.test(line));
  return pyFrame ? pyFrame.trim() : null;
}

function getErrorHint(summary: string): string | null {
  if (/^KeyError:\s*slice\(/.test(summary)) {
    return "Hint: A slice key was used on a mapping-like object. Check whether the target is a dict/object instead of a list/DataFrame/array.";
  }
  if (/^KeyError:/.test(summary)) {
    return "Hint: Missing key access. Confirm the key exists and the container type matches your indexing syntax.";
  }
  if (/^TypeError:/.test(summary)) {
    return "Hint: Type mismatch. Verify function arguments and intermediate value types.";
  }
  return null;
}

function prettifyPythonOutput(raw: string): { text: string; isError: boolean } {
  const text = raw.trim();
  if (!text) {
    return { text: "(no output)", isError: false };
  }

  const normalized = text.startsWith("Error: ") ? text.slice(7).trim() : text;
  const lines = normalized.split("\n").map((line) => line.replace(/\s+$/, ""));
  const tracebackIdx = lines.findIndex((line) =>
    line.startsWith("Traceback (most recent call last):"),
  );

  if (tracebackIdx < 0) {
    return { text: raw || "(no output)", isError: false };
  }

  const nonEmptyFromTrace = lines.slice(tracebackIdx).filter((line) => line.trim().length > 0);
  const summary = nonEmptyFromTrace[nonEmptyFromTrace.length - 1] || "Python execution failed";
  const usefulFrame = extractUsefulFrame(lines.slice(tracebackIdx));
  const hint = getErrorHint(summary);

  // If we matched a known error pattern, keep output concise and hide traceback.
  if (hint) {
    const conciseLines = [
      "Python execution failed",
      `Exception: ${summary}`,
      ...(usefulFrame ? [`Location: ${usefulFrame}`] : []),
      hint,
    ];
    return { text: conciseLines.join("\n"), isError: true };
  }

  // Fallback: show full traceback only when no prettify rule matched.
  const rawTrace = nonEmptyFromTrace.join("\n");
  const fallbackLines = [
    "Python execution failed",
    `Exception: ${summary}`,
    ...(usefulFrame ? [`Location: ${usefulFrame}`] : []),
    "",
    "--- Raw Traceback ---",
    rawTrace,
  ];

  return { text: fallbackLines.join("\n"), isError: true };
}

export function createPythonAER(config: PythonAERConfig) {
  const { nodeFSRoot, nodeFSMountPoint, reasonHandler, actHandler } = config;

  return {
    name: "one",
    description: `Python Action Execution Runtime - Execute Python with built-in reason() and act() functions.

  reason(prompt, example) -> {data, error}  (async, use with asyncio.run)
  act(name, args) -> result                 (async, use with asyncio.run, runs on host machine)
  act('__manual__', {}) -> list tools       (async)
  act('__manual__', {'name': 'bash'}) -> tool definition

Usage:
  import asyncio
  async def main():
      r = await reason('Summarize: ...', {'result': ''})
      if r.get('error'): return print(r['error'])
      print(r['data'].get('result', ''))
  asyncio.run(main())

Execute Python code in a Pyodide WebAssembly sandbox. Return stdout/stderr.

## When to Use
- Data analysis (pandas, numpy)
- Math/statistics
- Text processing
- Validate logic by execution
- File ops at ${nodeFSMountPoint} only

## Parameters

**code** (required): Python code. MUST use print() to see results. Tip: Use single quotes and avoid f-strings/backticks to reduce JSON escaping issues.

**packages** (optional): Map import names to PyPI package names. Use when names differ (e.g., sklearn->scikit-learn) or for indirectly imported packages (e.g., openpyxl for pandas).
Example: {"sklearn": "scikit-learn", "openpyxl": "openpyxl"}

## File System
- ONLY ${nodeFSMountPoint} is accessible
- Host path: ${nodeFSRoot}

## Examples

**Basic:**
\`\`\`python
import pandas as pd
df = pd.DataFrame({'a': [1, 2, 3]})
print(df.describe())
\`\`\`

**With mapping:**
\`\`\`python
from sklearn.datasets import load_iris
data = load_iris()
print(data.feature_names)
\`\`\`
Use packages: {"sklearn": "scikit-learn"}

## Common Errors
| Error | Fix |
|-------|-----|
| (no output) | Add print() statements |
| Permission denied | Use ${nodeFSMountPoint} path only |`,
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

      try {
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

        const pretty = prettifyPythonOutput(output);
        return {
          content: [{ type: "text" as const, text: pretty.text }],
          ...(pretty.isError ? { isError: true } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const pretty = prettifyPythonOutput(`Error: ${message}`);
        return {
          content: [{ type: "text" as const, text: pretty.text }],
          isError: true,
        };
      }
    },
  };
}
