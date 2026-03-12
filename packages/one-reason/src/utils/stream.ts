import chalk from "chalk";
import type { StreamTextResult } from "ai";

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function formatToolOutput(output: any): string {
  if (output == null) return "(no output)";
  if (typeof output === "string") return output;
  if (typeof output === "object" && Array.isArray(output.content)) {
    return (
      output.content
        .map((item: any) =>
          item.type === "text" ? item.text || "" : JSON.stringify(item, null, 2),
        )
        .join("\n") || "(empty)"
    );
  }
  try {
    return JSON.stringify(output, null, 2) || "(empty)";
  } catch {
    return String(output);
  }
}

function printIndented(text: string, indent: string, style?: (value: string) => string) {
  for (const line of text.split("\n")) {
    const content = style ? style(line) : line;
    console.log(indent + content);
  }
}

export async function processStream(result: StreamTextResult<any, any>, prefix?: string) {
  const nested = Boolean(prefix);
  const tag = prefix ? `[${prefix.toUpperCase()}]` : "";
  const linePrefix = nested ? chalk.blue("  |  ") : "";

  let atLineStart = true;
  let firstText = true;
  let firstReasoning = true;

  function writeStreaming(text: string, style?: (value: string) => string) {
    const parts = text.split("\n");
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) {
        process.stdout.write("\n");
        atLineStart = true;
      }
      if (parts[index]) {
        if (atLineStart && nested) process.stdout.write(linePrefix);
        process.stdout.write(style ? style(parts[index]) : parts[index]);
        atLineStart = false;
      }
    }
  }

  for await (const chunk of result.fullStream as AsyncIterable<any>) {
    switch (chunk.type) {
      case "text-delta": {
        if (firstText) {
          firstText = false;
          if (nested) {
            console.log(chalk.blue("  +- ") + tag + " Response:");
            atLineStart = true;
          }
        }
        nested
          ? writeStreaming(chunk.textDelta ?? chunk.text ?? "", chalk.dim)
          : process.stdout.write(chunk.textDelta ?? chunk.text ?? "");
        break;
      }

      case "reasoning": {
        if (firstReasoning) {
          firstReasoning = false;
          console.log(
            nested ? chalk.blue("  +- ") + chalk.cyan("Thinking...") : chalk.cyan("Thinking..."),
          );
          atLineStart = true;
        }
        const text = (chunk as any).text || (chunk as any).delta || "";
        nested ? writeStreaming(text, chalk.dim) : process.stdout.write(chalk.cyan(text));
        break;
      }

      case "tool-call": {
        if (!atLineStart) {
          process.stdout.write("\n");
          atLineStart = true;
        }

        const args = chunk.args as any;
        const indent = nested ? `${linePrefix}  ` : "  ";
        const header = nested
          ? chalk.blue("  +- ") + tag + chalk.yellow(` Tool ${chunk.toolName}`)
          : chalk.yellow(`Tool ${chunk.toolName}`);
        const code = args?.code || (args?.tool === "run" && args?.args?.code);
        const command = args?.command || (args?.tool === "bash" && args?.args?.command);

        if (code) {
          console.log(header);
          const lines = typeof code === "string" ? code.split("\n") : [];
          if (lines.length > 80) {
            printIndented(lines.slice(0, 50).join("\n"), indent, chalk.gray);
            console.log(indent + chalk.gray(`... (${lines.length - 60} lines omitted) ...`));
            printIndented(lines.slice(-10).join("\n"), indent, chalk.gray);
          } else {
            printIndented(code, indent, chalk.gray);
          }
        } else if (command) {
          console.log(header + chalk.gray(` $ ${command}`));
        } else {
          console.log(header);
          const displayArgs = args?.tool && args?.args ? args.args : args;
          const text = JSON.stringify(displayArgs, null, 2);
          if (text && text !== "{}") {
            printIndented(truncate(text, 500), indent, chalk.gray);
          }
        }
        break;
      }

      case "tool-result": {
        const data = (chunk as any).result ?? (chunk as any).output;
        const output = formatToolOutput(data);
        const indent = nested ? linePrefix : "";
        const isError =
          data?.isError === true ||
          (typeof data === "object" && data !== null && "error" in data && data.error != null);

        if (isError) {
          console.log(indent + chalk.red("Error:"));
          printIndented(output, indent + "  ", chalk.red);
        } else {
          const lines = output.split("\n");
          if (lines.length > 30) {
            console.log(indent + chalk.green(`Result (${lines.length} lines):`));
            printIndented(lines.slice(0, 20).join("\n"), indent + "  ", chalk.dim);
            console.log(indent + chalk.gray(`  ... (${lines.length - 20} more lines)`));
          } else {
            console.log(indent + chalk.green("Result:"));
            printIndented(output, indent + "  ", chalk.dim);
          }
        }
        break;
      }

      case "error": {
        const message = chunk.error instanceof Error ? chunk.error.message : String(chunk.error);
        const indent = nested ? linePrefix : "";
        console.log(indent + chalk.red.bold(`Error: ${message}`));
        break;
      }
    }
  }

  console.log("");
}
