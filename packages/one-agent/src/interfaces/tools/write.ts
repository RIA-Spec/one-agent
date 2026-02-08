/**
 * Write tool - Safe file writing with directory creation
 *
 * Based on the implementation from:
 * https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/src/core/tools/write.ts
 *
 * Credits to @badlogic for the original design and implementation patterns.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import { jsonSchema } from "ai";

/**
 * Resolve path to working directory
 */
function resolveToCwd(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * Create write tool for MCP server
 */
export function createWriteTool(cwd: string) {
  return {
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to write (relative or absolute)",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    }),
    execute: async (
      {
        path,
        content,
      }: {
        path: string;
        content: string;
      },
      extra?: any,
    ) => {
      return new Promise((resolve, reject) => {
        // Check if already aborted
        if (extra?.signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        let aborted = false;

        // Set up abort handler
        const onAbort = () => {
          aborted = true;
          reject(new Error("Operation aborted"));
        };

        if (extra?.signal) {
          extra.signal.addEventListener("abort", onAbort, { once: true });
        }

        (async () => {
          try {
            const absolutePath = resolveToCwd(path, cwd);
            const dir = dirname(absolutePath);

            // Create parent directories
            await mkdir(dir, { recursive: true });

            // Check if aborted before writing
            if (aborted) {
              return;
            }

            // Write file
            await writeFile(absolutePath, content, "utf-8");

            // Check if aborted after writing
            if (aborted) {
              return;
            }

            resolve({
              content: [
                {
                  type: "text" as const,
                  text: `Successfully wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${path}`,
                },
              ],
            });
          } catch (error: any) {
            reject(
              new Error(error.code === "EACCES" ? `Permission denied: ${path}` : error.message),
            );
          } finally {
            if (extra?.signal) {
              extra.signal.removeEventListener("abort", onAbort);
            }
          }
        })();
      }).catch((error: Error) => {
        return {
          content: [{ type: "text" as const, text: error.message }],
          isError: true,
        };
      });
    },
  };
}
