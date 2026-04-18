import { existsSync, readFileSync } from "node:fs";
import * as readline from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type { ModelMessage, StreamTextResult } from "ai";
import { agentStream } from "./agent.js";
import { getOneConfigDir, getOneConfigPath } from "@one-agent/reason";
import { startTracing } from "./tracing.js";

// Initialize OpenTelemetry tracing
await startTracing();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

function printHeader() {
  const border = chalk.cyan("═".repeat(70));
  const title = chalk.cyan.bold("  ONE AGENT");
  const subtitle = chalk.gray("  The `one tool to rule them all` agent ");
  const help = chalk.gray("  Type your prompt, or /help for commands");

  console.log("\n" + border);
  console.log(title);
  console.log(subtitle);
  console.log(help);
  console.log(border + "\n");
}

function printReplHelp() {
  const lines = [
    "Commands:",
    "  /help   Show this help",
    "  /clear  Clear conversation context",
    "  /exit   Quit REPL",
    "",
    "Tips:",
    "  - Context is preserved across turns until /clear",
    "  - Use Ctrl+C to interrupt current generation",
  ];
  console.log(chalk.gray(lines.join("\n")));
}

function getResolvedModelIdForDisplay(): string {
  return (
    process.env.ONE_MODEL?.trim() ||
    process.env.ONE_CHAT_MODEL?.trim() ||
    process.env.ONE_AGENT_MODEL?.trim() ||
    process.env.MODEL?.trim() ||
    "gemini-3.1-pro"
  );
}

const ONE_CONFIG_PATH = getOneConfigPath("one.json");

function parseConfigFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function getOneScopedConfig(): Record<string, unknown> {
  const rootPath = getOneConfigDir();
  const sharedConfig = parseConfigFile(join(rootPath, "config.json"));
  const scopeConfig = parseConfigFile(ONE_CONFIG_PATH);
  const scopedInShared = sharedConfig.one;

  return {
    ...(typeof scopedInShared === "object" && scopedInShared !== null
      ? (scopedInShared as Record<string, unknown>)
      : {}),
    ...scopeConfig,
  };
}

function readOneScopedValue(key: string): string | undefined {
  const scopedEnvValue = process.env[`ONE_ONE_${key}`];
  if (scopedEnvValue != null && scopedEnvValue !== "") {
    return scopedEnvValue;
  }

  const envValue = process.env[`ONE_${key}`];
  if (envValue != null && envValue !== "") {
    return envValue;
  }

  const config = getOneScopedConfig();
  const configValue = config[key];
  if (typeof configValue === "string" && configValue !== "") {
    return configValue;
  }
  if (typeof configValue === "number" || typeof configValue === "boolean") {
    return String(configValue);
  }
  return undefined;
}

function getRASModeForDisplay(): string {
  const rawRASMode = (process.env.RAS_MODE || "python").toLowerCase();

  if (rawRASMode === "bash") {
    return "bash";
  }

  if (
    rawRASMode === "typescript" ||
    rawRASMode === "ts" ||
    rawRASMode === "javascript" ||
    rawRASMode === "js"
  ) {
    return "typescript";
  }

  return "python";
}

function formatRuntimeStatus(): string {
  const ras = getRASModeForDisplay();
  const provider = readOneScopedValue("PROVIDER") || "openai-compatible";
  const model =
    readOneScopedValue("MODEL") ||
    process.env.ONE_CHAT_MODEL?.trim() ||
    process.env.ONE_AGENT_MODEL?.trim() ||
    process.env.MODEL?.trim() ||
    "gemini-3.1-pro";

  let providerLabel = provider;

  if (provider === "openai-compatible") {
    const baseURL = readOneScopedValue("OPENAI_BASE_URL");
    if (baseURL) {
      try {
        const url = new URL(baseURL);
        providerLabel = `${provider}(${url.host})`;
      } catch {
        providerLabel = `${provider}(${baseURL})`;
      }
    }
  }

  const parts = [`ras: ${ras}`, `model: ${model}`, `provider: ${providerLabel}`];

  return parts.join("  ");
}

function printAgentHeading() {
  const label = chalk.blue.bold("agent");
  const status = chalk.cyan(formatRuntimeStatus());
  console.log(`\n${label} ${status}`);
}

function writeWrappedLines(
  prefix: string,
  text: string,
  color: (value: string) => string = (value) => value,
) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return;
  }

  const width = Math.max((process.stdout.columns || 100) - prefix.length - 2, 40);

  for (const rawLine of normalized.split("\n")) {
    if (!rawLine.trim()) {
      console.log("");
      continue;
    }

    const words = rawLine.split(/\s+/);
    let current = "";

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > width && current) {
        console.log(color(`${prefix}${current}`));
        current = word;
      } else {
        current = candidate;
      }
    }

    if (current) {
      console.log(color(`${prefix}${current}`));
    }
  }
}

