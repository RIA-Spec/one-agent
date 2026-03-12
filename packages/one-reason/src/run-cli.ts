import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import {
  cancel,
  intro,
  isCancel,
  outro,
  password,
  select,
  text,
} from "@clack/prompts";
import { cac } from "cac";
import pc from "picocolors";
import { getOneConfigPath } from "./config-path.js";
import { reason } from "./reason.js";

const STDIN_POSITIONAL_SENTINEL = "__STDIN_POSITIONAL__";
const REASON_CONFIG_PATH = getOneConfigPath("reason.json");
const HELP_DESCRIPTION =
  "AI command for structured extraction and decision-making: read prompt text, reason over it, and output JSON matching the required structure.";
const HELP_EXAMPLES = [
  "reason \"hi\" '{\"text\":\"\"}'",
  "echo \"hi\" | reason - '{\"text\":\"\"}'",
  "cat build.log | reason - '{\"deploy\":false,\"cmd\":\"\"}' | jq -e '.deploy' >/dev/null && jq -r '.cmd' | sh",
];

type ProviderChoice = "openai-compatible" | "openai" | "anthropic";
type ReasonCliOptions = {
  prompt?: string;
  structure?: string;
};

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
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("reason auth requires an interactive terminal (TTY)");
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

  const readProvider = async () => {
    const value = await select<ProviderChoice>({
      message: "Select provider (openai-compatible/openai/anthropic)",
      initialValue: "openai-compatible",
      options: [
        { label: "openai-compatible", value: "openai-compatible" },
        { label: "openai", value: "openai" },
        { label: "anthropic", value: "anthropic" },
      ],
    });

    if (isCancel(value)) return null;
    return value;
  };

  intro(pc.cyan("Configure reason auth"));

  const provider = await readProvider();

  if (provider == null) {
    cancel("Operation cancelled.");
    return;
  }

  const nextConfig = readReasonConfig();
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

    nextConfig.OPENAI_API_KEY = apiKey;
    nextConfig.OPENAI_BASE_URL = baseURL;
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

  writeReasonConfig(nextConfig);
  outro(pc.green(`Saved config to ${REASON_CONFIG_PATH}`));
  console.log(pc.dim("Environment variables still take priority over config."));
}

async function readStdin() {
  if (process.stdin.isTTY) {
    throw new Error("This command requires piped stdin (example: echo 'text' | reason - '{\"text\":\"\"}')");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parseStructureJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid --structure JSON");
  }
}

async function runReasonRequest(
  rawPrompt: string | undefined,
  rawStructure: string | undefined,
  options: ReasonCliOptions,
) {
  const promptOption = typeof options?.prompt === "string" ? options.prompt : "";
  const structureOption = typeof options?.structure === "string" ? options.structure : "";

  const promptInput = promptOption || rawPrompt || "";
  const structureRaw = structureOption || rawStructure || "";

  let needsStdin = false;
  const prompts: string[] = [];

  if (!promptInput) {
    if (!process.stdin.isTTY) {
      needsStdin = true;
    }
  } else if (promptInput === "-") {
    needsStdin = true;
  } else {
    prompts.push(promptInput);
  }

  if (!structureRaw) {
    throw new Error("--structure is required");
  }

  if (prompts.length === 0 && !needsStdin) {
    throw new Error("prompt is required");
  }

  const stdin = needsStdin ? await readStdin() : "";
  const prompt = prompts.length > 0 ? prompts.join("\n") : stdin;
  const example = parseStructureJson(structureRaw);

  const result = await reason(prompt, example);

  if (result.error) {
    process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({ data: result.data, error: result.error }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
}

export async function runReasonCli(args = process.argv.slice(2)) {
  const normalizedArgs = args.map((arg) => (arg === "-" ? STDIN_POSITIONAL_SENTINEL : arg));
  const cli = cac("reason");

  cli.usage(`${HELP_DESCRIPTION}\n\n[prompt] [structure]`);
  cli.help((sections) => {
    sections.push({
      title: "Description",
      body: HELP_DESCRIPTION,
    });
    sections.push({
      title: "Examples",
      body: HELP_EXAMPLES.map((line) => `  ${line}`).join("\n"),
    });
    return sections;
  });

  let pending: Promise<void> | null = null;

  cli
    .command("auth", "Configure reason auth")
    .action(() => {
      pending = runReasonAuthCli();
    });

  cli
    .command("[prompt] [structure]", "Analyze input in pipelines and emit structured JSON")
    .option("--prompt <text>", "Prompt text, use '-' to read from stdin")
    .option("--structure <json>", "Required JSON structure example")
    .action((prompt: string | undefined, structure: string | undefined, options: ReasonCliOptions) => {
      const resolvedPrompt = prompt === STDIN_POSITIONAL_SENTINEL ? "-" : prompt;
      pending = runReasonRequest(resolvedPrompt, structure, options);
    });

  cli.parse(["node", "reason", ...normalizedArgs]);

  if (normalizedArgs.includes("--help") || normalizedArgs.includes("-h")) {
    return;
  }

  if (pending) {
    await pending;
    return;
  }

  if (!process.stdin.isTTY) {
    pending = runReasonRequest(undefined, undefined, {});
    await pending;
    return;
  }

  cli.outputHelp();
  process.exitCode = 1;
}
