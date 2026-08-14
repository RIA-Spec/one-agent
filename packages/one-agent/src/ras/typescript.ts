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
import { prepareOneInputs, type OneInputs } from "./inputs.js";

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
    description: `Use \`one\` when a task needs TypeScript/JavaScript execution, current workspace evidence, internal tool calls, or a multi-step local control loop. Code runs in bounded Deno with async \`reason()\` and \`act()\`. \`reason()\` turns noisy runtime evidence into a small structured judgment; \`act()\` accesses registered tools. Put multiline source, regexes, prompts, and tool arguments in \`inputs\` instead of code string literals. Print the final decision-relevant result with console.log. The mounted workspace (${nodeFSMountPoint}) is the only accessible file system.`,
    parameters: jsonSchema({
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "TypeScript or JavaScript code to execute. Use console.log() for output.",
        },
        inputs: {
          type: "object",
          additionalProperties: true,
          description:
            "JSON data exposed to TypeScript/JavaScript code as inputs. Use it for source text and tool arguments that should not be embedded in code.",
        },
      },
      required: ["code"],
    }),
    execute: async (
      { code, inputs }: { code: string; inputs?: OneInputs },
      _extra?: any,
      server?: any,
    ) => {
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

      const instrumentedCode = `
const inputs = JSON.parse(
  new TextDecoder().decode(Uint8Array.from(atob("${encodedInputs}"), (char) => char.charCodeAt(0)))
);

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