function renderCodeBlock(code: string) {
  const lines = code.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const width = String(lines.length).length;

  console.log(chalk.gray("  code:"));
  for (const [index, line] of lines.entries()) {
    const lineNumber = String(index + 1).padStart(width, " ");
    console.log(chalk.gray(`    ${lineNumber} | `) + line);
  }
}

function summarizeToolResult(result: unknown): string {
  if (typeof result === "string") {
    return cleanToolResultText(result);
  }

  if (!result || typeof result !== "object") {
    return cleanToolResultText(String(result ?? ""));
  }

  const candidate = result as {
    content?: Array<{ type?: string; text?: unknown }>;
    result?: unknown;
    output?: unknown;
    error?: unknown;
  };

  if (Array.isArray(candidate.content)) {
    const textContent = candidate.content.find(
      (entry) => entry?.type === "text" && typeof entry.text === "string",
    )?.text;

    if (textContent) {
      return cleanToolResultText(String(textContent));
    }
  }

  if (typeof candidate.error === "string" && candidate.error.trim()) {
    return cleanToolResultText(candidate.error);
  }

  const nested = candidate.result ?? candidate.output;
  if (typeof nested === "string") {
    return cleanToolResultText(nested);
  }

  try {
    return cleanToolResultText(JSON.stringify(result, null, 2));
  } catch {
    return cleanToolResultText(String(result));
  }
}

function cleanToolResultText(text: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\[ONE:STEP_(START|END):/.test(line.trim()))
    .filter((line) => !/^\[py\]\s+/.test(line.trim()));

  const rawTracebackIndex = lines.findIndex((line) => line.trim() === "--- Raw Traceback ---");
  const trimmedLines = rawTracebackIndex >= 0 ? lines.slice(0, rawTracebackIndex) : lines;

  return trimmedLines
    .filter((line) => line.trim() !== "```")
    .join("\n")
    .trim();
}

