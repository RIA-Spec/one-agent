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
  "--prompt <text>          Repeatable. Appends goal/system text in order. Use '-' to splice stdin into the final prompt.",
  "--structure <json>       Required JSON structure example. Equivalent to the second positional argument.",
  "--context-window <n>     Max tokens to send to the model. Observation (stdin) is truncated to fit; --prompt parts are always preserved. Overrides CONTEXT_WINDOW in reason.json. On truncation a warning with estimated token counts is printed to stderr.",
  "-h, --help               Display this message.",
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
  contextWindow?: number;
};

type TruncationMeta = {
  original_tokens: number;
  used_tokens: number;
  dropped_tokens: number;
  next_offset: number;
  remaining_chars: number;
  next_line: number;
  total_lines: number;
  remaining_lines: number;
};

type BuildReasonRequestOptions = {
  stdinIsTTY?: boolean;
  readStdin?: () => Promise<string>;
  contextWindow?: number;
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

/**
 * Rough token estimator without a tokenizer library.
 * - CJK characters (Chinese / Japanese / Korean): ~1 char per token
 * - Everything else: ~4 chars per token
 */
function estimateTokens(text: string): number {
  const cjkCount = (text.match(/[一-鿿぀-ヿ가-힯]/g) ?? []).length;
  const otherChars = text.length - cjkCount;
  return cjkCount + Math.ceil(otherChars / 4);
}

/**
 * Given a token budget, return how many chars correspond to that budget.
 * Uses the inverse of estimateTokens with a slight under-estimate to stay safe.
 */
function tokenBudgetToChars(tokens: number): number {
  // Conservative: 3.5 chars/token (instead of 4) so we don't overshoot
  return Math.floor(tokens * 3.5);
}

export function parseReasonRequestArgs(args: string[]): ParsedReasonRequestArgs {
  const promptValues: string[] = [];
  const positionals: string[] = [];
  let structureOption: string | undefined;
  let contextWindow: number | undefined;

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

    if (arg === "--context-window") {
      const value = args[index + 1];
      if (value == null) throw new Error("--context-window requires a value");
      contextWindow = parseInt(value, 10);
      if (isNaN(contextWindow) || contextWindow <= 0)
        throw new Error("--context-window must be a positive integer");
      index += 1;
      continue;
    }

    if (arg.startsWith("--context-window=")) {
      contextWindow = parseInt(arg.slice("--context-window=".length), 10);
      if (isNaN(contextWindow) || contextWindow <= 0)
        throw new Error("--context-window must be a positive integer");
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
    contextWindow,
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

  const rawStdin = needsStdin ? await readStdinFn() : "";

  // Resolve context window: CLI arg > options > env var > config field
  const contextWindow = request.contextWindow ?? options.contextWindow;

  let observation = rawStdin;
  let truncationMeta: TruncationMeta | null = null;

  if (contextWindow != null && needsStdin && rawStdin.length > 0) {
    const promptText = promptParts.join("\n");
    const promptTokens = estimateTokens(promptText);
    const obsTokens = estimateTokens(rawStdin);
    // +1 for the "\n" separator between prompt parts and observation
    const totalTokens = promptTokens + (promptText.length > 0 ? 1 : 0) + obsTokens;

    if (totalTokens > contextWindow) {
      const separatorTokens = promptText.length > 0 ? 1 : 0;
      const obsBudgetTokens = Math.max(0, contextWindow - promptTokens - separatorTokens);
      const charBudget = tokenBudgetToChars(obsBudgetTokens);
      const truncatedObs = rawStdin.slice(0, charBudget);
      const usedObsTokens = estimateTokens(truncatedObs);
      const droppedTokens = obsTokens - usedObsTokens;
      const nextOffset = charBudget;
      const remainingChars = rawStdin.length - charBudget;

      // Line-based info for file-piping workflows (tail -n +<next_line>)
      const totalLines = rawStdin.split("\n").length;
      const usedLines = truncatedObs.split("\n").length;
      const nextLine = usedLines + 1;
      const remainingLines = totalLines - usedLines;

      truncationMeta = {
        original_tokens: totalTokens,
        used_tokens: promptTokens + separatorTokens + usedObsTokens,
        dropped_tokens: droppedTokens,
        next_offset: nextOffset,
        remaining_chars: remainingChars,
        next_line: nextLine,
        total_lines: totalLines,
        remaining_lines: remainingLines,
      };

      // Inject a structured notice so the model can surface continuation info in its output
      observation =
        truncatedObs +
        `\n\n---[INPUT TRUNCATED]---\noriginal_chars: ${rawStdin.length}\nused_chars: ${charBudget}\nremaining_chars: ${remainingChars}\nnext_offset: ${nextOffset}\ntotal_lines: ${totalLines}\nused_lines: ${usedLines}\nremaining_lines: ${remainingLines}\nnext_line: ${nextLine}\nNote: ${remainingLines} lines (${remainingChars} chars) remain unread. To continue: use byte offset ${nextOffset} or line number ${nextLine}.\n---[END NOTICE]---`;
    }
  }

  if (needsStdin) {
    promptParts.push(observation);
  }

  return {
    prompt: promptParts.join("\n"),
    example: parseStructureJson(structureRaw),
    truncationMeta,
  };
}

async function runReasonRequest(request: ParsedReasonRequestArgs) {
  // Priority: CLI arg > env var ONE_REASON_CONTEXT_WINDOW / ONE_CONTEXT_WINDOW > reason.json CONTEXT_WINDOW
  const envContextWindow =
    process.env["ONE_REASON_CONTEXT_WINDOW"] ?? process.env["ONE_CONTEXT_WINDOW"];
  const configContextWindow = (() => {
    const v = readReasonConfig()["CONTEXT_WINDOW"];
    if (v == null) return undefined;
    const n = parseInt(String(v), 10);
    return isNaN(n) || n <= 0 ? undefined : n;
  })();
  const resolvedContextWindow =
    request.contextWindow ??
    (envContextWindow != null ? parseInt(envContextWindow, 10) : undefined) ??
    configContextWindow;

  const { prompt, example, truncationMeta } = await buildReasonRequestInput(request, {
    contextWindow: resolvedContextWindow,
  });

  if (truncationMeta) {
    process.stderr.write(
      pc.yellow(
        `reason: input truncated — original ~${truncationMeta.original_tokens} tokens, used ~${truncationMeta.used_tokens} tokens, dropped ~${truncationMeta.dropped_tokens} tokens` +
          ` | lines ${truncationMeta.next_line - 1}/${truncationMeta.total_lines} (remaining ${truncationMeta.remaining_lines} lines)` +
          ` | next_offset=${truncationMeta.next_offset} next_line=${truncationMeta.next_line} remaining_chars=${truncationMeta.remaining_chars} (context window: ${resolvedContextWindow})\n`,
      ),
    );
  }

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
