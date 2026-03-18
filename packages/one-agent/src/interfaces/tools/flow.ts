/**
 * Flow tool - persist reusable AER workflows as:
 *   .agent/flow/<name>/flow.md  (documentation + metadata)
 *   .agent/flow/<name>/aer.py   (executable script)
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import matter from "gray-matter";
import { jsonSchema } from "ai";

const INLINE_EXEC_PREFIX = "__ONE_INLINE_EXEC__:";

type FlowFrontmatter = {
  description?: string;
  parameters?: Record<string, string>;
};

type FlowRecord = {
  name: string;
  dir: string;
  flowPath: string;
  scriptPath: string;
  description: string;
  parameters: Record<string, string>;
  docs: string;
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

async function loadFlow(workflowsDir: string, fileName: string): Promise<FlowRecord> {
  const flowDir = join(workflowsDir, fileName);
  const flowPath = join(flowDir, "flow.md");
  const scriptPath = join(flowDir, "aer.py");

  const rawFlow = await readFile(flowPath, "utf-8");
  const parsed = matter(rawFlow);
  const script = await readFile(scriptPath, "utf-8");
  const data = (parsed.data ?? {}) as FlowFrontmatter;

  return {
    name: fileName,
    dir: flowDir,
    flowPath,
    scriptPath,
    description: typeof data.description === "string" ? data.description : "",
    parameters: data.parameters && typeof data.parameters === "object" ? data.parameters : {},
    docs: parsed.content.trim(),
    script: script.trim(),
  };
}

async function discoverFlows(workflowsDir: string): Promise<FlowRecord[]> {
  if (!existsSync(workflowsDir)) {
    return [];
  }

  const entries = await readdir(workflowsDir, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const flows: FlowRecord[] = [];

  for (const dirName of dirs) {
    const flowPath = join(workflowsDir, dirName, "flow.md");
    const scriptPath = join(workflowsDir, dirName, "aer.py");
    if (!existsSync(flowPath) || !existsSync(scriptPath)) {
      continue;
    }
    flows.push(await loadFlow(workflowsDir, dirName));
  }

  return flows;
}

function buildFlowDocs(description: string, parameters: Record<string, string>): string {
  const keys = Object.keys(parameters);
  const paramLines =
    keys.length === 0
      ? ["- none"]
      : keys.map((key) => `- ${key}: ${parameters[key] || "(no description)"}`);

  return [
    "# Flow",
    "",
    description,
    "",
    "## Parameters",
    ...paramLines,
    "",
    "## Execution",
    "This flow executes the script content in aer.py.",
    "",
  ].join("\n");
}

export function createFlowTool(cwd: string) {
  const rootDir = resolveToCwd(cwd, cwd);
  const workflowsDir = join(rootDir, ".agent", "flow");

  return {
    description:
      "Persist reusable flows in .agent/flow/<name> using flow.md (docs) and aer.py (script). Action params: list(action); read(action,name,includeScript?); upsert(action,name,description,script|content,parameters?); run(action,name,parameters?).",
    parameters: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "upsert", "run"],
          description:
            "Operation to perform. list: discover flows; read: inspect flow docs/script; upsert: create/update flow; run: execute flow script inline.",
        },
        name: {
          type: "string",
          description: "Flow name (folder name under .agent/flow)",
        },
        description: {
          type: "string",
          description: "Flow description saved in frontmatter",
        },
        parameters: {
          type: "object",
          description:
            "For upsert: schema object {key: description}. For run: concrete values; all declared keys are required.",
          additionalProperties: true,
        },
        script: {
          type: "string",
          description: "Python code saved to aer.py",
        },
        content: {
          type: "string",
          description: "Deprecated alias for script (accepted for compatibility)",
        },
        includeScript: {
          type: "boolean",
          description: "For read action: include aer.py content in response",
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
          const flows = await discoverFlows(workflowsDir);
          const summary = flows.map((flow) => ({
            name: flow.name,
            description: flow.description,
            parameters: flow.parameters,
            docsPath: flow.flowPath,
            scriptPath: flow.scriptPath,
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
        const flowDir = join(workflowsDir, flowName);
        const flowPath = join(flowDir, "flow.md");
        const scriptPath = join(flowDir, "aer.py");

        if (action === "read") {
          const flow = await loadFlow(workflowsDir, flowName);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    action: "read",
                    name: flow.name,
                    path: flow.dir,
                    flowPath: flow.flowPath,
                    scriptPath: flow.scriptPath,
                    description: flow.description,
                    parameters: flow.parameters,
                    docs: flow.docs,
                    ...(includeScript ? { script: flow.script } : {}),
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

          const markdown = matter.stringify(buildFlowDocs(description.trim(), schemaMap), {
            description: description.trim(),
            parameters: schemaMap,
          });

          await mkdir(flowDir, { recursive: true });
          await writeFile(flowPath, markdown, "utf-8");
          await writeFile(scriptPath, normalizedScript + "\n", "utf-8");

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    action: "upsert",
                    name: flowName,
                    path: flowDir,
                    flowPath,
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

        const flow = await loadFlow(workflowsDir, flowName);

        const runtimeParams = parameters && typeof parameters === "object" ? parameters : {};
        const requiredParamKeys = Object.keys(flow.parameters || {});
        const missingParams = requiredParamKeys.filter((key) => !(key in runtimeParams));

        if (missingParams.length > 0) {
          throw new Error(
            `Missing required parameters for flow \"${flowName}\": ${missingParams.join(", ")}`,
          );
        }

        const payload = JSON.stringify(runtimeParams ?? {});
        const wrappedScript = `import json\nFLOW_PARAMS = json.loads(${JSON.stringify(payload)})\n${flow.script}\n`;
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
