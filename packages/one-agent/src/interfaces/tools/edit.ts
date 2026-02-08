/**
 * Edit tool - Precise file editing with find/replace
 *
 * Based on the implementation from:
 * https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/src/core/tools/edit.ts
 *
 * Credits to @badlogic for the original design and implementation patterns.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { jsonSchema } from "ai";
import { diffLines } from "diff";

interface EditToolDetails {
  diff: string;
  firstChangedLine?: number;
}

/**
 * Resolve path to working directory
 */
function resolveToCwd(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * Normalize whitespace for fuzzy matching
 */
function normalizeWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * Find text in content with fuzzy whitespace matching
 */
function findWithFuzzyMatch(
  content: string,
  searchText: string,
): { index: number; matchedText: string } | null {
  // Try exact match first
  const exactIndex = content.indexOf(searchText);
  if (exactIndex !== -1) {
    return { index: exactIndex, matchedText: searchText };
  }

  // Try fuzzy match (normalized whitespace)
  const normalizedSearch = normalizeWhitespace(searchText);
  const normalizedContent = normalizeWhitespace(content);

  const fuzzyIndex = normalizedContent.indexOf(normalizedSearch);
  if (fuzzyIndex === -1) {
    return null;
  }

  // Find the actual position in original content
  let originalPos = 0;
  let normalizedPos = 0;

  while (normalizedPos < fuzzyIndex && originalPos < content.length) {
    const char = content[originalPos];
    const normalizedChar = normalizedContent[normalizedPos];

    if (char === " " || char === "\t" || char === "\r") {
      // Skip whitespace in original
      originalPos++;
    } else if (char === "\n") {
      originalPos++;
      if (normalizedChar === "\n") {
        normalizedPos++;
      }
    } else {
      originalPos++;
      normalizedPos++;
    }
  }

  // Extract the matched text from original content
  let matchEnd = originalPos;
  let matchedNormalizedLength = 0;

  while (matchedNormalizedLength < normalizedSearch.length && matchEnd < content.length) {
    const char = content[matchEnd];

    if (char === " " || char === "\t" || char === "\r") {
      matchEnd++;
    } else if (char === "\n") {
      matchEnd++;
      if (normalizedSearch[matchedNormalizedLength] === "\n") {
        matchedNormalizedLength++;
      }
    } else {
      matchEnd++;
      matchedNormalizedLength++;
    }
  }

  return {
    index: originalPos,
    matchedText: content.substring(originalPos, matchEnd),
  };
}

/**
 * Create unified diff
 */
function createUnifiedDiff(oldContent: string, newContent: string, filePath: string): string {
  const changes = diffLines(oldContent, newContent);
  const lines: string[] = [];

  lines.push(`--- ${filePath}`);
  lines.push(`+++ ${filePath}`);

  let oldLine = 1;
  let newLine = 1;
  let hunkOldStart = 1;
  let hunkNewStart = 1;
  let hunkOldCount = 0;
  let hunkNewCount = 0;
  const hunkLines: string[] = [];

  for (const change of changes) {
    const count = change.count || 0;

    if (change.added) {
      for (let i = 0; i < count; i++) {
        const line = change.value.split("\n")[i];
        if (line !== undefined) {
          hunkLines.push(`+${line}`);
        }
      }
      hunkNewCount += count;
      newLine += count;
    } else if (change.removed) {
      for (let i = 0; i < count; i++) {
        const line = change.value.split("\n")[i];
        if (line !== undefined) {
          hunkLines.push(`-${line}`);
        }
      }
      hunkOldCount += count;
      oldLine += count;
    } else {
      for (let i = 0; i < count; i++) {
        const line = change.value.split("\n")[i];
        if (line !== undefined) {
          hunkLines.push(` ${line}`);
        }
      }
      hunkOldCount += count;
      hunkNewCount += count;
      oldLine += count;
      newLine += count;
    }
  }

  if (hunkLines.length > 0) {
    lines.push(`@@ -${hunkOldStart},${hunkOldCount} +${hunkNewStart},${hunkNewCount} @@`);
    lines.push(...hunkLines);
  }

  return lines.join("\n");
}

/**
 * Find the first changed line number
 */
function findFirstChangedLine(oldContent: string, newContent: string): number | undefined {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
    if (oldLines[i] !== newLines[i]) {
      return i + 1; // 1-indexed
    }
  }

  // If all common lines match but lengths differ
  if (oldLines.length !== newLines.length) {
    return Math.min(oldLines.length, newLines.length) + 1;
  }

  return undefined;
}

/**
 * Create edit tool for MCP server
 */
export function createEditTool(cwd: string) {
  return {
    description:
      "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Fuzzy matching handles minor whitespace differences. Use this for precise, surgical edits.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to edit (relative or absolute)",
        },
        oldText: {
          type: "string",
          description: "Exact text to find and replace (must match exactly, including whitespace)",
        },
        newText: {
          type: "string",
          description: "Text to replace oldText with",
        },
      },
      required: ["path", "oldText", "newText"],
    }),
    execute: async (
      {
        path,
        oldText,
        newText,
      }: {
        path: string;
        oldText: string;
        newText: string;
      },
      extra?: any,
    ) => {
      try {
        const absolutePath = resolveToCwd(path, cwd);

        // Check if file is readable and writable
        try {
          await access(absolutePath, constants.R_OK | constants.W_OK);
        } catch {
          throw new Error(`Cannot read/write file: ${path}`);
        }

        // Read file
        const buffer = await readFile(absolutePath);
        const content = buffer.toString("utf-8");

        // Find text with fuzzy matching
        const match = findWithFuzzyMatch(content, oldText);

        if (!match) {
          throw new Error(
            `Could not find the specified text in ${path}. Make sure oldText matches exactly.`,
          );
        }

        // Check for multiple occurrences
        const remainingContent = content.substring(match.index + match.matchedText.length);
        const secondMatch = findWithFuzzyMatch(remainingContent, oldText);

        if (secondMatch) {
          throw new Error(
            `Text appears multiple times in ${path}. Please provide more context to make oldText unique.`,
          );
        }

        // Replace text
        const newContent =
          content.substring(0, match.index) +
          newText +
          content.substring(match.index + match.matchedText.length);

        // Check if aborted before writing
        if (extra?.signal?.aborted) {
          throw new Error("Operation aborted");
        }

        // Write file
        await writeFile(absolutePath, newContent, "utf-8");

        // Generate diff
        const diff = createUnifiedDiff(content, newContent, path);

        // Find first changed line
        const firstChangedLine = findFirstChangedLine(content, newContent);

        const details: EditToolDetails = {
          diff,
          firstChangedLine,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully replaced text in ${path}${firstChangedLine ? ` (first change at line ${firstChangedLine})` : ""}\n\nDiff:\n${diff}`,
            },
          ],
          details,
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
