#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { runActCli } from "@one-agent/act";
import { getOneConfigPath } from "@one-agent/reason";
import { runReasonCli } from "@one-agent/reason";
import { getToolFn } from "./interfaces/act.js";
import { runReplCli } from "./repl.js";
import { getServer } from "./tools.js";
import { shutdownTracing, startTracing } from "./tracing.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { cancel, intro, isCancel, outro, password, select, text } from "@clack/prompts";

const WASM_STACK_SWITCHING_FLAG = "--experimental-wasm-stack-switching";

function ensureWasmStackSwitchingFlag() {
  if (!process.argv[1]) {
    return;
  }

  if (process.execArgv.includes(WASM_STACK_SWITCHING_FLAG)) {
    return;
  }

  const result = spawnSync(
    process.execPath,
    [WASM_STACK_SWITCHING_FLAG, process.argv[1], ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number") {
    process.exit(result.status);
  }

  process.exit(1);
}

type ActResult = {
  content?: Array<{ type?: string; text?: unknown }>;
  isError?: boolean;
};

ensureWasmStackSwitchingFlag();

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
  const oneConfigPath = getOneConfigPath("one.json");
  const lines = [
    "one-agent",
    "",
    "Usage:",
    "  one-agent <command>",
    "",
    "Commands:",
    "  auth                        Configure one auth",
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
    `  config file: ${oneConfigPath}`,
    "  one-agent riff list",
    "  one-agent riff read 10-life-hacks --include-script",
    "  one-agent riff run 10-life-hacks --params '{\"x\":1}'",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

type ProviderChoice = "openai-compatible" | "openai" | "anthropic";

const ONE_CONFIG_PATH = getOneConfigPath("one.json");

function readOneConfig(): Record<string, unknown> {
  if (!existsSync(ONE_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(ONE_CONFIG_PATH, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeOneConfig(config: Record<string, unknown>) {
  mkdirSync(dirname(ONE_CONFIG_PATH), { recursive: true });
  writeFileSync(ONE_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

async function runOneAuthCli() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("one auth requires an interactive terminal (TTY)");
  }

  const readRequiredSecret = async (message: string) => {
    const value = await password({
      message,
      validate(input) {
        return input?.trim() ? undefined : `${message} is required`;
      },
    });
    if (isCancel(value)) return null;
    return value.trim();
  };

  const readOptionalText = async (message: string) => {
    const value = await text({ message });
    if (isCancel(value)) return null;
    return value.trim();
  };

  const readRequiredText = async (message: string) => {
    const value = await text({
      message,
      validate(input) {
        return input?.trim() ? undefined : `${message} is required`;
      },
    });
    if (isCancel(value)) return null;
    return value.trim();
  };

  const provider = await select<ProviderChoice>({
    message: "Select provider (openai-compatible/openai/anthropic)",
    initialValue: "openai-compatible",
    options: [
      { label: "openai-compatible", value: "openai-compatible" },
      { label: "openai", value: "openai" },
      { label: "anthropic", value: "anthropic" },
    ],
  });

  if (isCancel(provider)) {
    cancel("Operation cancelled.");
    return;
  }

  intro("Configure one auth");

  const nextConfig = readOneConfig();
  nextConfig.PROVIDER = provider;

  if (provider === "openai-compatible") {
    const baseURL = await readRequiredText("OPENAI_BASE_URL");
    if (baseURL == null) {
      cancel("Operation cancelled.");
      return;
    }
    const apiKey = await readRequiredSecret("OPENAI_API_KEY");
    if (apiKey == null) {
      cancel("Operation cancelled.");
      return;
    }
    nextConfig.OPENAI_BASE_URL = baseURL;
    nextConfig.OPENAI_API_KEY = apiKey;
  }

  if (provider === "openai") {
    const baseURL = await readOptionalText("OPENAI_BASE_URL (optional)");
    if (baseURL == null) {
      cancel("Operation cancelled.");
      return;
    }
    const apiKey = await readRequiredSecret("OPENAI_API_KEY");
    if (apiKey == null) {
      cancel("Operation cancelled.");
      return;
    }
    nextConfig.OPENAI_API_KEY = apiKey;
    if (baseURL) nextConfig.OPENAI_BASE_URL = baseURL;
  }

  if (provider === "anthropic") {
    const baseURL = await readOptionalText("ANTHROPIC_BASE_URL (optional)");
    if (baseURL == null) {
      cancel("Operation cancelled.");
      return;
    }
    const apiKey = await readRequiredSecret("ANTHROPIC_API_KEY");
    if (apiKey == null) {
      cancel("Operation cancelled.");
      return;
    }
    nextConfig.ANTHROPIC_API_KEY = apiKey;
    if (baseURL) nextConfig.ANTHROPIC_BASE_URL = baseURL;
  }

  const model = await readOptionalText("MODEL (optional)");
  if (model == null) {
    cancel("Operation cancelled.");
    return;
  }
  if (model) nextConfig.MODEL = model;

  writeOneConfig(nextConfig);
  outro(`Saved config to ${ONE_CONFIG_PATH}`);
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

  if (command === "auth") {
    await runOneAuthCli();
    return;
  }

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

await startTracing();

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
