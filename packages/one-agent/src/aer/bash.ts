/**
 * Bash AER - Unix pipe-based Action Execution Runtime
 *
 * `reason` and `act` commands block until results are ready (like curl).
 * IPC: child writes req file → parent polls & processes → writes resp file → child reads.
 */

import { spawn } from "node:child_process";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { jsonSchema } from "ai";
import { emitProgress } from "../progress.js";
import { codeToAST } from "./code-to-ast.js";
import { makeScript } from "./bash-ipc-script.js";

type ActTextContent = { type?: string; text?: unknown };
type ActResultLike = {
  content?: ActTextContent[];
  isError?: boolean;
};

type BashReasonResult = {
  data?: unknown;
  error?: string;
};

export interface BashAERConfig {
  cwd: string;
  reasonHandler: (prompt: string, example: unknown) => Promise<BashReasonResult>;
  actHandler: (server: unknown) => (name: string, args: unknown) => Promise<ActResultLike>;
}

function formatActResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray((result as ActResultLike).content)
  ) {
    return ((result as ActResultLike).content ?? [])
      .map((entry) => (entry?.type === "text" ? String(entry.text ?? "") : JSON.stringify(entry, null, 2)))
      .join("\n");
  }
  return JSON.stringify(result, null, 2);
}

function serializeActResult(result: unknown): string {
  const isError =
    typeof result === "object" && result !== null && "isError" in result
      ? (result as ActResultLike).isError === true
      : false;

  return JSON.stringify(
    {
      text: formatActResultText(result),
      isError,
    },
    null,
    2,
  );
}

