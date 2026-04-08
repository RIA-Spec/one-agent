/**
 * Riff tool - persist reusable RAS workflows as:
 *   .agent/riff/<name>/riff.md  (documentation + metadata)
 *   .agent/riff/<name>/ras.py   (executable script)
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import matter from "gray-matter";
import { jsonSchema } from "ai";

const INLINE_EXEC_PREFIX = "__ONE_INLINE_EXEC__:";

type RiffFrontmatter = {
  description?: string;
  parameters?: Record<string, string>;
};

type RiffRecord = {
  name: string;
  dir: string;
  riffPath: string;
  scriptPath: string;
  description: string;
  parameters: Record<string, string>;
  docs: string;
  script: string;
};

function resolveToCwd(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function normalizeRiffName(name: string): string {
  const cleaned = name.trim().replace(/\.md$/i, "");
  if (!cleaned) {
    throw new Error("Riff name is required");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(cleaned)) {
    throw new Error("Riff name must match /^[a-zA-Z0-9._-]+$/");
  }
  return cleaned;
}

async function loadRiff(workflowsDir: string, fileName: string): Promise<RiffRecord> {
  const riffDir = join(workflowsDir, fileName);
  const riffPath = join(riffDir, "riff.md");
  const scriptPath = join(riffDir, "ras.py");

  const rawRiff = await readFile(riffPath, "utf-8");
  const parsed = matter(rawRiff);
  const script = await readFile(scriptPath, "utf-8");
  const data = (parsed.data ?? {}) as RiffFrontmatter;

  return {
    name: fileName,
    dir: riffDir,
    riffPath,
    scriptPath,
    description: typeof data.description === "string" ? data.description : "",
    parameters: data.parameters && typeof data.parameters === "object" ? data.parameters : {},
    docs: parsed.content.trim(),
    script: script.trim(),
  };
}

async function discoverRiffs(workflowsDir: string): Promise<RiffRecord[]> {
  if (!existsSync(workflowsDir)) {
    return [];
  }

  const entries = await readdir(workflowsDir, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const riffs: RiffRecord[] = [];

  for (const dirName of dirs) {
    const riffPath = join(workflowsDir, dirName, "riff.md");
    const scriptPath = join(workflowsDir, dirName, "ras.py");
    if (!existsSync(riffPath) || !existsSync(scriptPath)) {
      continue;
    }
    riffs.push(await loadRiff(workflowsDir, dirName));
  }

  return riffs;
}

function buildRiffDocs(description: string, parameters: Record<string, string>): string {
  const keys = Object.keys(parameters);
  const paramLines =
    keys.length === 0
      ? ["- none"]
      : keys.map((key) => `- ${key}: ${parameters[key] || "(no description)"}`);

  return [
    "# Riff",
    "",
    description,
    "",
    "## Parameters",
    ...paramLines,
    "",
    "## Execution",
    "This riff executes the script content in ras.py.",
    "",
  ].join("\n");
}

export function createRiffTool(cwd: string) {
  const rootDir = resolveToCwd(cwd, cwd);
  const workflowsDir = join(rootDir, ".agent", "riff");

  return {
    description:
      "Persist reusable riffs in .agent/riff/<name> using riff.md (docs) and ras.py (script). Action params: list(action); read(action,name,includeScript?); upsert(action,name,description,script|content,parameters?); run(action,name,parameters?).",
    parameters: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "upsert", "run"],
          description:
            "Operation to perform. list: discover riffs; read: inspect riff docs/script; upsert: create/update riff; run: execute riff script inline.",
        },
        name: {
          type: "string",
          description: "Riff name (folder name under .agent/riff)",
        },
        description: {
          type: "string",
          description: "Riff description saved in frontmatter",
        },
        parameters: {
          type: "object",
          description:
            "For upsert: schema object {key: description}. For run: concrete values; all declared keys are required.",
          additionalProperties: true,
        },
        script: {
          type: "string",
          description: "Python code saved to ras.py",
        },
        content: {
          type: "string",
          description: "Deprecated alias for script (accepted for compatibility)",
        },
        includeScript: {
          type: "boolean",
          description: "For read action: include ras.py content in response",
        },
      },
      required: ["action"],
    }),
    execute: async (
      {
        action,
        name,
        description,
        parameters,
        script,
        content,
        includeScript,
      }: {
        action: "list" | "read" | "upsert" | "run";
        name?: string;
        description?: string;
        parameters?: Record<string, unknown>;
        script?: string;
        content?: string;
        includeScript?: boolean;
      },
      _extra?: unknown,
    ) => {
      try {
        await mkdir(workflowsDir, { recursive: true });

        if (action === "list") {
          const riffs = await discoverRiffs(workflowsDir);
          const summary = riffs.map((riff) => ({
            name: riff.name,
            description: riff.description,
            parameters: riff.parameters,
            docsPath: riff.riffPath,
            scriptPath: riff.scriptPath,
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    folder: workflowsDir,
                    total: summary.length,
                    riffs: summary,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (!name) {
          throw new Error("name is required for this action");
        }

        const riffName = normalizeRiffName(name);
        const riffDir = join(workflowsDir, riffName);
        const riffPath = join(riffDir, "riff.md");
        const scriptPath = join(riffDir, "ras.py");

        if (action === "read") {
          const riff = await loadRiff(workflowsDir, riffName);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    action: "read",
                    name: riff.name,
                    path: riff.dir,
                    riffPath: riff.riffPath,
                    scriptPath: riff.scriptPath,
                    description: riff.description,
                    parameters: riff.parameters,
                    docs: riff.docs,
                    ...(includeScript ? { script: riff.script } : {}),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (action === "upsert") {
          const normalizedScript = script?.trim() || content?.trim() || "";

          if (!description?.trim()) {
            throw new Error("description is required for upsert");
          }
          if (!normalizedScript) {
            throw new Error("script is required for upsert");
          }

          const schemaMap: Record<string, string> = {};
          if (parameters && typeof parameters === "object") {
            for (const [key, value] of Object.entries(parameters)) {
              schemaMap[key] = String(value);
            }
          }

          const markdown = matter.stringify(buildRiffDocs(description.trim(), schemaMap), {
            description: description.trim(),
            parameters: schemaMap,
          });

          await mkdir(riffDir, { recursive: true });
          await writeFile(riffPath, markdown, "utf-8");
          await writeFile(scriptPath, normalizedScript + "\n", "utf-8");

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    action: "upsert",
                    name: riffName,
                    path: riffDir,
                    riffPath,
                    scriptPath,
                    folder: workflowsDir,
                    description: description.trim(),
                    parameters: schemaMap,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const riff = await loadRiff(workflowsDir, riffName);

        const runtimeParams = parameters && typeof parameters === "object" ? parameters : {};
        const requiredParamKeys = Object.keys(riff.parameters || {});
        const missingParams = requiredParamKeys.filter((key) => !(key in runtimeParams));

        if (missingParams.length > 0) {
          throw new Error(
            `Missing required parameters for riff \"${riffName}\": ${missingParams.join(", ")}`,
          );
        }

        const payload = JSON.stringify(runtimeParams ?? {});
        const wrappedScript = `import json\nRIFF_PARAMS = json.loads(${JSON.stringify(payload)})\n${riff.script}\n`;
        const encodedScript = Buffer.from(wrappedScript, "utf-8").toString("base64");

        return {
          content: [
            {
              type: "text" as const,
              text: `${INLINE_EXEC_PREFIX}${encodedScript}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: error?.message ?? String(error) }],
          isError: true,
        };
      }
    },
  };
}
