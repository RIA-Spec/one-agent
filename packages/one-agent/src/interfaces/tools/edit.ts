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
 * Build a map from normalized-string index → original-string index.
 * normalizeWhitespace only trims trailing whitespace per line and the
 * whole-string edges, so in-line spaces/tabs are preserved 1-to-1.
 * We walk both strings in lockstep; the only characters that appear in
 * `content` but not in `normalized` are:
 *   - trailing spaces/tabs before a '\n' (trimEnd)
 *   - the leading whitespace stripped by the outer .trim()
 */
function buildNormToOrigMap(content: string, normalized: string): Int32Array {
  // map[normIdx] = origIdx for every character in normalized
  const map = new Int32Array(normalized.length + 1);
  let o = 0; // cursor in content
  let n = 0; // cursor in normalized

  // Skip leading characters removed by .trim()
  while (o < content.length && n < normalized.length && content[o] !== normalized[n]) {
    o++;
  }

  while (n < normalized.length && o < content.length) {
    map[n] = o;
    const nc = normalized[n]!;
    const oc = content[o]!;
    if (nc === oc) {
      n++;
      o++;
    } else {
      // content has an extra char not in normalized (trailing whitespace before \n)
      o++;
    }
  }
  map[n] = o; // one-past-end sentinel
  return map;
}

/**
 * Find text in content with fuzzy whitespace matching.
 *
 * The previous implementation tried to re-derive the original position by
 * walking content and skipping ALL spaces/tabs, which drifted whenever a
 * line had in-line whitespace. We now build a precise index map instead.
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

  // Map normalized positions back to original positions via the index map
  const map = buildNormToOrigMap(content, normalizedContent);
  const origStart = map[fuzzyIndex]!;
  const origEnd = map[fuzzyIndex + normalizedSearch.length]!;

  return {
    index: origStart,
    matchedText: content.substring(origStart, origEnd),
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
      "Edit a file by replacing exact text. You MUST use the Read tool at least once before editing. " +
      "The Read tool outputs lines in 'lineNum\\tcontent' format — do NOT include the line-number prefix in oldText or newText; use only the actual file content after the tab. " +
      "oldText must uniquely identify the target (include 2-4 surrounding lines if needed). " +
      "Fuzzy matching handles minor trailing-whitespace differences.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to edit (relative or absolute)",
        },
        oldText: {
          type: "string",
          description:
            "Exact text to find and replace. Copy from Read output but strip the leading 'lineNum\\t' prefix from every line. Must be unique in the file.",
        },
        newText: {
          type: "string",
          description: "Text to replace oldText with (no line-number prefixes).",
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
