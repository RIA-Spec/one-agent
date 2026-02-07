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

export interface BashAERConfig {
  cwd: string;
  reasonHandler: (prompt: string, example: any) => Promise<any>;
  actHandler: (server: any) => (name: string, prompt: string) => Promise<any>;
}

/** Generate CJS script for reason/act commands */
function makeScript(dataDir: string, type: "reason" | "act"): string {
  const isReason = type === "reason";
  return `const fs = require('fs');
const { randomBytes } = require('crypto');
const args = process.argv.slice(2);
const needsStdin = args.some((a, i) => a === '--prompt' && args[i + 1] === '-');

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
  let toolName = '', prompt = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') { toolName = args[++i]; }
    else if (args[i] === '--prompt') { const v = args[++i]; prompt = v === '-' ? stdin : v; }
  }
  if (!toolName || !prompt) { console.error('--name and --prompt required'); process.exit(1); }
  const body = { toolName, prompt };
  `
  }
  const id = randomBytes(8).toString('hex');
  const req = '${dataDir}/one-${type}-req-' + id + '.txt';
  const resp = '${dataDir}/one-${type}-resp-' + id + '.txt';
  fs.writeFileSync(req, JSON.stringify(body));
  for (let i = 0; i < 1200 && !fs.existsSync(resp); i++) { const e = Date.now() + 50; while (Date.now() < e); }
  if (fs.existsSync(resp)) {
    process.stdout.write(fs.readFileSync(resp, 'utf-8'));
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
) {
  for (const file of readdirSync(dataDir)) {
    const reqFile = join(dataDir, file);

    if (file.startsWith("one-reason-req-") && file.endsWith(".txt")) {
      const id = file.match(/one-reason-req-(.+)\.txt$/)?.[1];
      const respFile = join(dataDir, `one-reason-resp-${id}.txt`);
      if (existsSync(respFile)) continue;
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
      } catch (e: any) {
        try {
          unlinkSync(reqFile);
        } catch {}
        writeFileSync(
          join(dataDir, `one-reason-resp-${id}.txt`),
          JSON.stringify({ error: e.message }, null, 2),
        );
      }
    }

    if (file.startsWith("one-act-req-") && file.endsWith(".txt")) {
      const id = file.match(/one-act-req-(.+)\.txt$/)?.[1];
      const respFile = join(dataDir, `one-act-resp-${id}.txt`);
      if (existsSync(respFile)) continue;
      try {
        const req = JSON.parse(readFileSync(reqFile, "utf-8"));
        try {
          unlinkSync(reqFile);
        } catch {}
        const result = await actHandler(server)(req.toolName, req.prompt);
        writeFileSync(respFile, result.content.map((c: any) => c.text).join("\n"));
      } catch (e: any) {
        try {
          unlinkSync(reqFile);
        } catch {}
        if (id) writeFileSync(join(dataDir, `one-act-resp-${id}.txt`), `Error: ${e.message}`);
      }
    }
  }
}

export function createBashAER(config: BashAERConfig) {
  return {
    name: "bash",
    description: `Bash AER - Execute bash with built-in reason and act commands (block until done, like curl).

  reason --prompt "text" [--prompt -] [--structure '{"key":""}']
  act --name "name" --prompt "text" [--prompt -]

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

      // Poll for requests while bash runs
      let active = true;
      const poll = setInterval(() => {
        if (active) processRequests(dataDir, reasonHandler, actHandler, server);
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