/** Process pending request files */
async function processRequests(
  dataDir: string,
  reasonHandler: BashAERConfig["reasonHandler"],
  actHandler: BashAERConfig["actHandler"],
  server: unknown,
  stepCounter?: { value: number },
) {
  for (const file of readdirSync(dataDir)) {
    const reqFile = join(dataDir, file);

    if (file.startsWith("one-reason-req-") && file.endsWith(".txt")) {
      const id = file.match(/one-reason-req-(.+)\.txt$/)?.[1];
      const respFile = join(dataDir, `one-reason-resp-${id}.txt`);
      if (existsSync(respFile)) continue;

      const stepIdx = stepCounter ? stepCounter.value++ : -1;
      if (stepIdx >= 0) emitProgress({ type: "step-start", stepIndex: stepIdx });

      try {
        const req = JSON.parse(readFileSync(reqFile, "utf-8"));
        try {
          unlinkSync(reqFile);
        } catch {}
        const log = console.log,
          err = console.error;
        console.log = console.error = () => {};
        const result = await reasonHandler(req.prompt, req.example);
        console.log = log;
        console.error = err;
        const raw = result.error ? { error: result.error } : (result.data ?? result);
        const data = typeof raw === "string" ? JSON.parse(raw) : raw;
        writeFileSync(respFile, JSON.stringify(data, null, 2));
        if (stepIdx >= 0) emitProgress({ type: "step-end", stepIndex: stepIdx, status: "ok" });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        try {
          unlinkSync(reqFile);
        } catch {}
        writeFileSync(
          join(dataDir, `one-reason-resp-${id}.txt`),
          JSON.stringify({ error: errorMessage }, null, 2),
        );
        if (stepIdx >= 0)
          emitProgress({
            type: "step-end",
            stepIndex: stepIdx,
            status: "error",
            error: errorMessage.substring(0, 100),
          });
      }
    }

    if (file.startsWith("one-act-req-") && file.endsWith(".txt")) {
      const id = file.match(/one-act-req-(.+)\.txt$/)?.[1];
      const respFile = join(dataDir, `one-act-resp-${id}.txt`);
      if (existsSync(respFile)) continue;

      const stepIdx = stepCounter ? stepCounter.value++ : -1;
      if (stepIdx >= 0) emitProgress({ type: "step-start", stepIndex: stepIdx });

      try {
        const req = JSON.parse(readFileSync(reqFile, "utf-8"));
        try {
          unlinkSync(reqFile);
        } catch {}
        const result = await actHandler(server)(req.toolName, req.toolArgs);
        writeFileSync(respFile, serializeActResult(result));
        if (stepIdx >= 0) {
          emitProgress({
            type: "step-end",
            stepIndex: stepIdx,
            status: result?.isError ? "error" : "ok",
            error: result?.isError ? formatActResultText(result).slice(0, 100) : undefined,
          });
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        try {
          unlinkSync(reqFile);
        } catch {}
        if (id) writeFileSync(join(dataDir, `one-act-resp-${id}.txt`), `Error: ${errorMessage}`);
        if (stepIdx >= 0)
          emitProgress({
            type: "step-end",
            stepIndex: stepIdx,
            status: "error",
            error: errorMessage.substring(0, 100),
          });
      }
    }
  }
}

export function createBashAER(config: BashAERConfig) {
  return {
    name: "bash",
    description: `Bash AER - Execute bash with built-in reason and act commands (block until done, like curl).

  reason --prompt "text" [--prompt -] [--structure '{"key":""}']
  act --manual [tool]
  act --help
  act <tool> '{"key":"value"}'
  act <tool> -
  act --name "name" --args '{"key":"value"}' [--args -]

Example: echo "Hi" | reason --prompt "Translate:" --prompt - --structure '{"t":""}' | jq -r '.t'`,
    parameters: jsonSchema({
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        stdin: { type: "string", description: "Optional stdin" },
      },
      required: ["command"],
    }),
    execute: async (
      { command, stdin }: { command: string; stdin?: string },
      _extra?: unknown,
      server?: unknown,
    ) => {
      const { cwd, reasonHandler, actHandler } = config;
      const dataDir = join(cwd, "data");
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

      // Write helper scripts
      const reasonCjs = join(dataDir, "reason.cjs"),
        actCjs = join(dataDir, "act.cjs");
      writeFileSync(reasonCjs, makeScript(dataDir, "reason"));
      writeFileSync(actCjs, makeScript(dataDir, "act"));
      writeFileSync(join(dataDir, "reason"), `#!/bin/bash\nexec node "${reasonCjs}" "$@"\n`, {
        mode: 0o755,
      });
      writeFileSync(join(dataDir, "act"), `#!/bin/bash\nexec node "${actCjs}" "$@"\n`, {
        mode: 0o755,
      });

      // TS-side AST extraction → emit plan before execution starts
      const steps = codeToAST(command, "bash");
      if (steps.length > 0) {
        emitProgress({ type: "plan", steps });
      }

      // Step counter for tracking progress during execution
      const stepCounter = { value: 0 };

      // Poll for requests while bash runs
      let active = true;
      const poll = setInterval(() => {
        if (active) processRequests(dataDir, reasonHandler, actHandler, server, stepCounter);
      }, 50);

      try {
        const result = await new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number | null;
        }>((resolve, reject) => {
          const proc = spawn("bash", ["-c", command], {
            cwd,
            env: { ...process.env, PATH: `${dataDir}:${process.env.PATH}` },
          });
          let stdout = "",
            stderr = "";
          proc.stdout.on("data", (d: Buffer) => {
            stdout += d;
          });
          proc.stderr.on("data", (d: Buffer) => {
            stderr += d;
          });
          if (stdin) {
            proc.stdin.write(stdin);
            proc.stdin.end();
          }
          proc.on("error", reject);
          proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
        });

        active = false;
        clearInterval(poll);
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return {
          content: [{ type: "text" as const, text: output || "(no output)" }],
          ...(result.exitCode !== 0 && { isError: true }),
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        active = false;
        clearInterval(poll);
        return { content: [{ type: "text" as const, text: errorMessage }], isError: true };
      }
    },
  };
}
