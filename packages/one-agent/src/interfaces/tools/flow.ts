/**
 * Flow tool - persistent reusable Python workflows stored in markdown files.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import matter from "gray-matter";
import { jsonSchema } from "ai";

type FlowFrontmatter = {
  description?: string;
  parameters?: Record<string, string>;
};

type FlowRecord = {
  name: string;
  path: string;
  description: string;
  parameters: Record<string, string>;
  script: string;
};

function resolveToCwd(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function normalizeFlowName(name: string): string {
  const cleaned = name.trim().replace(/\.md$/i, "");
  if (!cleaned) {
    throw new Error("Flow name is required");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(cleaned)) {
    throw new Error("Flow name must match /^[a-zA-Z0-9._-]+$/");
  }
  return cleaned;
}

function tokenize(text: string): Set<string> {
  const stopwords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "your",
    "user",
    "using",
    "about",
    "just",
    "then",
    "than",
    "flow",
    "tool",
  ]);

  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stopwords.has(token));

  return new Set(tokens);
}

function isDescriptionMatch(description: string, purpose: string): boolean {
  const desc = description.trim().toLowerCase();
  const intent = purpose.trim().toLowerCase();

  if (!desc || !intent) {
    return false;
  }

  if (desc.includes(intent) || intent.includes(desc)) {
    return true;
  }

  const descTokens = tokenize(desc);
  const intentTokens = tokenize(intent);

  if (descTokens.size === 0 || intentTokens.size === 0) {
    return false;
  }

  let overlap = 0;
  for (const token of intentTokens) {
    if (descTokens.has(token)) {
      overlap += 1;
    }
  }

  const score = overlap / Math.max(descTokens.size, intentTokens.size);
  return score >= 0.35;
}

async function loadFlow(workflowsDir: string, fileName: string): Promise<FlowRecord> {
  const absolutePath = join(workflowsDir, fileName);
  const raw = await readFile(absolutePath, "utf-8");
  const parsed = matter(raw);
  const data = (parsed.data ?? {}) as FlowFrontmatter;

  return {
    name: fileName.replace(/\.md$/i, ""),
    path: absolutePath,
    description: typeof data.description === "string" ? data.description : "",
    parameters: data.parameters && typeof data.parameters === "object" ? data.parameters : {},
    script: parsed.content.trim(),
  };
}

async function discoverFlows(workflowsDir: string): Promise<FlowRecord[]> {
  if (!existsSync(workflowsDir)) {
    return [];
  }

  const files = (await readdir(workflowsDir)).filter((entry) => entry.endsWith(".md")).sort();
  const flows: FlowRecord[] = [];

  for (const fileName of files) {
    flows.push(await loadFlow(workflowsDir, fileName));
  }

  return flows;
}

async function executePythonScript(
  script: string,
  cwd: string,
  parameters: Record<string, unknown>,
  timeoutSeconds: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const payload = JSON.stringify(parameters ?? {});
  const wrappedScript = `import json\nFLOW_PARAMS = json.loads(${JSON.stringify(payload)})\n${script}\n`;

  const runWithCommand = (command: string) =>
    new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
      const proc = spawn(command, ["-c", wrappedScript], {
        cwd,
        env: process.env,
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeoutHandle = setTimeout(
        () => {
          timedOut = true;
          proc.kill("SIGTERM");
          setTimeout(() => proc.kill("SIGKILL"), 4000);
        },
        Math.max(1, timeoutSeconds) * 1000,
      );

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });

      proc.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (timedOut) {
          reject(new Error(`Flow execution timed out after ${timeoutSeconds} seconds`));
          return;
        }
        resolve({ stdout, stderr, exitCode: code });
      });
    });

  const pythonCandidates = [process.env.PYTHON_BIN || "python3", "python"];
  let lastError: unknown;

  for (const command of pythonCandidates) {
    try {
      return await runWithCommand(command);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  const message =
    lastError instanceof Error
      ? lastError.message
      : "Python executable not found. Set PYTHON_BIN or install python3.";
  throw new Error(message);
}

export function createFlowTool(cwd: string) {
  const rootDir = resolveToCwd(cwd, cwd);
  const workflowsDir = join(rootDir, ".agent", "flow");

  return {
    description:
      "Manage reusable complex flows backed by markdown+python files in .agent/flow. Use list to discover, upsert to create/edit, and run to execute when purpose matches the flow description.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "upsert", "run"],
          description: "Operation to perform",
        },
        name: {
          type: "string",
          description: "Flow name (filename without .md)",
        },
        purpose: {
          type: "string",
          description: "User purpose; must match flow description for run",
        },
        description: {
          type: "string",
          description: "Flow description stored in frontmatter",
        },
        parameters: {
          type: "object",
          description:
            "For upsert: parameter schema object {key: description}. For run: actual parameter values.",
          additionalProperties: true,
        },
        script: {
          type: "string",
          description: "Python script body stored in markdown content",
        },
        timeoutSeconds: {
          type: "number",
          description: "Execution timeout in seconds for run (default 120)",
        },
      },
      required: ["action"],
    }),
    execute: async (
      {
        action,
        name,
        purpose,
        description,
        parameters,
        script,
        timeoutSeconds,
      }: {
        action: "list" | "upsert" | "run";
        name?: string;
        purpose?: string;
        description?: string;
        parameters?: Record<string, unknown>;
        script?: string;
        timeoutSeconds?: number;
      },
      _extra?: unknown,
    ) => {
      try {
        await mkdir(workflowsDir, { recursive: true });

        if (action === "list") {
          const flows = await discoverFlows(workflowsDir);
          const summary = flows.map((flow) => ({
            name: flow.name,
            description: flow.description,
            parameters: flow.parameters,
            matchesPurpose: purpose ? isDescriptionMatch(flow.description, purpose) : undefined,
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    folder: workflowsDir,
                    total: summary.length,
                    flows: summary,
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

        const flowName = normalizeFlowName(name);
        const flowPath = join(workflowsDir, `${flowName}.md`);

        if (action === "upsert") {
          if (!description?.trim()) {
            throw new Error("description is required for upsert");
          }
          if (!script?.trim()) {
            throw new Error("script is required for upsert");
          }

          const schemaMap: Record<string, string> = {};
          if (parameters && typeof parameters === "object") {
            for (const [key, value] of Object.entries(parameters)) {
              schemaMap[key] = String(value);
            }
          }

          const markdown = matter.stringify(script.trim() + "\n", {
            description: description.trim(),
            parameters: schemaMap,
          });

          await writeFile(flowPath, markdown, "utf-8");

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    action: "upsert",
                    name: flowName,
                    path: flowPath,
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

        const flow = await loadFlow(workflowsDir, `${flowName}.md`);

        if (!purpose?.trim()) {
          throw new Error("purpose is required for run");
        }

        if (!isDescriptionMatch(flow.description, purpose)) {
          throw new Error(
            `Flow description mismatch. Purpose does not match flow \"${flowName}\" description.`,
          );
        }

        const runtimeParams = parameters && typeof parameters === "object" ? parameters : {};
        const requiredParamKeys = Object.keys(flow.parameters || {});
        const missingParams = requiredParamKeys.filter((key) => !(key in runtimeParams));

        if (missingParams.length > 0) {
          throw new Error(
            `Missing required parameters for flow \"${flowName}\": ${missingParams.join(", ")}`,
          );
        }

        const result = await executePythonScript(
          flow.script,
          rootDir,
          runtimeParams,
          timeoutSeconds ?? 120,
        );

        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

        return {
          content: [
            {
              type: "text" as const,
              text:
                output ||
                JSON.stringify({ ok: true, flow: flowName, message: "(no output)" }, null, 2),
            },
          ],
          ...(result.exitCode !== 0 && { isError: true }),
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
