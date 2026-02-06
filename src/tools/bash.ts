/**
 * Bash tool for executing shell commands
 *
 * Based on the implementation from:
 * https://github.com/badlogic/pi-mono/tree/main/packages/mom/src/tools
 *
 * Credits to @badlogic for the original design and implementation patterns.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { jsonSchema } from "ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationResult,
} from "./utils.js";

/**
 * Generate a unique temp file path for bash output in the working directory
 */
function getTempFilePath(cwd: string): string {
  const id = randomBytes(8).toString("hex");
  return join(cwd, `data/one-bash-${id}.log`);
}

interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

/**
 * Execute a bash command
 */
async function executeBash(
  command: string,
  cwd: string,
  options?: {
    timeout?: number;
    signal?: AbortSignal;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-c", command], {
      cwd,
      env: process.env,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    // Handle timeout
    if (options?.timeout) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        // Force kill after 5s
        setTimeout(() => proc.kill("SIGKILL"), 5000);
      }, options.timeout * 1000);
    }

    // Handle abort signal
    const onAbort = () => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        proc.kill("SIGTERM");
        reject(new Error("aborted"));
        return;
      }
      options.signal.addEventListener("abort", onAbort);
    }

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options?.signal) options.signal.removeEventListener("abort", onAbort);
      reject(error);
    });

    proc.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options?.signal) options.signal.removeEventListener("abort", onAbort);

      if (options?.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }

      if (timedOut) {
        reject(new Error(`timeout:${options?.timeout}`));
        return;
      }

      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/**
 * Create bash tool for MCP server
 */
export function createBashTool(cwd: string) {
  return {
    description: `Execute a bash command in the working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: jsonSchema({
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Bash command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (optional)",
        },
      },
      required: ["command"],
    }),
    execute: async (
      {
        command,
        timeout,
      }: {
        command: string;
        timeout?: number;
      },
      extra?: any,
    ) => {
      let tempFilePath: string | undefined;
      let tempFileStream: ReturnType<typeof createWriteStream> | undefined;

      try {
        const result = await executeBash(command, cwd, {
          timeout,
          signal: extra?.signal,
        });

        // Combine stdout and stderr
        let output = "";
        if (result.stdout) output += result.stdout;
        if (result.stderr) {
          if (output) output += "\n";
          output += result.stderr;
        }

        const totalBytes = Buffer.byteLength(output, "utf-8");

        // Apply tail truncation first to determine if we need temp file
        const truncation = truncateTail(output);
        let outputText = truncation.content || "(no output)";

        // Write to temp file if truncation occurred
        if (truncation.truncated) {
          tempFilePath = getTempFilePath(cwd);
          tempFileStream = createWriteStream(tempFilePath);
          tempFileStream.write(output);
          tempFileStream.end();
        }

        // Build details with truncation info
        let details: BashToolDetails | undefined;

        if (truncation.truncated) {
          details = {
            truncation,
            fullOutputPath: tempFilePath,
          };

          // Build actionable notice
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;

          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(
              Buffer.byteLength(output.split("\n").pop() || "", "utf-8"),
            );
            outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
          } else if (truncation.truncatedBy === "lines") {
            outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
          } else {
            outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
          }
        }

        // Handle non-zero exit codes
        if (result.exitCode !== 0) {
          throw new Error(`${outputText}\n\nCommand exited with code ${result.exitCode}`.trim());
        }

        return {
          content: [{ type: "text", text: outputText }],
          ...(details && { details }),
        };
      } catch (error: any) {
        const errorMsg = error.message.startsWith("timeout:")
          ? `Command timed out after ${timeout} seconds`
          : error.message === "aborted"
            ? "Command was aborted"
            : error.message;

        return {
          content: [{ type: "text", text: errorMsg }],
          isError: true,
        };
      } finally {
        if (tempFileStream) {
          tempFileStream.end();
        }
      }
    },
  };
}
