/**
 * Utility functions for tool implementations
 *
 * Based on the implementation from:
 * https://github.com/badlogic/pi-mono/tree/main/packages/mom/src/tools
 *
 * Credits to @badlogic for the original design and implementation patterns.
 */

export const DEFAULT_MAX_LINES = 50;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy?: "lines" | "bytes" | "both";
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
  lastLinePartial?: boolean;
}

/**
 * Truncate output from the tail (keep last N lines/bytes)
 */
export function truncateTail(
  output: string,
  maxLines: number = DEFAULT_MAX_LINES,
  maxBytes: number = DEFAULT_MAX_BYTES,
): TruncationResult {
  const totalBytes = Buffer.byteLength(output, "utf-8");
  const lines = output.split("\n");
  const totalLines = lines.length;

  let truncated = false;
  let truncatedBy: "lines" | "bytes" | "both" | undefined;
  let content = output;
  let lastLinePartial = false;

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

  // Start from the end, accumulate lines until we hit limits
  const keptLines: string[] = [];
  let currentBytes = 0;
  let linesTruncated = false;
  let bytesTruncated = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line + "\n", "utf-8");

    // Check if adding this line would exceed byte limit
    if (currentBytes + lineBytes > maxBytes) {
      bytesTruncated = true;
      // Try to fit partial line
      const remainingBytes = maxBytes - currentBytes;
      if (remainingBytes > 100) {
        // Only include partial if we have reasonable space
        const partialLine = line.substring(line.length - Math.floor(remainingBytes));
        keptLines.unshift(partialLine);
        lastLinePartial = true;
      }
      break;
    }

    // Check if we've kept enough lines
    if (keptLines.length >= maxLines) {
      linesTruncated = true;
      break;
    }

    keptLines.unshift(line);
    currentBytes += lineBytes;
  }

  if (linesTruncated || bytesTruncated) {
    truncated = true;
    content = keptLines.join("\n");
    if (linesTruncated && bytesTruncated) {
      truncatedBy = "both";
    } else if (linesTruncated) {
      truncatedBy = "lines";
    } else {
      truncatedBy = "bytes";
    }
  }

  return {
    content,
    truncated,
    truncatedBy,
    totalLines,
    outputLines: keptLines.length,
    totalBytes,
    outputBytes: Buffer.byteLength(content, "utf-8"),
    lastLinePartial,
  };
}

/**
 * Format bytes as human-readable size
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Escape a string for safe use in shell commands
 */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
