import * as readline from "node:readline";
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

async function main() {
  console.log("ONE");
  console.log('Type your prompts below. Type "exit" to quit.\n');

  while (true) {
    const userInput = await prompt("You: ");

    if (userInput.toLowerCase() === "exit") {
      console.log("Goodbye!");
      rl.close();
      break;
    }

    if (!userInput.trim()) {
      continue;
    }

    try {
      console.log("\nAgent: ");
      await agent(userInput);
      console.log();
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
    }
  }
}

main();
