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
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
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

interface BashExecutionOptions {
  timeout?: number;
  signal?: AbortSignal;
}

interface BashExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface FormattedBashOutput {
  outputText: string;
  details?: BashToolDetails;
}

function terminateProcess(proc: ReturnType<typeof spawn>) {
  proc.kill("SIGTERM");
  setTimeout(() => proc.kill("SIGKILL"), 5000);
}

function combineCommandOutput(stdout: string, stderr: string): string {
  if (!stdout) {
    return stderr;
  }
  if (!stderr) {
    return stdout;
  }
  return `${stdout}\n${stderr}`;
}

function ensureDataDir(cwd: string) {
  const dataDir = join(cwd, "data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

function buildTruncationNotice(
  truncation: TruncationResult,
  output: string,
  fullOutputPath: string,
): string {
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;

  if (truncation.lastLinePartial) {
    const lastLineSize = formatSize(Buffer.byteLength(output.split("\n").pop() || "", "utf-8"));
    return `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${fullOutputPath}]`;
  }

  if (truncation.truncatedBy === "lines") {
    return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
  }

  return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
}

function formatCommandOutput(output: string, cwd: string): FormattedBashOutput {
  const truncation = truncateTail(output);
  const outputText = truncation.content || "(no output)";

  if (!truncation.truncated) {
    return { outputText };
  }

  ensureDataDir(cwd);
  const fullOutputPath = getTempFilePath(cwd);
  writeFileSync(fullOutputPath, output);

  return {
    outputText: `${outputText}\n\n${buildTruncationNotice(truncation, output, fullOutputPath)}`,
    details: {
      truncation,
      fullOutputPath,
    },
  };
}

function toErrorMessage(error: unknown, timeout?: number): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  if (error.message.startsWith("timeout:")) {
    return `Command timed out after ${timeout} seconds`;
  }

  if (error.message === "aborted") {
    return "Command was aborted";
  }

  return error.message;
}

function errorResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

/**
 * Execute a bash command
 */
async function executeBash(
  command: string,
  cwd: string,
  options?: BashExecutionOptions,
): Promise<BashExecutionResult> {
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
        terminateProcess(proc);
      }, options.timeout * 1000);
    }

    // Handle abort signal
    const onAbort = () => {
      terminateProcess(proc);
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        terminateProcess(proc);
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
      try {
        const result = await executeBash(command, cwd, {
          timeout,
          signal: extra?.signal,
        });

        const output = combineCommandOutput(result.stdout, result.stderr);
        const { outputText, details } = formatCommandOutput(output, cwd);

        if (result.exitCode !== 0) {
          return errorResponse(
            `${outputText}\n\nCommand exited with code ${result.exitCode}`.trim(),
          );
        }

        return {
          content: [{ type: "text", text: outputText }],
          ...(details && { details }),
        };
      } catch (error: unknown) {
        return errorResponse(toErrorMessage(error, timeout));
      }
    },
  };
}
