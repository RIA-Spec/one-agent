#!/usr/bin/env node
import { runActCli } from "@one/act";
import { runReasonCli } from "@one/reason";
import { getToolFn } from "./interfaces/act.js";
import { runReplCli } from "./repl.js";
import { getServer } from "./tools.js";
import { shutdownTracing, startTracing } from "./tracing.js";

type ActResult = {
  content?: Array<{ type?: string; text?: unknown }>;
  isError?: boolean;
};

function restoreTerminalState() {
  // Best-effort reset for terminal modes that can leak from dependencies.
  // Includes kitty CSI-u keyboard protocol and bracketed paste mode.
  const reset = "\u001b[<u\u001b[?2004l\u001b[?25h\u001b[0m\u001b>";
  if (process.stderr.isTTY) {
    process.stderr.write(reset);
  } else if (process.stdout.isTTY) {
    process.stdout.write(reset);
  }

  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Ignore raw mode reset errors.
    }
  }
}

function parseJsonObject(raw: string, flagName: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("value must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${flagName}: ${message}`);
  }
}

function printHelp() {
  const lines = [
    "one-agent",
    "",
    "Usage:",
    "  one-agent <command>",
    "",
    "Commands:",
    "  repl                        Run interactive one-agent REPL",
    "  act [...args]                Run one-act CLI",
    "  reason [...args]             Run one-reason CLI",
    "  riff list                    List saved riffs",
    "  riff read <name> [--include-script]",
    "                               Read riff docs and metadata",
    "  riff run <name> [--params <json>]",
    "                               Execute a riff by name",
    "",
    "Examples:",
    "  one-agent repl",
    "  one-agent riff list",
    "  one-agent riff read 10-life-hacks --include-script",
    "  one-agent riff run 10-life-hacks --params '{\"x\":1}'",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function parseRiffArgs(args: string[]): {
  action: "list" | "read" | "run";
  payload: Record<string, unknown>;
} {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    throw new Error("riff command requires a subcommand: list | read | run");
  }

  if (sub === "list") {
    return { action: "list", payload: {} };
  }

  if (sub === "read") {
    const name = args[1];
    if (!name) {
      throw new Error("riff read requires <name>");
    }
    const includeScript = args.includes("--include-script");
    return {
      action: "read",
      payload: { name, ...(includeScript ? { includeScript: true } : {}) },
    };
  }

  if (sub === "run") {
    const name = args[1];
    if (!name) {
      throw new Error("riff run requires <name>");
    }

    const paramsIndex = args.findIndex((arg) => arg === "--params" || arg === "--parameters");
    let parameters: Record<string, unknown> | undefined;
    if (paramsIndex >= 0) {
      const raw = args[paramsIndex + 1];
      if (!raw) {
        throw new Error("--params requires a JSON object value");
      }
      parameters = parseJsonObject(raw, "--params");
    }

    return {
      action: "run",
      payload: { name, ...(parameters ? { parameters } : {}) },
    };
  }

  throw new Error(`Unknown riff subcommand: ${sub}`);
}

async function runRiffCommand(action: "list" | "read" | "run", payload: Record<string, unknown>) {
  const server = await getServer();
  try {
    const act = getToolFn(server);
    let result: ActResult;

    if (action === "run") {
      const riffArgs = JSON.stringify({ action, ...payload });
      const code = [
        "import asyncio",
        "import json",
        "",
        "async def main():",
        `    r = await act('riff', json.loads(${JSON.stringify(riffArgs)}))`,
        "    if r.get('isError'):",
        "        print(r)",
        "",
        "asyncio.run(main())",
      ].join("\n");

      result = (await act("one", { code })) as ActResult;
    } else {
      result = (await act("riff", { action, ...payload })) as ActResult;
    }

    const text = result.content?.find((item) => item?.type === "text")?.text;
    process.stdout.write(`${typeof text === "string" ? text : JSON.stringify(result, null, 2)}\n`);
    if (result.isError) {
      process.exitCode = 1;
    }
  } finally {
    try {
      await server.close();
    } catch {
      // Ignore cleanup errors so command output remains primary.
    }
  }
}

export async function runOneAgentCli(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const [command, ...rest] = argv;

  if (command === "act") {
    await runActCli({ getServer, argv: rest });
    return;
  }

  if (command === "repl") {
    await runReplCli();
    return;
  }

  if (command === "reason") {
    await runReasonCli(rest);
    return;
  }

  if (command === "riff") {
    const { action, payload } = parseRiffArgs(rest);
    await runRiffCommand(action, payload);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

startTracing();

const isDirectCliInvocation = Boolean(process.argv[1]);

runOneAgentCli()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownTracing();
    restoreTerminalState();
    if (isDirectCliInvocation) {
      process.exit(process.exitCode ?? 0);
    }
  });
