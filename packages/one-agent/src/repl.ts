import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type { ModelMessage, StreamTextResult } from "ai";
import { agentStream } from "./agent.js";
import { startTracing } from "./tracing.js";
import {
  ONE_CONFIG_PATH,
  rl,
  prompt,
  printReplHelp,
  printAgentHeading,
  writeWrappedLines,
  summarizeToolResult,
  withFilteredTerminalNoise,
  getResolvedModelIdForDisplay,
  printErrorBox,
} from "./repl-utils.js";

await startTracing();

function printHeader() {
  const border = chalk.cyan("═".repeat(70));
  console.log("\n" + border);
  console.log(chalk.cyan.bold("  ONE AGENT"));
  console.log(chalk.gray("  The `one tool to rule them all` agent "));
  console.log(chalk.gray("  Type your prompt, or /help for commands"));
  console.log(border + "\n");
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

async function renderReplStream(result: StreamTextResult<any, any>) {
  let reasoningBuffer = "";
  let textBuffer = "";

  const flushReasoning = () => {
    const text = reasoningBuffer.trim();
    reasoningBuffer = "";
    if (!text) return;
    console.log(chalk.gray("thinking:"));
    writeWrappedLines("  ", text, chalk.gray);
  };

  const flushText = () => {
    const text = textBuffer.trim();
    textBuffer = "";
    if (!text) return;
    console.log(chalk.cyan("response:"));
    writeWrappedLines("  ", text);
  };

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
      case "text-delta":
        textBuffer += (c.text as string) || "";
        break;
      case "tool-call": {
        flushText();
        flushReasoning();
        console.log(chalk.yellow(`tool: ${(c.toolName as string) || "tool"}`));
        const input = c.input;
        const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
        const code = obj && typeof obj.code === "string" ? obj.code : null;
        if (code) renderCodeBlock(code);
        else if (input != null)
          writeWrappedLines("  args: ", JSON.stringify(input, null, 2), chalk.gray);
        break;
      }
      case "tool-result": {
        flushText();
        flushReasoning();
        const toolResult = (c.result ?? c.output) as unknown;
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
        const msg = c.error instanceof Error ? c.error.message : String(c.error ?? "");
        if (msg.trim()) {
          console.log(chalk.red("stream error:"));
          writeWrappedLines("  ", msg, chalk.red);
        }
        break;
      }
      case "finish":
        flushText();
        flushReasoning();
        break;
    }
  }

  flushText();
  flushReasoning();
  console.log("");
}

export async function runReplCli() {
  printHeader();
  printReplHelp();

  const messages: ModelMessage[] = [];

  while (true) {
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
      printAgentHeading();
      const result = await withFilteredTerminalNoise(() => agentStream({ messages }));
      await withFilteredTerminalNoise(() => renderReplStream(result));

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
  runReplCli();
}
