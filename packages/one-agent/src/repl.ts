import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type { ModelMessage } from "ai";
import { agentStream } from "./agent.js";
import { startTracing } from "./tracing.js";
import { processStream } from "./utils/stream.js";

// Initialize OpenTelemetry tracing
startTracing();

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
    "  /reset  Clear conversation context",
    "  /exit   Quit REPL",
    "",
    "Tips:",
    "  - Context is preserved across turns until /reset",
    "  - Use Ctrl+C to interrupt current generation",
  ];
  console.log(chalk.gray(lines.join("\n")));
}

function getResolvedModelIdForDisplay(): string {
  return (
    process.env.ONE_CHAT_MODEL?.trim() ||
    process.env.ONE_AGENT_MODEL?.trim() ||
    process.env.MODEL?.trim() ||
    "gemini-3.1-pro"
  );
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
      console.log(chalk.green("\n👋 Goodbye!\n"));
      rl.close();
      break;
    }

    if (trimmed.toLowerCase() === "/help") {
      printReplHelp();
      continue;
    }

    if (trimmed.toLowerCase() === "/reset") {
      messages.length = 0;
      console.log(chalk.yellow("Context cleared."));
      continue;
    }

    try {
      messages.push({ role: "user", content: trimmed });

      printSeparator();
      console.log(chalk.blue.bold("\n🤖 Agent:"));
      const result = await agentStream({ messages });
      await processStream(result);

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
