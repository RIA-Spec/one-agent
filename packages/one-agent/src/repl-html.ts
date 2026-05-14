import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type { ModelMessage, StreamTextResult } from "ai";
import { StreamingHtmlRenderer, initSyntaxHighlighting, highlightCode } from "@one-agent/html";
import { agentStream } from "./agent.js";
import { startTracing } from "./tracing.js";
import { AGENT_HTML_SYSTEM_PROMPT } from "./prompts-html.js";
import {
  ONE_CONFIG_PATH,
  rl,
  prompt,
  printReplHelp,
  writeWrappedLines,
  summarizeToolResult,
  withFilteredTerminalNoise,
  getRASModeForDisplay,
  getResolvedModelIdForDisplay,
  formatRuntimeStatus,
  printErrorBox,
} from "./repl-utils.js";

await startTracing();
initSyntaxHighlighting().catch(() => {});

// ─── Header ──────────────────────────────────────────────────────────────────

function printHeader() {
  const status = formatRuntimeStatus();
  console.log("");
  console.log("  " + chalk.cyan("●") + " " + chalk.bold("one"));
  console.log("  " + chalk.gray(status));
  console.log("  " + chalk.gray("/help  /clear  /exit  ·  Ctrl+C to interrupt"));
  console.log("");
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

function renderCodeBlock(code: string) {
  const lines = code.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const width = String(lines.length).length;
  const lang = getRASModeForDisplay();
  const highlighted = highlightCode(code.replace(/\r\n/g, "\n").trimEnd(), lang).split("\n");
  console.log(chalk.gray("  code:"));
  for (const [i, line] of lines.entries()) {
    const lineNumber = String(i + 1).padStart(width, " ");
    console.log(chalk.gray(`    ${lineNumber} | `) + (highlighted[i] ?? line));
  }
}

const TOOL_RESULT_MAX_LINES = 8;
const TOOL_RESULT_MAX_CHARS = 400;

function truncateToolResult(text: string): string {
  const lines = text.split("\n");
  const over = lines.length > TOOL_RESULT_MAX_LINES;
  const visible = over ? lines.slice(0, TOOL_RESULT_MAX_LINES) : lines;
  const joined = visible.join("\n");
  if (joined.length > TOOL_RESULT_MAX_CHARS) {
    return joined.slice(0, TOOL_RESULT_MAX_CHARS) + chalk.gray(" …");
  }
  return over ? joined + chalk.gray(` … (+${lines.length - TOOL_RESULT_MAX_LINES} lines)`) : joined;
}

// ─── Stream renderer ─────────────────────────────────────────────────────────

const RESPONSE_PREFIX = "  ";

async function renderReplStreamHtml(result: StreamTextResult<any, any>, spinner: TrailingSpinner) {
  let reasoningBuffer = "";

  const flushReasoning = () => {
    const text = reasoningBuffer.trim();
    reasoningBuffer = "";
    if (!text) return;
    spinner.erase();
    console.log(chalk.gray("thinking:"));
    writeWrappedLines("  ", text, chalk.gray);
    spinner.show();
  };

  const columns = process.stdout.columns || 100;
  const renderer = new StreamingHtmlRenderer({
    columns: Math.max(columns - RESPONSE_PREFIX.length - 2, 40),
    onFlush: (text) => {
      spinner.erase();
      for (const line of text.split("\n")) console.log(RESPONSE_PREFIX + line);
      console.log("");
      spinner.show();
    },
  });

  for await (const chunk of result.fullStream) {
    const c = chunk as Record<string, unknown>;
    switch (c.type) {
      case "reasoning-start":
        reasoningBuffer = "";
        break;
      case "reasoning-delta":
        reasoningBuffer += (c.text as string) || (c.delta as string) || "";
        break;
      case "reasoning-end":
        flushReasoning();
        break;
      case "text-delta": {
        const text = (c.text as string) || "";
        if (!text) break;
        renderer.write(text);
        break;
      }
      case "tool-call": {
        flushReasoning();
        spinner.erase();
        console.log("  " + chalk.cyan("○") + " " + chalk.gray((c.toolName as string) || "tool"));
        const input = c.input;
        const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
        const code = obj && typeof obj.code === "string" ? obj.code : null;
        if (code) renderCodeBlock(code);
        else if (input != null)
          writeWrappedLines("  args: ", JSON.stringify(input, null, 2), chalk.gray);
        spinner.show();
        break;
      }
      case "tool-result": {
        flushReasoning();
        const toolResult = (c.result ?? c.output) as unknown;
        const summary = summarizeToolResult(toolResult);
        if (summary) {
          spinner.erase();
          writeWrappedLines("  ", truncateToolResult(summary), chalk.gray);
          spinner.show();
        }
        break;
      }
      case "error": {
        flushReasoning();
        const msg = c.error instanceof Error ? c.error.message : String(c.error ?? "");
        if (msg.trim()) {
          spinner.erase();
          writeWrappedLines("  ", msg, chalk.red);
        }
        break;
      }
      case "finish":
        renderer.end();
        flushReasoning();
        break;
    }
  }

  flushReasoning();
  spinner.stop();
}

// ─── Trailing spinner ────────────────────────────────────────────────────────

// Brand pulse: hollow → center-dot → filled → center-dot
const SPINNER_FRAMES = ["○", "◎", "●", "◎"];

interface TrailingSpinner {
  show(): void;
  erase(): void;
  stop(): void;
}

/**
 * Trailing spinner that animates on the current line while the stream is active.
 * Must be created BEFORE withFilteredTerminalNoise patches process.stdout.write,
 * so origWrite always points to the real TTY write.
 */
function makeTrailingSpinner(): TrailingSpinner {
  if (!process.stdout.isTTY) return { show: () => {}, erase: () => {}, stop: () => {} };

  const origWrite = process.stdout.write.bind(process.stdout);
  let i = 0;
  let id: ReturnType<typeof setInterval> | null = null;

  const showCursor = () => origWrite("\x1b[?25h");
  const hideCursor = () => origWrite("\x1b[?25l");

  // Restore cursor on process exit / interrupt
  process.once("exit", showCursor);
  process.once("SIGINT", () => {
    showCursor();
    process.exit(130);
  });

  const show = () => {
    if (id) clearInterval(id);
    hideCursor();
    id = setInterval(() => {
      origWrite(`\r  ${chalk.cyan(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]!)}`);
    }, 120);
  };

  const erase = () => {
    if (id) {
      clearInterval(id);
      id = null;
    }
    origWrite("\r\x1b[K");
    showCursor();
  };

  return { show, erase, stop: erase };
}

// ─── REPL loop ───────────────────────────────────────────────────────────────

export async function runReplHtmlCli() {
  printHeader();

  const messages: ModelMessage[] = [];

  while (true) {
    console.log("");
    // Extra blank line keeps the prompt one row above the terminal bottom.
    process.stdout.write("\n\x1b[1A");
    const trimmed = (await prompt(chalk.blue("❯ "))).trim();
    if (!trimmed) continue;

    const cmd = trimmed.toLowerCase();
    if (cmd === "exit" || cmd === "quit" || cmd === "/exit") {
      console.log(chalk.green("\nGoodbye.\n"));
      rl.close();
      break;
    }
    if (cmd === "/help") {
      printReplHelp();
      continue;
    }
    if (cmd === "/clear" || cmd === "/reset") {
      messages.length = 0;
      console.log(chalk.yellow("Context cleared."));
      continue;
    }

    try {
      messages.push({ role: "user", content: trimmed });
      console.log("");
      // Create spinner before withFilteredTerminalNoise so origWrite is the real TTY.
      const spinner = makeTrailingSpinner();
      spinner.show();
      const result = await withFilteredTerminalNoise(() =>
        agentStream({ messages, system: AGENT_HTML_SYSTEM_PROMPT }),
      );
      await withFilteredTerminalNoise(() => renderReplStreamHtml(result, spinner));

      const response = await result.response;
      const responseMessages = (response as { messages?: ModelMessage[] })?.messages;
      if (Array.isArray(responseMessages) && responseMessages.length > 0) {
        messages.push(...responseMessages);
      }
    } catch (error) {
      let errorMsg = error instanceof Error ? error.message : String(error);
      if (/not a valid model ID/i.test(errorMsg)) {
        errorMsg += `\nHint: resolved model is "${getResolvedModelIdForDisplay()}". Set ONE_CHAT_MODEL (or ONE_AGENT_MODEL) to a valid provider model ID.`;
      } else if (
        /OPENAI_BASE_URL is not set|OPENAI_API_KEY is not set|Invalid URL/i.test(errorMsg)
      ) {
        errorMsg += `\nHint: run "one auth" or create ${ONE_CONFIG_PATH} with provider/model credentials.`;
      }
      printErrorBox(errorMsg);
    }
  }
}

const isDirectInvocation =
  process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectInvocation) {
  runReplHtmlCli();
}
