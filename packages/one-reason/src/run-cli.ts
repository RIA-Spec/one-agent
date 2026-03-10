import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { reason } from "./reason.js";

const STDIN_SENTINEL = "__STDIN__";
const REASON_CONFIG_PATH = join(process.cwd(), ".config", "one", "reason.json");

type ProviderChoice = "venus" | "openai" | "anthropic";

function readReasonConfig(): Record<string, unknown> {
  if (!existsSync(REASON_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(REASON_CONFIG_PATH, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeReasonConfig(config: Record<string, unknown>) {
  mkdirSync(dirname(REASON_CONFIG_PATH), { recursive: true });
  writeFileSync(REASON_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

async function runReasonAuthCli() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("Configure reason auth");
    console.log("1) venus");
    console.log("2) openai");
    console.log("3) anthropic");

    const selected = (await rl.question("Select provider [1]: ")).trim() || "1";
    const provider: ProviderChoice =
      selected === "2" ? "openai" : selected === "3" ? "anthropic" : "venus";

    const nextConfig = readReasonConfig();
    nextConfig.PROVIDER = provider;

    if (provider === "venus") {
      const apiKey = (await rl.question("VENUS_API_KEY: ")).trim();
      const baseURL = (await rl.question("VENUS_BASE_URL (optional): ")).trim();
      if (!apiKey) throw new Error("VENUS_API_KEY is required");
      nextConfig.VENUS_API_KEY = apiKey;
      if (baseURL) nextConfig.VENUS_BASE_URL = baseURL;
    }

    if (provider === "openai") {
      const apiKey = (await rl.question("OPENAI_API_KEY: ")).trim();
      const baseURL = (await rl.question("OPENAI_BASE_URL (optional): ")).trim();
      if (!apiKey) throw new Error("OPENAI_API_KEY is required");
      nextConfig.OPENAI_API_KEY = apiKey;
      if (baseURL) nextConfig.OPENAI_BASE_URL = baseURL;
    }

    if (provider === "anthropic") {
      const apiKey = (await rl.question("ANTHROPIC_API_KEY: ")).trim();
      const baseURL = (await rl.question("ANTHROPIC_BASE_URL (optional): ")).trim();
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
      nextConfig.ANTHROPIC_API_KEY = apiKey;
      if (baseURL) nextConfig.ANTHROPIC_BASE_URL = baseURL;
    }

    const model = (await rl.question("MODEL (optional): ")).trim();
    if (model) nextConfig.MODEL = model;

    writeReasonConfig(nextConfig);
    console.log(`Saved config to ${REASON_CONFIG_PATH}`);
    console.log("Environment variables still take priority over config.");
  } finally {
    rl.close();
  }
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function printUsage() {
  console.error("Usage: reason --prompt \"text\" [--prompt -] [--structure '{\"key\":\"\"}']");
  console.error("       reason auth");
}

export async function runReasonCli(args = process.argv.slice(2)) {
  if (args[0] === "auth") {
    await runReasonAuthCli();
    return;
  }

  const prompts: string[] = [];
  let structure = "";
  let needsStdin = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--prompt") {
      const value = args[++index];
      if (!value) {
        throw new Error("Missing value for --prompt");
      }
      if (value === "-") {
        prompts.push(STDIN_SENTINEL);
        needsStdin = true;
      } else {
        prompts.push(value);
      }
      continue;
    }

    if (arg === "--structure") {
      structure = args[++index] || "";
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      return;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (prompts.length === 0) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const stdin = needsStdin ? await readStdin() : "";
  const prompt = prompts
    .map((value) => (value === STDIN_SENTINEL ? stdin : value))
    .join("\n");
  const example = structure ? JSON.parse(structure) : "";

  const result = await reason(prompt, example);

  if (result.error) {
    process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({ data: result.data, error: result.error }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
}