async function withFilteredTerminalNoise<T>(fn: () => Promise<T>): Promise<T> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const shouldSuppressLine = (line: string) => {
    const trimmed = line.trim();
    return /^\[ONE:STEP_(START|END):/.test(trimmed) || /^\[py\]\s+/.test(trimmed);
  };

  const createFilteredWriter = (
    originalWrite: typeof process.stdout.write,
    getBuffer: () => string,
    setBuffer: (value: string) => void,
  ) => {
    return ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding,
      cb?: (error?: Error | null) => void,
    ) => {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding || "utf8");
      const combined = getBuffer() + text;
      const parts = combined.split("\n");
      const trailing = parts.pop() ?? "";
      setBuffer(trailing);

      for (const part of parts) {
        if (!shouldSuppressLine(part)) {
          originalWrite(`${part}\n`, encoding, cb);
        }
      }

      return true;
    }) as typeof process.stdout.write;
  };

  process.stdout.write = createFilteredWriter(
    originalStdoutWrite,
    () => stdoutBuffer,
    (value) => {
      stdoutBuffer = value;
    },
  );
  process.stderr.write = createFilteredWriter(
    originalStderrWrite,
    () => stderrBuffer,
    (value) => {
      stderrBuffer = value;
    },
  );

  try {
    return await fn();
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

async function renderReplStream(result: StreamTextResult<any, any>) {
  let reasoningBuffer = "";
  let textBuffer = "";

  const flushReasoning = () => {
    const text = reasoningBuffer.trim();
    if (!text) {
      reasoningBuffer = "";
      return;
    }

    console.log(chalk.gray("thinking:"));
    writeWrappedLines("  ", text, chalk.gray);
    reasoningBuffer = "";
  };

  const flushText = () => {
    const text = textBuffer.trim();
    if (!text) {
      textBuffer = "";
      return;
    }

    console.log(chalk.cyan("response:"));
    writeWrappedLines("  ", text);
    textBuffer = "";
  };

  for await (const chunk of result.fullStream) {
    const chunkType = (chunk as { type?: string }).type;

    switch (chunkType) {
      case "reasoning-start":
        reasoningBuffer = "";
        break;
      case "reasoning-delta":
        reasoningBuffer +=
          (chunk as { text?: string; delta?: string }).text ||
          (chunk as { delta?: string }).delta ||
          "";
        break;
      case "reasoning-end":
        flushReasoning();
        break;
      case "text-delta":
        textBuffer += (chunk as { text?: string }).text || "";
        break;
      case "tool-call": {
        flushText();
        flushReasoning();

        const toolName = (chunk as { toolName?: string }).toolName || "tool";
        console.log(chalk.yellow(`tool: ${toolName}`));

        const input = (chunk as { input?: unknown }).input;
        const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
        const code = obj && typeof obj.code === "string" ? obj.code : null;

        if (code) {
          renderCodeBlock(code);
        } else if (input != null) {
          writeWrappedLines("  args: ", JSON.stringify(input, null, 2), chalk.gray);
        }
        break;
      }
      case "tool-result": {
        flushText();
        flushReasoning();

        const toolResult =
          (chunk as { result?: unknown; output?: unknown }).result ??
          (chunk as { output?: unknown }).output;
        const summary = summarizeToolResult(toolResult);

        if (summary) {
          console.log(chalk.yellow("result:"));
          writeWrappedLines("  ", summary, chalk.gray);
        }
        break;
      }
      case "error": {
        flushText();
        flushReasoning();

        const errorValue = (chunk as { error?: unknown }).error;
        const message = errorValue instanceof Error ? errorValue.message : String(errorValue ?? "");

        if (message.trim()) {
          console.log(chalk.red("stream error:"));
          writeWrappedLines("  ", message, chalk.red);
        }
        break;
      }
      case "finish":
        flushText();
        flushReasoning();
        break;
      default:
        break;
    }
  }

  flushText();
  flushReasoning();
  console.log("");
}

function printSeparator() {
  console.log(chalk.gray("─".repeat(70)));
}

export async function runReplCli() {
  printHeader();
  printReplHelp();

  const messages: ModelMessage[] = [];

  while (true) {
    const userInput = await prompt(chalk.blue("❯ "));
    const trimmed = userInput.trim();

    if (!trimmed) {
      continue;
    }

    if (
      trimmed.toLowerCase() === "exit" ||
      trimmed.toLowerCase() === "quit" ||
      trimmed.toLowerCase() === "/exit"
    ) {
      console.log(chalk.green("\nGoodbye.\n"));
      rl.close();
      break;
    }

    if (trimmed.toLowerCase() === "/help") {
      printReplHelp();
      continue;
    }

    if (trimmed.toLowerCase() === "/clear" || trimmed.toLowerCase() === "/reset") {
      messages.length = 0;
      console.log(chalk.yellow("Context cleared."));
      continue;
    }

    try {
      messages.push({ role: "user", content: trimmed });

      printSeparator();
      printAgentHeading();
      const result = await withFilteredTerminalNoise(() => agentStream({ messages }));
      await withFilteredTerminalNoise(() => renderReplStream(result));

      // Preserve assistant responses for the next turn.
      const response = await result.response;
      const responseMessages = (response as { messages?: ModelMessage[] })?.messages;
      if (Array.isArray(responseMessages) && responseMessages.length > 0) {
        messages.push(...responseMessages);
      }

      printSeparator();
    } catch (error) {
      console.log("");
      let errorMsg = error instanceof Error ? error.message : String(error);
      if (/not a valid model ID/i.test(errorMsg)) {
        const resolvedModel = getResolvedModelIdForDisplay();
        errorMsg += `\nHint: resolved model is \"${resolvedModel}\". Set ONE_CHAT_MODEL (or ONE_AGENT_MODEL) to a valid provider model ID.`;
      } else if (
        /OPENAI_BASE_URL is not set|OPENAI_API_KEY is not set|Invalid URL/i.test(errorMsg)
      ) {
        errorMsg += `\nHint: run \"one auth\" or create ${ONE_CONFIG_PATH} with provider/model credentials.`;
      }

      // Handle multiline errors or long errors
      const errorLines = errorMsg.split("\n");
      const maxLineWidth = 64;

      const border = chalk.red("┌" + "─".repeat(maxLineWidth + 2) + "┐");
      const bottom = chalk.red("└" + "─".repeat(maxLineWidth + 2) + "┘");

      console.log(border);
      console.log(
        chalk.red("│ ") + chalk.red.bold("Error:") + " ".repeat(maxLineWidth - 5) + chalk.red("│"),
      );

      errorLines.forEach((line) => {
        // Wrap long lines
        if (line.length > maxLineWidth) {
          for (let i = 0; i < line.length; i += maxLineWidth) {
            const chunk = line.slice(i, i + maxLineWidth);
            const padded = chunk.padEnd(maxLineWidth);
            console.log(chalk.red("│ ") + padded + chalk.red(" │"));
          }
        } else {
          const padded = line.padEnd(maxLineWidth);
          console.log(chalk.red("│ ") + padded + chalk.red(" │"));
        }
      });

      console.log(bottom);
      console.log("");
    }
  }
}

const isDirectInvocation =
  process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectInvocation) {
  runReplCli();
}
