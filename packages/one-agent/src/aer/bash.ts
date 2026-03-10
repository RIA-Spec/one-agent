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

export interface BashAERConfig {
  cwd: string;
  reasonHandler: (prompt: string, example: any) => Promise<any>;
  actHandler: (server: any) => (name: string, args: unknown) => Promise<any>;
}

function formatActResultText(result: any): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) {
    return result.content
      .map((entry: any) => (entry?.type === "text" ? String(entry.text ?? "") : JSON.stringify(entry, null, 2)))
      .join("\n");
  }
  return JSON.stringify(result, null, 2);
}

function serializeActResult(result: any): string {
  return JSON.stringify(
    {
      text: formatActResultText(result),
      isError: result?.isError === true,
    },
    null,
    2,
  );
}

/** Generate CJS script for reason/act commands */
function makeScript(dataDir: string, type: "reason" | "act"): string {
  const isReason = type === "reason";
  return `const fs = require('fs');
const { randomBytes } = require('crypto');
const args = process.argv.slice(2);
const needsStdin = ${
   isReason
      ? "args.some((a, i) => a === '--prompt' && args[i + 1] === '-')"
      : `(() => {
  let toolName = '', needsJsonStdin = false, showManual = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--args' && args[i + 1] === '-') { needsJsonStdin = true; i++; }
    else if (arg === '--manual') {
      showManual = true;
      const next = args[i + 1];
      if (next && !next.startsWith('-')) { toolName = next; i++; }
    }
    else if (arg === '--name') { toolName = args[++i] || ''; }
    else if (!arg.startsWith('-')) {
      if (!toolName && !showManual) toolName = arg;
      else if (arg === '-' && !showManual) needsJsonStdin = true;
    }
  }
  return needsJsonStdin;
})()`
 }
;

function run(stdin) {
  ${
    isReason
      ? `
  let prompts = [], structure = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prompt') { prompts.push(args[++i] === '-' ? stdin : args[i]); }
    else if (args[i] === '--structure') { structure = args[++i]; }
  }
  const body = { prompt: prompts.join('\\n'), example: structure ? JSON.parse(structure) : '' };
  `
      : `
  let toolName = '', argsText = '', needsJsonStdin = false, showManual = false, showHelp = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name') { toolName = args[++i] || ''; }
    else if (arg === '--args') {
      const v = args[++i];
      if (v === '-') needsJsonStdin = true;
      else argsText = v || '';
    }
    else if (arg === '--manual') {
      showManual = true;
      const next = args[i + 1];
      if (next && !next.startsWith('-')) { toolName = next; i++; }
    }
    else if (arg === '--help' || arg === '-h') { showHelp = true; }
    else if (!arg.startsWith('-')) {
      if (!toolName && !showManual) toolName = arg;
      else if (!argsText && !needsJsonStdin && !showManual) {
        if (arg === '-') needsJsonStdin = true;
        else argsText = arg;
      }
      else {
        console.error('Unknown argument: ' + arg); process.exit(1);
      }
    }
    else {
      console.error('Unknown argument: ' + arg); process.exit(1);
    }
  }
  let body;
  if (showHelp) body = { toolName: '__help__', toolArgs: {} };
  else if (showManual) body = { toolName: '__manual__', toolArgs: toolName ? { name: toolName } : {} };
  else {
    if (!toolName || (!argsText && !needsJsonStdin)) { console.error('tool name and JSON args required'); process.exit(1); }
    const raw = needsJsonStdin ? stdin : argsText;
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (error) { console.error('Invalid JSON args: ' + error.message); process.exit(1); }
    body = { toolName, toolArgs: parsed };
  }
  `
  }
  const id = randomBytes(8).toString('hex');
  const req = '${dataDir}/one-${type}-req-' + id + '.txt';
  const resp = '${dataDir}/one-${type}-resp-' + id + '.txt';
  fs.writeFileSync(req, JSON.stringify(body));
  for (let i = 0; i < 1200 && !fs.existsSync(resp); i++) { const e = Date.now() + 50; while (Date.now() < e); }
  if (fs.existsSync(resp)) {
    const raw = fs.readFileSync(resp, 'utf-8');
${
    isReason
      ? "    process.stdout.write(raw);"
      : `    const payload = JSON.parse(raw);
    if (payload.text) process.stdout.write(payload.text);
    if (payload.isError) {
      try { fs.unlinkSync(req); } catch {}
      try { fs.unlinkSync(resp); } catch {}
      process.exit(1);
    }`
  }
    try { fs.unlinkSync(req); } catch {} try { fs.unlinkSync(resp); } catch {}
  } else {
    console.error('Timeout'); try { fs.unlinkSync(req); } catch {} process.exit(1);
  }
}

if (needsStdin) {
  const c = []; process.stdin.on('data', d => c.push(d));
  process.stdin.on('end', () => run(Buffer.concat(c).toString()));
} else { run(''); }
`;
}

/** Process pending request files */
async function processRequests(
  dataDir: string,
  reasonHandler: BashAERConfig["reasonHandler"],
  actHandler: BashAERConfig["actHandler"],
  server: any,
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
      } catch (e: any) {
        try {
          unlinkSync(reqFile);
        } catch {}
        writeFileSync(
          join(dataDir, `one-reason-resp-${id}.txt`),
          JSON.stringify({ error: e.message }, null, 2),
        );
        if (stepIdx >= 0)
          emitProgress({
            type: "step-end",
            stepIndex: stepIdx,
            status: "error",
            error: (e as Error).message?.substring(0, 100),
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
      } catch (e: any) {
        try {
          unlinkSync(reqFile);
        } catch {}
        if (id) writeFileSync(join(dataDir, `one-act-resp-${id}.txt`), `Error: ${e.message}`);
        if (stepIdx >= 0)
          emitProgress({
            type: "step-end",
            stepIndex: stepIdx,
            status: "error",
            error: (e as Error).message?.substring(0, 100),
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
      _extra?: any,
      server?: any,
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
      } catch (error: any) {
        active = false;
        clearInterval(poll);
        return { content: [{ type: "text" as const, text: error.message }], isError: true };
      }
    },
  };
}
