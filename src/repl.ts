import * as readline from "node:readline";
import chalk from "chalk";
import { agent } from "./agent.js";
import { startTracing } from "./tracing.js";

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
  const help = chalk.gray('  Type your prompt or "exit" to quit');

  console.log("\n" + border);
  console.log(title);
  console.log(subtitle);
  console.log(help);
  console.log(border + "\n");
}

function printSeparator() {
  console.log(chalk.gray("─".repeat(70)));
}

async function main() {
  printHeader();

  while (true) {
    const userInput = await prompt(chalk.blue("❯ "));

    if (userInput.toLowerCase() === "exit" || userInput.toLowerCase() === "quit") {
      console.log(chalk.green("\n👋 Goodbye!\n"));
      rl.close();
      break;
    }

    if (!userInput.trim()) {
      continue;
    }

    try {
      printSeparator();
      console.log(chalk.blue.bold("\n🤖 Agent:"));
      await agent(userInput);
      printSeparator();
    } catch (error) {
      console.log("");
      const errorMsg = error instanceof Error ? error.message : String(error);

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

main();
