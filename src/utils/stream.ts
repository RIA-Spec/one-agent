import chalk from "chalk";
import type { StreamTextResult } from "ai";

interface BoxOptions {
  title?: string;
  padding?: number;
  borderColor?: string;
}

/**
 * Truncate lines that are too long, preserving indentation
 */
function truncateLines(text: string, maxWidth: number = 100): string {
  return text
    .split("\n")
    .map((line) => {
      if (displayWidth(line) <= maxWidth) {
        return line;
      }

      // Find leading spaces/indentation
      const match = line.match(/^(\s*)/);
      const indent = match ? match[1] : "";
      const content = line.slice(indent.length);

      // Calculate available width after indent
      const availWidth = maxWidth - displayWidth(indent) - 3; // 3 for "..."

      // Truncate content
      let truncated = "";
      let width = 0;
      for (let i = 0; i < content.length; i++) {
        const char = content[i];
        const code = char.charCodeAt(0);
        const charWidth =
          (code >= 0x4e00 && code <= 0x9fff) ||
          (code >= 0x3400 && code <= 0x4dbf) ||
          (code >= 0xff00 && code <= 0xffef) ||
          (code >= 0x3040 && code <= 0x309f) ||
          (code >= 0x30a0 && code <= 0x30ff) ||
          (code >= 0x1100 && code <= 0x11ff) ||
          (code >= 0xac00 && code <= 0xd7af)
            ? 2
            : 1;

        if (width + charWidth > availWidth) {
          break;
        }
        truncated += char;
        width += charWidth;
      }

      return indent + truncated + chalk.gray("...");
    })
    .join("\n");
}

/**
 * Create a box around content with optional title
 */
function createBox(content: string, options: BoxOptions = {}): string {
  const { title, padding = 1, borderColor = "cyan" } = options;

  // Safety check
  if (!content) {
    content = "(empty)";
  }

  const lines = content.split("\n");
  const maxWidth = Math.max(
    ...lines.map((line) => displayWidth(line || "")),
    title ? displayWidth(title) + 2 : 0,
  );
  const totalWidth = maxWidth + padding * 2;

  const borderChalk = (chalk as any)[borderColor] || chalk.cyan;
  const topBorder = title
    ? borderChalk(`┌─ ${title} `) +
      borderChalk("─".repeat(Math.max(0, totalWidth - displayWidth(title) - 4))) +
      borderChalk("┐")
    : borderChalk("┌" + "─".repeat(totalWidth) + "┐");
  const bottomBorder = borderChalk("└" + "─".repeat(totalWidth) + "┘");
  const pad = " ".repeat(padding);

  const boxedLines = lines.map((line) => {
    const visibleWidth = displayWidth(line || "");
    const spaces = " ".repeat(Math.max(0, maxWidth - visibleWidth));
    return borderChalk("│") + pad + (line || "") + spaces + pad + borderChalk("│");
  });

  return [topBorder, ...boxedLines, bottomBorder].join("\n");
}

/**
 * Strip ANSI codes to measure visible width
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Calculate actual display width considering full-width characters (CJK)
 * Full-width characters (Chinese, Japanese, Korean) take 2 columns
 */
function displayWidth(str: string): number {
  const cleaned = stripAnsi(str);
  let width = 0;

  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.charCodeAt(i);
    // Check if it's a full-width character (CJK, full-width punctuation, etc.)
    // CJK Unified Ideographs: 0x4E00-0x9FFF
    // CJK Extension A: 0x3400-0x4DBF
    // Full-width forms: 0xFF00-0xFFEF
    // Hiragana: 0x3040-0x309F
    // Katakana: 0x30A0-0x30FF
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
      (code >= 0xac00 && code <= 0xd7af) // Hangul Syllables
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }

  return width;
}

/**
 * Format Python code with basic syntax highlighting
 */
