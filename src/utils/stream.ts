import chalk from "chalk";
import type { StreamTextResult } from "ai";

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 3) + "...";
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

function printIndented(text: string, indent: string, style?: (s: string) => string): void {
  for (const line of text.split("\n")) {
    const content = style ? style(line) : line;
    console.log(indent + content);
  }
}

export async function processStream(result: StreamTextResult<any, any>, prefix?: string) {
  const nested = !!prefix;
  const tag = prefix ? `[${prefix.toUpperCase()}]` : "";
  const P = nested ? chalk.blue("  │  ") : ""; // line prefix

  let atLineStart = true;
  let firstText = true;
  let firstReasoning = true;

  /** Write streaming text, only adding │ prefix at line starts */
  function writeStreaming(text: string, style?: (s: string) => string): void {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        process.stdout.write("\n");
        atLineStart = true;
      }
      if (parts[i]) {
        if (atLineStart && nested) process.stdout.write(P);
        process.stdout.write(style ? style(parts[i]) : parts[i]);
        atLineStart = false;
      }
    }
  }

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case "text-delta": {
        if (firstText) {
          firstText = false;
          if (nested) {
            console.log(chalk.blue("  ├─ ") + tag + " Response:");
            atLineStart = true;
          }
        }
        nested ? writeStreaming(chunk.text, chalk.dim) : process.stdout.write(chunk.text);
        break;
      }

      case "reasoning-delta": {
        if (firstReasoning) {
          firstReasoning = false;
          console.log(
            nested
              ? chalk.blue("  ├─ ") + chalk.cyan("💭 Thinking...")
              : chalk.cyan("💭 Thinking..."),
          );
          atLineStart = true;
        }
        const text = (chunk as any).text || (chunk as any).delta || "";
        nested ? writeStreaming(text, chalk.dim) : process.stdout.write(chalk.cyan(text));
        break;
      }

      case "tool-call": {
        // Ensure newline before tool call if streaming text didn't end with one
        if (!atLineStart) {
          process.stdout.write("\n");
          atLineStart = true;
        }

        const args = chunk.input as any;
        const indent = nested ? P + "  " : "  ";

        const header = nested
          ? chalk.blue("  ├─ ") + tag + chalk.yellow(` 🔧 ${chunk.toolName.toUpperCase()}`)
          : chalk.yellow(`🔧 ${chunk.toolName.toUpperCase()}`);

        // Extract code/command from direct or nested one-runner calls
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
          const str = JSON.stringify(displayArgs, null, 2);
          if (str && str !== "{}") {
            printIndented(truncate(str, 500), indent, chalk.gray);
          }
        }
        break;
      }

      case "tool-result": {
        const data = (chunk as any).result ?? (chunk as any).output;
        const output = formatToolOutput(data);
        const indent = nested ? P : "";
        // Check for isError flag (from act) or error field (from reason)
        const isError =
          data?.isError === true ||
          (typeof data === "object" && data !== null && "error" in data && data.error != null);

        if (isError) {
          console.log(indent + chalk.red("✗ Error:"));
          printIndented(output, indent + "  ", chalk.red);
        } else {
          const lines = output.split("\n");
          if (lines.length > 30) {
            console.log(indent + chalk.green(`✓ Result (${lines.length} lines):`));
            printIndented(lines.slice(0, 20).join("\n"), indent + "  ", chalk.dim);
            console.log(indent + chalk.gray(`  ... (${lines.length - 20} more lines)`));
          } else {
            console.log(indent + chalk.green("✓ Result:"));
            printIndented(output, indent + "  ", chalk.dim);
          }
        }

        if (nested) console.log(chalk.blue("  └─"));
        break;
      }

      case "error": {
        const msg = chunk.error instanceof Error ? chunk.error.message : String(chunk.error);
        const indent = nested ? P : "";
        console.log(indent + chalk.red.bold("✗ Error: " + msg));
        if (nested) console.log(chalk.blue("  └─"));
        break;
      }
    }
  }

  if (nested) console.log(chalk.blue("  └─"));
  console.log("");
}
