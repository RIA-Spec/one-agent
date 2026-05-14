/**
 * Read tool - Smart file reading with truncation protection
 *
 * Based on the implementation from:
 * https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/src/core/tools/read.ts
 *
 * Credits to @badlogic for the original design and implementation patterns.
 */

import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { jsonSchema } from "ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../../interfaces/tools/utils.js";

interface ReadToolDetails {
  truncation?: {
    totalLines: number;
    outputLines: number;
    totalBytes: number;
    outputBytes: number;
  };
}

/**
 * Resolve path to working directory
 */
function resolveToCwd(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * Truncate content from the head (keep first N lines/bytes)
 */
function truncateHead(
  content: string,
  maxLines: number = DEFAULT_MAX_LINES,
  maxBytes: number = DEFAULT_MAX_BYTES,
): {
  content: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
} {
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  // If within limits, return as-is
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      totalLines,
      outputLines: totalLines,
      totalBytes,
      outputBytes: totalBytes,
    };
  }

  // Take lines from the start until we hit limits
  const keptLines: string[] = [];
  let currentBytes = 0;

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line + "\n", "utf-8");

    // Check if adding this line would exceed byte limit
    if (currentBytes + lineBytes > maxBytes) {
      break;
    }

    // Check if we've kept enough lines
    if (keptLines.length >= maxLines) {
      break;
    }

    keptLines.push(line);
    currentBytes += lineBytes;
  }

  return {
    content: keptLines.join("\n"),
    truncated: true,
    totalLines,
    outputLines: keptLines.length,
    totalBytes,
    outputBytes: currentBytes,
  };
}

/**
 * Create read tool for MCP server
 */
export function createReadTool(cwd: string) {
  return {
    description: `Read the contents of a file. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: jsonSchema({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to read (relative or absolute)",
        },
        offset: {
          type: "number",
          description: "Line number to start reading from (1-indexed, optional)",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read (optional)",
        },
      },
      required: ["path"],
    }),
    execute: async (
      {
        path,
        offset,
        limit,
      }: {
        path: string;
        offset?: number;
        limit?: number;
      },
      extra?: any,
    ) => {
      try {
        const absolutePath = resolveToCwd(path, cwd);

        // Check if file is readable
        try {
          await access(absolutePath, constants.R_OK);
        } catch {
          throw new Error(`Cannot read file: ${path}`);
        }

        // Read file
        const buffer = await readFile(absolutePath);
        const fullContent = buffer.toString("utf-8");
        const allLines = fullContent.split("\n");
        const totalLines = allLines.length;

        // Handle offset/limit
        let content: string;
        let actualStartLine = 1;
        let actualEndLine = totalLines;

        if (offset !== undefined || limit !== undefined) {
          const startIdx = offset ? Math.max(0, offset - 1) : 0;
          const endIdx = limit ? Math.min(totalLines, startIdx + limit) : totalLines;

          actualStartLine = startIdx + 1;
          actualEndLine = endIdx;

          const selectedLines = allLines.slice(startIdx, endIdx);
          content = selectedLines.join("\n");

          // Return without truncation when using offset/limit
          return {
            content: [
              {
                type: "text" as const,
                text: `${content}\n\n[Showing lines ${actualStartLine}-${actualEndLine} of ${totalLines}]`,
              },
            ],
          };
        }

        // Apply truncation for full file reads
        const truncation = truncateHead(fullContent);
        // Add line numbers (cat -n format: "lineNum\tcontent") so the model
        // can precisely identify lines when constructing oldText for Edit.
        const numberedLines = truncation.content.split("\n").map((line, i) => `${i + 1}\t${line}`);
        let outputText = numberedLines.join("\n");

        let details: ReadToolDetails | undefined;

        if (truncation.truncated) {
          details = {
            truncation: {
              totalLines: truncation.totalLines,
              outputLines: truncation.outputLines,
              totalBytes: truncation.totalBytes,
              outputBytes: truncation.outputBytes,
            },
          };

          const bytesExceeded = truncation.totalBytes > DEFAULT_MAX_BYTES;
          const linesExceeded = truncation.totalLines > DEFAULT_MAX_LINES;

          if (bytesExceeded && linesExceeded) {
            outputText += `\n\n[Showing lines 1-${truncation.outputLines} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} and ${DEFAULT_MAX_LINES} line limits). Use offset=${truncation.outputLines + 1} to continue.]`;
          } else if (bytesExceeded) {
            outputText += `\n\n[Showing lines 1-${truncation.outputLines} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${truncation.outputLines + 1} to continue.]`;
          } else {
            outputText += `\n\n[Showing lines 1-${truncation.outputLines} of ${truncation.totalLines}. Use offset=${truncation.outputLines + 1} to continue.]`;
          }
        }

        return {
          content: [{ type: "text" as const, text: outputText }],
          ...(details && { details }),
        };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: error.message }],
          isError: true,
        };
      }
    },
  };
}
