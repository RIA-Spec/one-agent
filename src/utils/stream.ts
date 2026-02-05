import chalk from "chalk";
import type { StreamTextResult } from "ai";

export async function processStream(result: StreamTextResult<any, any>, prefix?: string) {
  const prefixStr = prefix ? `[${prefix}] ` : "";

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case "text-delta":
        process.stdout.write(chunk.text);
        break;
      case "tool-call":
        console.log(chalk.yellow(`\n${prefixStr}[Tool: ${chunk.toolName}]`));
        console.log(chalk.gray(`${prefixStr}[Args]: ${JSON.stringify(chunk.input, null, 2)}`));
        break;
      case "tool-result":
        console.log(chalk.green(`${prefixStr}[Result]: ${JSON.stringify(chunk.output, null, 2)}`));
        break;
      case "error":
        console.error(chalk.red.bold(`${prefixStr}[Error]: ${chunk.error}`));
        break;
    }
  }

  console.log("\n");
}