function highlightPython(code: string): string {
  // Keywords
  code = code.replace(
    /\b(def|class|import|from|as|if|else|elif|for|while|return|async|await|try|except|finally|with|pass|break|continue|yield|lambda|and|or|not|in|is|None|True|False)\b/g,
    chalk.magenta("$1"),
  );

  // Strings
  code = code.replace(/(['"`])((?:\\.|(?!\1).)*?)\1/g, chalk.green("$1$2$1"));

  // Comments
  code = code.replace(/(#.*$)/gm, chalk.gray("$1"));

  // Function names
  code = code.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g, chalk.yellow("$1") + "(");

  // Numbers
  code = code.replace(/\b(\d+\.?\d*)\b/g, chalk.cyan("$1"));

  return code;
}

/**
 * Format JSON with colors
 */
function highlightJSON(json: string): string {
  return json
    .replace(/"([^"]+)":/g, chalk.cyan('"$1"') + ":")
    .replace(/: "([^"]*)"/g, ": " + chalk.green('"$1"'))
    .replace(/: (\d+\.?\d*)/g, ": " + chalk.yellow("$1"))
    .replace(/: (true|false|null)/g, ": " + chalk.magenta("$1"));
}

/**
 * Truncate text with ellipsis
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Format tool output based on content type
 */
function formatToolOutput(output: any, toolName: string): string {
  // Handle undefined/null
  if (output === undefined || output === null) {
    return "(no output)";
  }

  if (typeof output === "string") {
    return output;
  }

  if (typeof output === "object") {
    // Handle tool result structure
    if (output.content && Array.isArray(output.content)) {
      const result = output.content
        .map((item: any) => {
          if (item.type === "text") return item.text || "";
          return JSON.stringify(item, null, 2);
        })
        .join("\n");
      return result || "(empty output)";
    }
  }

  // Fallback to JSON stringify, with safety check
  try {
    const jsonStr = JSON.stringify(output, null, 2);
    return jsonStr || "(empty output)";
  } catch (e) {
    return String(output);
  }
}

export async function processStream(result: StreamTextResult<any, any>, prefix?: string) {
  let isFirstText = true;
  let currentToolName = "";

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case "text-delta":
        if (isFirstText) {
          isFirstText = false;
          // Add a newline before the first text to separate from prompt
        }
        process.stdout.write(chunk.text);
        break;

      case "tool-call": {
        currentToolName = chunk.toolName;

        // Format arguments based on tool type
        const args = chunk.input as any;

        // Handle nested one-runner -> run tool calls
        if (chunk.toolName === "one-runner" && args?.tool === "run" && args?.args?.code) {
          const code = args.args.code as string;
          const codeLines = code.split("\n");

          console.log("\n" + chalk.yellow.bold(`🔧 ${args.tool.toUpperCase()}`));

          // Format long code smartly - only truncate if really long (>80 lines)
          if (codeLines.length > 80) {
            const firstPart = codeLines.slice(0, 50).join("\n");
            const lastPart = codeLines.slice(-10).join("\n");
            const omitted = codeLines.length - 60;
            const combined =
              firstPart + chalk.gray(`\n\n... (${omitted} lines omitted) ...\n\n`) + lastPart;
            const truncated = truncateLines(combined, 100);
            const highlighted = highlightPython(truncated);
            console.log(
              createBox(highlighted, {
                title: `Python Code (${codeLines.length} lines)`,
                borderColor: "yellow",
              }),
            );
          } else {
            const truncated = truncateLines(code, 100);
            const highlighted = highlightPython(truncated);
            const title =
              codeLines.length > 40 ? `Python Code (${codeLines.length} lines)` : "Python Code";
            console.log(createBox(highlighted, { title, borderColor: "yellow" }));
          }

          // Show packages if any
          if (args.args.packages && Object.keys(args.args.packages).length > 0) {
            console.log(chalk.gray("\n📦 Packages:"));
            const pkgStr = JSON.stringify(args.args.packages, null, 2);
            console.log(chalk.gray("  " + highlightJSON(pkgStr).replace(/\n/g, "\n  ")));
          }
        }
        // Handle nested one-runner -> bash tool calls
        else if (chunk.toolName === "one-runner" && args?.tool === "bash" && args?.args?.command) {
          const command = args.args.command as string;
          const truncated = command.length > 80 ? command.slice(0, 77) + "..." : command;
          console.log(
            "\n" +
              chalk.yellow.bold(`🔧 ${args.tool.toUpperCase()}`) +
              chalk.gray(` $ ${truncated}`),
          );
        }
        // Handle other one-runner calls
        else if (chunk.toolName === "one-runner" && args?.tool) {
          console.log("\n" + chalk.yellow.bold(`🔧 ${args.tool.toUpperCase()}`));
          const toolArgs = args.args || {};
          const argsStr = JSON.stringify(toolArgs, null, 2);
          if (argsStr !== "{}") {
            console.log(chalk.gray("  " + highlightJSON(argsStr).replace(/\n/g, "\n  ")));
          }
        }
        // Direct run tool call
        else if (chunk.toolName === "run" && args?.code) {
          const code = args.code as string;
          const codeLines = code.split("\n");

          console.log("\n" + chalk.yellow.bold(`🔧 RUN`));

          // Format long code smartly - only truncate if really long (>80 lines)
          if (codeLines.length > 80) {
            const firstPart = codeLines.slice(0, 50).join("\n");
            const lastPart = codeLines.slice(-10).join("\n");
            const omitted = codeLines.length - 60;
            const combined =
              firstPart + chalk.gray(`\n\n... (${omitted} lines omitted) ...\n\n`) + lastPart;
            const truncated = truncateLines(combined, 100);
            const highlighted = highlightPython(truncated);
            console.log(
              createBox(highlighted, {
                title: `Python Code (${codeLines.length} lines)`,
                borderColor: "yellow",
              }),
            );
          } else {
            const truncated = truncateLines(code, 100);
            const highlighted = highlightPython(truncated);
            const title =
              codeLines.length > 40 ? `Python Code (${codeLines.length} lines)` : "Python Code";
            console.log(createBox(highlighted, { title, borderColor: "yellow" }));
          }

          // Show packages if any
          if (args.packages && Object.keys(args.packages).length > 0) {
            console.log(chalk.gray("\n📦 Packages:"));
            const pkgStr = JSON.stringify(args.packages, null, 2);
            console.log(chalk.gray("  " + highlightJSON(pkgStr).replace(/\n/g, "\n  ")));
          }
        }
        // Bash commands
        else if (chunk.toolName === "bash" && args?.command) {
          const command = args.command as string;
          const truncated = command.length > 80 ? command.slice(0, 77) + "..." : command;
          console.log("\n" + chalk.yellow.bold(`🔧 BASH`) + chalk.gray(` $ ${truncated}`));
        }
        // Generic tool args
        else {
          console.log("\n" + chalk.yellow.bold(`🔧 ${chunk.toolName.toUpperCase()}`));
          const argsStr = JSON.stringify(args, null, 2);
          if (argsStr.length > 500) {
            console.log(chalk.gray("  " + truncate(argsStr, 200)));
          } else if (argsStr !== "{}") {
            console.log(chalk.gray("  " + highlightJSON(argsStr).replace(/\n/g, "\n  ")));
          }
        }
        break;
      }

      case "tool-result": {
        // AI SDK uses 'result' for newer versions, 'output' for older
        const resultData = (chunk as any).result ?? (chunk as any).output;
        const output = formatToolOutput(resultData, currentToolName);

        // Format based on tool type
        if (currentToolName === "run" || currentToolName === "bash") {
          // Command output
          const lines = output.split("\n");
          const hasError =
            output.toLowerCase().includes("error") || output.toLowerCase().includes("traceback");
          const borderColor = hasError ? "red" : "green";
          const title = hasError ? "Error Output" : "Output";

          if (lines.length > 50) {
            // Truncate long output
            const displayed =
              lines.slice(0, 40).join("\n") +
              chalk.gray(`\n\n... (${lines.length - 40} more lines)`);
            console.log(
              createBox(hasError ? chalk.red(displayed) : displayed, { title, borderColor }),
            );
          } else {
            console.log(createBox(hasError ? chalk.red(output) : output, { title, borderColor }));
          }
        } else {
          // Generic result
          const outputStr =
            typeof resultData === "string"
              ? resultData
              : JSON.stringify(resultData, null, 2) || output;
          if (outputStr.length > 1000) {
            console.log(chalk.green(`✓ Result: ${truncate(outputStr, 200)}`));
          } else {
            console.log(chalk.green("✓ Result:"));
            console.log(highlightJSON(outputStr));
          }
        }
        console.log(""); // Empty line after result
        break;
      }

      case "error":
        console.log("\n");
        const errorMsg = chunk.error instanceof Error ? chunk.error.message : String(chunk.error);
        console.log(createBox(chalk.red.bold(errorMsg), { title: "Error", borderColor: "red" }));
        console.log("");
        break;
    }
  }

  console.log(""); // Final newline
}
