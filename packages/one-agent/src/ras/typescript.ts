/**
 * TypeScript RAS - Code-based Reason-able Action Space runtime
 *
 * Agent controls deterministic execution via TypeScript/JavaScript logic.
 * Built-in async reason() and act() functions provide local structured judgment and external actions inside the RAS.
 */

import { jsonSchema } from "ai";
import { runJS } from "@mcpc-tech/code-runner-mcp";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import ts from "typescript";
import { emitProgress } from "../progress.js";
import { codeToAST } from "./code-to-ast.js";

export interface TypeScriptRASConfig {
  nodeFSRoot: string;
  nodeFSMountPoint: string;
  reasonHandler: (prompt: string, example: any) => Promise<any>;
  actHandler: (server: any) => (name: string, args: unknown) => Promise<any>;
  agentHandler: (server: any) => (prompt: string, config?: unknown) => Promise<any>;
}

const STEP_TRACKING = `
let _one_step_counter = 0;
const _one_original_act = globalThis.act;
const _one_original_reason = globalThis.reason;

globalThis.act = async (...args) => {
  const _idx = _one_step_counter++;
  console.log('[ONE:STEP_START:' + _idx + ']');
  try {
    const _result = await _one_original_act(...args);
    console.log('[ONE:STEP_END:' + _idx + ':ok]');
    return _result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('[ONE:STEP_END:' + _idx + ':error:' + msg.slice(0, 100) + ']');
    throw err;
  }
};

globalThis.reason = async (...args) => {
  const _idx = _one_step_counter++;
  console.log('[ONE:STEP_START:' + _idx + ']');
  try {
    const _result = await _one_original_reason(...args);
    console.log('[ONE:STEP_END:' + _idx + ':ok]');
    return _result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('[ONE:STEP_END:' + _idx + ':error:' + msg.slice(0, 100) + ']');
    throw err;
  }
};
`;

const STEP_START_RE = /^\[ONE:STEP_START:(\d+)\]$/;
const STEP_END_RE = /^\[ONE:STEP_END:(\d+):(ok|error)(?::([^\]]*))?\]$/;

function prettifyJavaScriptOutput(raw: string): { text: string; isError: boolean } {
  const text = raw.trim();
  if (!text) {
    return { text: "(no output)", isError: false };
  }

  const stderrLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[stderr]"));
  const hasStderr = stderrLines.length > 0;
  const hasExplicitError =
    /^Error:/m.test(text) || /\b(?:TypeError|ReferenceError|SyntaxError|RangeError):/.test(text);

  if (!hasExplicitError && !hasStderr) {
    return { text: raw, isError: false };
  }

  const lines = text.split("\n").map((line) => line.trimEnd());
  const summaryLine =
    [...lines]
      .reverse()
      .find((line) => /(?:TypeError|ReferenceError|SyntaxError|RangeError):/.test(line)) ||
    stderrLines[0] ||
    lines[0] ||
    "JavaScript execution failed";
  const locationLine = lines.find((line) => /<anonymous>|\.ts:\d+|\.js:\d+/.test(line));

  const out = [
    "JavaScript execution failed",
    `Exception: ${summaryLine}`,
    ...(locationLine ? [`Location: ${locationLine}`] : []),
  ];

  return { text: out.join("\n"), isError: true };
}

function transpileTypeScript(code: string): string {
  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: false,
      sourceMap: false,
      inlineSourceMap: false,
      removeComments: false,
    },
    reportDiagnostics: true,
  });

  const diagnostics = result.diagnostics || [];
  const fatal = diagnostics.find((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal && fatal.messageText) {
    throw new Error(ts.flattenDiagnosticMessageText(fatal.messageText, "\n"));
  }

  return result.outputText;
}

export function createTypeScriptRAS(config: TypeScriptRASConfig) {
  const { nodeFSRoot, nodeFSMountPoint, reasonHandler, actHandler, agentHandler } = config;

  return {
    name: "one",
    description: `TypeScript Reason-able Action Space runtime - Execute TypeScript/JavaScript inside a bounded workspace with built-in reason(), act(), and optional agent() extension.

  reason(prompt, example) -> {data, error}  (async, use with await)
  act(name, args) -> result                 (async, runs on host machine)
  act('__manual__', {}) -> list tools       (async)
  act('__manual__', {'name': 'bash'}) -> tool definition
  agent(prompt, config?) -> {data:{text,trajectory}}|{error}  (async delegated worker; returns text plus ATIF trajectory on success)

Usage:
  const r = await reason('Goal: summarize the local evidence. Observation: ... Constraints: return {result}.', { result: '' });
  if (r.error) {
    console.log(r.error);
    return;
  }
  console.log(r.data?.result ?? '');

Execute TypeScript/JavaScript in a Deno sandbox. Return stdout/stderr.

## When to Use
- API/data processing
- Text processing
- Validation by execution
- File ops at ${nodeFSMountPoint} only

## Parameters

**code** (required): TypeScript or JavaScript code to execute. Use console.log() for output.

## File System
- ONLY ${nodeFSMountPoint} is accessible
- Host path: ${nodeFSRoot}

## Common Errors
| Error | Fix |
|-------|-----|
| (no output) | Add console.log() statements |
| Permission denied | Use ${nodeFSMountPoint} path only |`,
    parameters: jsonSchema({
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "TypeScript or JavaScript code to execute. Use console.log() for output.",
        },
      },
      required: ["code"],
    }),
    execute: async ({ code }: { code: string }, _extra?: any, server?: any) => {
      if (!existsSync("./data")) mkdirSync("./data", { recursive: true });
      writeFileSync(`./data/${Date.now()}.ts`, code);

      const steps = codeToAST(code, "typescript");
      if (steps.length > 0) {
        emitProgress({ type: "plan", steps });
      }

      let compiledCode: string;
      try {
        compiledCode = transpileTypeScript(code);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `TypeScript compile failed\n${message}` }],
          isError: true,
        };
      }

      const instrumentedCode = `
${STEP_TRACKING}

// === User Code (compiled from TS if needed) ===
${compiledCode}
`;

      try {
        const stream = runJS(instrumentedCode, {
          handlers: {
            reason: reasonHandler,
            act: actHandler(server),
            agent: agentHandler(server),
          },
        });

        const decoder = new TextDecoder();
        let output = "";

        for await (const chunk of stream) {
          const text = decoder.decode(chunk);
          const lines = text.split("\n");
          const cleanLines: string[] = [];

          for (const line of lines) {
            const trimmed = line.trim();

            const startMatch = trimmed.match(STEP_START_RE);
            if (startMatch) {
              const stepIndex = parseInt(startMatch[1], 10);
              emitProgress({ type: "step-start", stepIndex });
              continue;
            }

            const endMatch = trimmed.match(STEP_END_RE);
            if (endMatch) {
              const stepIndex = parseInt(endMatch[1], 10);
              const status = endMatch[2] as "ok" | "error";
              const error = endMatch[3] || undefined;
              emitProgress({ type: "step-end", stepIndex, status, error });
              continue;
            }

            cleanLines.push(line);
          }

          output += cleanLines.join("\n");
        }

        const pretty = prettifyJavaScriptOutput(output);
        return {
          content: [{ type: "text" as const, text: pretty.text }],
          ...(pretty.isError ? { isError: true } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const pretty = prettifyJavaScriptOutput(`Error: ${message}`);
        return {
          content: [{ type: "text" as const, text: pretty.text }],
          isError: true,
        };
      }
    },
  };
}
