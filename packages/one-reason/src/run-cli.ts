import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { cancel, intro, isCancel, outro, password, select, text } from "@clack/prompts";
import { cac } from "cac";
import pc from "picocolors";
import { getOneConfigPath } from "./config-path.js";
import { reason } from "./reason.js";

const REASON_CONFIG_PATH = getOneConfigPath("reason.json");
const HELP_DESCRIPTION =
  "Local structured judgment runner: read prompt text, match a required JSON shape, and emit JSON.";
const HELP_USAGE = "reason [--prompt <text>] [observation|-] [--structure <json>|structure]";
const HELP_QUICKSTART = [
  'Layered prompt: cat build.log | reason --prompt "goal: detect failures" - \'{"failed":false,"reason":""}\'',
  "The structure argument is required and must be valid JSON; prompts should include goal, observation, context, and constraints.",
];
const HELP_ARGUMENTS = [
  "observation     Optional positional observation text. Use '-' to read observation text from stdin.",
  "structure       Required JSON example for structured output when --structure is not used.",
];
const HELP_OPTIONS = [
  "--prompt <text>     Repeatable. Appends goal/system text in order. Use '-' to splice stdin into the final prompt.",
  "--structure <json>  Required JSON structure example. Equivalent to the second positional argument.",
  "-h, --help          Display this message.",
];
const HELP_CONFIGURATION = [
  `Default config file: ${REASON_CONFIG_PATH}`,
  "Interactive setup: reason auth",
  "Environment variables override file config.",
];
const HELP_EXAMPLES = [
  'cat build.log | reason --prompt "goal: detect failures; constraints: ignore warnings" - \'{"failed":false,"reason":""}\'',
  "cat build.log | reason --prompt 'goal: decide whether to deploy; observation: latest build log from CI; constraints: return deploy=false unless the log is clean; if deploy=true, provide the exact command' - '{\"deploy\":false,\"cmd\":\"\"}' | jq -e '.deploy' >/dev/null && jq -r '.cmd' | sh",
];

type ProviderChoice = "openai-compatible" | "openai" | "anthropic";
type ParsedReasonRequestArgs = {
  promptValues: string[];
  positionalPrompt?: string;
  positionalStructure?: string;
  structureOption?: string;
};

type BuildReasonRequestOptions = {
  stdinIsTTY?: boolean;
  readStdin?: () => Promise<string>;
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
    throw new Error(
      "This command requires piped stdin (example: echo 'text' | reason - '{\"text\":\"\"}')",
    );
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

export function parseReasonRequestArgs(args: string[]): ParsedReasonRequestArgs {
  const promptValues: string[] = [];
  const positionals: string[] = [];
  let structureOption: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--prompt") {
      const value = args[index + 1];
      if (value == null) throw new Error("--prompt requires a value");
      promptValues.push(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--prompt=")) {
      promptValues.push(arg.slice("--prompt=".length));
      continue;
    }

    if (arg === "--structure") {
      const value = args[index + 1];
      if (value == null) throw new Error("--structure requires a value");
      structureOption = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--structure=")) {
      structureOption = arg.slice("--structure=".length);
      continue;
    }

    if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`Unknown option: ${arg}`);
    }

    positionals.push(arg);
  }

  if (positionals.length > 2) {
    throw new Error("Too many positional arguments; expected [prompt] [structure]");
  }

  return {
    promptValues,
    positionalPrompt: positionals[0],
    positionalStructure: positionals[1],
    structureOption,
  };
}

export async function buildReasonRequestInput(
  request: ParsedReasonRequestArgs,
  options: BuildReasonRequestOptions = {},
) {
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY;
  const readStdinFn = options.readStdin ?? readStdin;
  const promptParts = request.promptValues.filter((value) => value !== "-");
  const positionalPrompt = request.positionalPrompt;
  const structureRaw = request.structureOption || request.positionalStructure || "";
  let needsStdin = request.promptValues.includes("-");

  if (positionalPrompt) {
    if (positionalPrompt === "-") {
      needsStdin = true;
    } else {
      promptParts.push(positionalPrompt);
    }
  }

  if (promptParts.length === 0 && !needsStdin && !stdinIsTTY) {
    needsStdin = true;
  }

  if (!structureRaw) {
    throw new Error("--structure is required");
  }

  if (promptParts.length === 0 && !needsStdin) {
    throw new Error("prompt is required");
  }

  const stdin = needsStdin ? await readStdinFn() : "";
  if (needsStdin) {
    promptParts.push(stdin);
  }

  return {
    prompt: promptParts.join("\n"),
    example: parseStructureJson(structureRaw),
  };
}

async function runReasonRequest(request: ParsedReasonRequestArgs) {
  const { prompt, example } = await buildReasonRequestInput(request);

  const result = await reason(prompt, example);

  if (result.error) {
    process.exitCode = 1;
    process.stdout.write(
      `${JSON.stringify({ data: result.data, error: result.error }, null, 2)}\n`,
    );
    return;
  }

  process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
}

export async function runReasonCli(args = process.argv.slice(2)) {
  const cli = cac("reason");

  cli.usage(`${HELP_DESCRIPTION}\n\n${HELP_USAGE}`);
  cli.help((sections) => {
    sections.push({
      title: "Description",
      body: HELP_DESCRIPTION,
    });
    sections.push({
      title: "Usage",
      body: `  ${HELP_USAGE}`,
    });
    sections.push({
      title: "Arguments",
      body: HELP_ARGUMENTS.map((line) => `  ${line}`).join("\n"),
    });
    sections.push({
      title: "Options",
      body: HELP_OPTIONS.map((line) => `  ${line}`).join("\n"),
    });
    sections.push({
      title: "Quickstart",
      body: HELP_QUICKSTART.map((line) => `  ${line}`).join("\n"),
    });
    sections.push({
      title: "Configuration",
      body: HELP_CONFIGURATION.map((line) => `  ${line}`).join("\n"),
    });
    sections.push({
      title: "Examples",
      body: HELP_EXAMPLES.map((line) => `  ${line}`).join("\n"),
    });
    return sections;
  });

  let pending: Promise<void> | null = null;

  cli.command("auth", "Configure reason auth").action(() => {
    pending = runReasonAuthCli();
  });

  if (args.includes("--help") || args.includes("-h") || args[0] === "auth") {
    cli.parse(["node", "reason", ...args]);
  }

  if (args.includes("--help") || args.includes("-h")) {
    return;
  }

  if (pending) {
    await pending;
    return;
  }

  if (args.length > 0) {
    await runReasonRequest(parseReasonRequestArgs(args));
    return;
  }

  if (!process.stdin.isTTY) {
    pending = runReasonRequest(parseReasonRequestArgs(args));
    await pending;
    return;
  }

  cli.outputHelp();
  process.exitCode = 1;
}
