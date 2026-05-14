import { existsSync, readFileSync } from "node:fs";
import * as readline from "node:readline";
import { join } from "node:path";
import chalk from "chalk";
import type { ModelMessage } from "ai";
import { getOneConfigDir, getOneConfigPath } from "@one-agent/reason";

export const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

export function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

export const ONE_CONFIG_PATH = getOneConfigPath("one.json");

function parseConfigFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
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

export function readOneScopedValue(key: string): string | undefined {
  const scopedEnvValue = process.env[`ONE_ONE_${key}`];
  if (scopedEnvValue != null && scopedEnvValue !== "") return scopedEnvValue;
  const envValue = process.env[`ONE_${key}`];
  if (envValue != null && envValue !== "") return envValue;
  const config = getOneScopedConfig();
  const configValue = config[key];
  if (typeof configValue === "string" && configValue !== "") return configValue;
  if (typeof configValue === "number" || typeof configValue === "boolean")
    return String(configValue);
  return undefined;
}

export function getResolvedModelIdForDisplay(): string {
  return (
    process.env.ONE_MODEL?.trim() ||
    process.env.ONE_CHAT_MODEL?.trim() ||
    process.env.ONE_AGENT_MODEL?.trim() ||
    process.env.MODEL?.trim() ||
    "gemini-3.1-pro"
  );
}

export function getRASModeForDisplay(): string {
  const mode = (process.env.RAS_MODE || "python").toLowerCase();
  if (mode === "bash") return "bash";
  if (mode === "typescript" || mode === "ts" || mode === "javascript" || mode === "js")
    return "typescript";
  return "python";
}

export function formatRuntimeStatus(): string {
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
        providerLabel = `${provider}(${new URL(baseURL).host})`;
      } catch {
        providerLabel = `${provider}(${baseURL})`;
      }
    }
  }
  return [`ras: ${ras}`, `model: ${model}`, `provider: ${providerLabel}`].join("  ");
}

export function printReplHelp() {
  console.log(
    chalk.gray(
      [
        "Commands:",
        "  /help   Show this help",
        "  /clear  Clear conversation context",
        "  /exit   Quit REPL",
        "",
        "Tips:",
        "  - Context is preserved across turns until /clear",
        "  - Use Ctrl+C to interrupt current generation",
      ].join("\n"),
    ),
  );
}

export function printAgentHeading() {
  console.log(`\n${chalk.blue.bold("agent")} ${chalk.cyan(formatRuntimeStatus())}`);
}

export function writeWrappedLines(
  prefix: string,
  text: string,
  color: (value: string) => string = (v) => v,
) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return;
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
    if (current) console.log(color(`${prefix}${current}`));
  }
}

export function cleanToolResultText(text: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\[ONE:STEP_(START|END):/.test(line.trim()))
    .filter((line) => !/^\[py\]\s+/.test(line.trim()));
  const cutIdx = lines.findIndex((l) => l.trim() === "--- Raw Traceback ---");
  return (cutIdx >= 0 ? lines.slice(0, cutIdx) : lines)
    .filter((l) => l.trim() !== "```")
    .join("\n")
    .trim();
}

export function summarizeToolResult(result: unknown): string {
  if (typeof result === "string") return cleanToolResultText(result);
  if (!result || typeof result !== "object") return cleanToolResultText(String(result ?? ""));
  const r = result as {
    content?: Array<{ type?: string; text?: unknown }>;
    result?: unknown;
    output?: unknown;
    error?: unknown;
  };
  if (Array.isArray(r.content)) {
    const t = r.content.find((e) => e?.type === "text" && typeof e.text === "string")?.text;
    if (t) return cleanToolResultText(String(t));
  }
  if (typeof r.error === "string" && r.error.trim()) return cleanToolResultText(r.error);
  const nested = r.result ?? r.output;
  if (typeof nested === "string") return cleanToolResultText(nested);
  try {
    return cleanToolResultText(JSON.stringify(result, null, 2));
  } catch {
    return cleanToolResultText(String(result));
  }
}

export async function withFilteredTerminalNoise<T>(fn: () => Promise<T>): Promise<T> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let outBuf = "";
  let errBuf = "";

  const suppress = (line: string) => {
    const t = line.trim();
    return /^\[ONE:STEP_(START|END):/.test(t) || /^\[py\]\s+/.test(t);
  };

  const makeWriter = (
    orig: typeof process.stdout.write,
    getBuf: () => string,
    setBuf: (v: string) => void,
  ): typeof process.stdout.write =>
    ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (e?: Error | null) => void) => {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding || "utf8");
      const parts = (getBuf() + text).split("\n");
      setBuf(parts.pop() ?? "");
      for (const part of parts) {
        if (!suppress(part)) orig(`${part}\n`, encoding, cb);
      }
      return true;
    }) as typeof process.stdout.write;

  process.stdout.write = makeWriter(
    origOut,
    () => outBuf,
    (v) => {
      outBuf = v;
    },
  );
  process.stderr.write = makeWriter(
    origErr,
    () => errBuf,
    (v) => {
      errBuf = v;
    },
  );

  try {
    return await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

export function printErrorBox(errorMsg: string) {
  const maxLineWidth = 64;
  const border = chalk.red("┌" + "─".repeat(maxLineWidth + 2) + "┐");
  const bottom = chalk.red("└" + "─".repeat(maxLineWidth + 2) + "┘");
  console.log("");
  console.log(border);
  console.log(
    chalk.red("│ ") + chalk.red.bold("Error:") + " ".repeat(maxLineWidth - 5) + chalk.red("│"),
  );
  for (const line of errorMsg.split("\n")) {
    if (line.length > maxLineWidth) {
      for (let i = 0; i < line.length; i += maxLineWidth) {
        console.log(
          chalk.red("│ ") + line.slice(i, i + maxLineWidth).padEnd(maxLineWidth) + chalk.red(" │"),
        );
      }
    } else {
      console.log(chalk.red("│ ") + line.padEnd(maxLineWidth) + chalk.red(" │"));
    }
  }
  console.log(bottom);
  console.log("");
}

export function appendMessageHistory(
  messages: ModelMessage[],
  result: { response: Promise<unknown> },
) {
  return result.response.then((response) => {
    const msgs = (response as { messages?: ModelMessage[] })?.messages;
    if (Array.isArray(msgs) && msgs.length > 0) messages.push(...msgs);
  });
}
