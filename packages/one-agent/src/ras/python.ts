/**
 * Python RAS - Code-based Reason-able Action Space runtime
 *
 * Agent controls deterministic execution via Python logic (conditions, loops, branches).
 * Built-in async reason() and act() functions provide local structured judgment and external actions inside the RAS.
 *
 * Uses TS-side AST extraction (code-to-ast) for step plan generation,
 * and Python-side step tracking markers for real-time progress events.
 */

import { jsonSchema } from "ai";
import { runPy } from "@mcpc-tech/code-runner-mcp";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { emitProgress } from "../progress.js";
import { codeToAST } from "./code-to-ast.js";
import { prepareOneInputs, type OneInputs } from "./inputs.js";

export interface PythonRASConfig {
  nodeFSRoot: string;
  nodeFSMountPoint: string;
  reasonHandler: (prompt: string, example: any) => Promise<any>;
  actHandler: (server: any) => (name: string, args: unknown) => Promise<any>;
  agentHandler: (server: any) => (prompt: string, config?: unknown) => Promise<any>;
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

/**
 * Python code to intercept riff inline-exec payloads and run them in the current Pyodide context.
 * This avoids nested runPy calls and preserves stdout handlers so outer print() output is not lost.
 * Must run AFTER STEP_TRACKING so the step-tracked act/reason are captured.
 */
const INLINE_EXEC_HANDLER = `
import asyncio as _one_asyncio
import base64 as _one_b64

_one_inline_exec_prefix = '__ONE_INLINE_EXEC__:'

_one_orig_act_ie = act

async def _one_act_inline_exec(*_args, **_kwargs):
    _result = await _one_orig_act_ie(*_args, **_kwargs)
    if not isinstance(_result, dict):
        return _result
    _content = _result.get('content')
    if not isinstance(_content, list) or not _content:
        return _result
    _first = _content[0]
    _text = _first.get('text', '') if isinstance(_first, dict) else ''
    if not isinstance(_text, str) or not _text.startswith(_one_inline_exec_prefix):
        return _result

    _encoded = _text[len(_one_inline_exec_prefix):]
    try:
        _code = _one_b64.b64decode(_encoded.encode('utf-8')).decode('utf-8')
    except Exception:
        return _result

    if not _code:
        return _result
    # Patch asyncio.run so the riff's asyncio.run(main()) captures the coroutine
    # instead of creating a new event loop (which would fail inside an async context).
    _one_captured = []
    _one_orig_run = _one_asyncio.run
    def _one_capture_run(_coro, **_kw):
        _one_captured.append(_coro)
    _one_asyncio.run = _one_capture_run
    _exec_ns = {'act': act, 'reason': reason}
    try:
        exec(compile(_code, '<riff>', 'exec'), _exec_ns)
    finally:
        _one_asyncio.run = _one_orig_run
    for _coro in _one_captured:
        await _coro
    return {
        'ok': True,
        'content': [
            {
                'type': 'text',
                'text': 'Riff executed inline. Output is streamed to stdout during execution.'
            }
        ]
    }

act = _one_act_inline_exec
`;

/** Markers emitted via stdout for step tracking */
const STEP_START_RE = /^\[ONE:STEP_START:(\d+)\]$/;
const STEP_END_RE = /^\[ONE:STEP_END:(\d+):(ok|error)(?::([^\]]*))?\]$/;

let pythonNodeFsMounted = false;

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

export function createPythonRAS(config: PythonRASConfig) {
  const { nodeFSRoot, nodeFSMountPoint, reasonHandler, actHandler, agentHandler } = config;

  return {
    name: "one",
    description: `Python Reason-able Action Space runtime - Execute Python inside a bounded workspace with built-in reason(), act(), and optional agent() extension.

  reason(prompt, example) -> {data, error}  (async, use with asyncio.run, returns bounded local judgment)
  act(name, args) -> result                 (async, use with asyncio.run, runs on host machine)
  act('__manual__', {}) -> list tools       (async)
  act('__manual__', {'name': 'bash'}) -> tool definition
  agent(prompt, config?) -> {data:{text,trajectory}}|{error}  (async delegated worker; returns text plus ATIF trajectory on success)
  inputs                                      (JSON object supplied outside code)

Usage:
  import asyncio
  async def main():
      r = await reason('Goal: summarize the local evidence. Observation: ... Constraints: return {result}.', {'result': ''})
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

**inputs** (optional): JSON object exposed to code as \`inputs\`. Put source text, tool arguments, prompts, regexes, and other data here instead of embedding them in Python string literals.

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
        inputs: {
          type: "object",
          additionalProperties: true,
          description:
            "JSON data exposed to Python code as inputs. Use it for source text and tool arguments that should not be embedded in code.",
        },
      },
      required: ["code"],
    }),
    execute: async (
      {
        code,
        packages,
        inputs,
      }: { code: string; packages?: Record<string, string>; inputs?: OneInputs },
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

      let encodedInputs: string;
      try {
        encodedInputs = prepareOneInputs(inputs).encoded;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }

      // Build instrumented code:
      // 1. Decode host-validated inputs without interpolating raw data into Python source
      // 2. Step tracking wrappers (runtime markers for progress)
      // 3. Inline exec handler (intercepts riff.run to avoid nested runPy)
      // 4. Original user code
      const instrumentedCode = `
import base64 as _one_inputs_b64
import json as _one_inputs_json
inputs = _one_inputs_json.loads(_one_inputs_b64.b64decode('${encodedInputs}').decode('utf-8'))

${STEP_TRACKING}

${INLINE_EXEC_HANDLER}

# === User Code ===
${code}
`;

      try {
        const runOptions = {
          handlers: {
            reason: reasonHandler,
            act: actHandler(server),
            agent: agentHandler(server),
          },
          packages,
          ...(pythonNodeFsMounted
            ? {}
            : {
                nodeFSRoot,
                nodeFSMountPoint,
              }),
        };

        const stream = await runPy(instrumentedCode, runOptions);
        pythonNodeFsMounted = true;

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
