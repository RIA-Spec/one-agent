/**
 * Riff tool - persist reusable RAS workflows as standard agent skills:
 *   .agents/riffs/<name>/SKILL.md        (agentskills.io-style docs + frontmatter)
 *   .agents/riffs/<name>/scripts/ras.py  (executable Python script)
 *   .agents/riffs/<name>/scripts/ras.sh  (executable bash script)
 *
 * A riff may ship both scripts; `riff run` picks the script matching the
 * caller's RAS mode (python -> ras.py, bash -> ras.sh), falling back to the
 * script declared in frontmatter metadata (metadata.script), then ras.py.
 * Riffs are marked in frontmatter metadata (metadata.riff), so a riff can also
 * live under .agents/skills/ and remain discoverable/runnable by one-agent.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import matter from "gray-matter";
import { jsonSchema } from "ai";

const INLINE_EXEC_PREFIX = "__ONE_INLINE_EXEC__:";
const RIFF_METADATA_KEY = "riff";
const PARAMS_METADATA_KEY = "parameters";

const RIFFS_DIR = ".agents/riffs"; // canonical riff storage (read-write)
const SKILLS_DIR = ".agents/skills"; // standard agentskills.io skills (read-only)

type RiffFrontmatter = {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  metadata?: Record<string, unknown>;
};

type RiffSource = "riffs" | "skills";
type RiffMode = "python" | "bash";

type RiffRecord = {
  name: string;
  dir: string;
  docsPath: string;
  scriptPath: string | null;
  description: string;
  parameters: Record<string, string>;
  docs: string;
  script: string | null;
  isRiff: boolean;
  source: RiffSource;
};

function resolveToCwd(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function normalizeRiffName(name: string): string {
  const cleaned = name.trim().replace(/\.md$/i, "").toLowerCase();
  if (!cleaned) {
    throw new Error("Riff name is required");
  }
  if (cleaned.length > 64) {
    throw new Error("Riff name must be at most 64 characters");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleaned)) {
    throw new Error(
      "Riff name must match agentskills.io naming: lowercase letters, numbers, and hyphens (no leading/trailing/consecutive hyphens)",
    );
  }
  return cleaned;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseParameters(value: unknown): Record<string, string> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Object.fromEntries(
        Object.entries(asRecord(parsed)).map(([key, val]) => [key, String(val)]),
      );
    } catch {
      return {};
    }
  }
  return Object.fromEntries(
    Object.entries(asRecord(value)).map(([key, val]) => [key, String(val)]),
  );
}

function isRiffMarked(data: RiffFrontmatter): boolean {
  const marker = asRecord(data.metadata)[RIFF_METADATA_KEY];
  if (marker === undefined || marker === null) {
    return false;
  }
  if (typeof marker === "string") {
    return marker !== "" && marker.toLowerCase() !== "false";
  }
  return marker !== false;
}

async function readTextSafe(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf-8")).trim();
  } catch {
    return null;
  }
}

async function loadEntry(
  dir: string,
  fileName: string,
  source: RiffSource,
  mode: RiffMode | undefined,
): Promise<RiffRecord | null> {
  const entryDir = join(dir, fileName);

  const docsPath = join(entryDir, "SKILL.md");
  const raw = await readTextSafe(docsPath);
  if (raw === null) {
    return null;
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch {
    return null;
  }
  const data = (parsed.data ?? {}) as RiffFrontmatter;

  let scriptPath: string | null = null;
  let script: string | null = null;
  const declaredScript = asString(asRecord(data.metadata)["script"]);
  const safeDeclaredScript = /^(ras\.py|ras\.sh)$/.test(declaredScript) ? declaredScript : null;
  const scriptOrder = Array.from(
    new Set(
      [
        mode === "bash" ? "ras.sh" : mode === "python" ? "ras.py" : null,
        safeDeclaredScript,
        "ras.py",
        "ras.sh",
      ].filter((name): name is string => name !== null),
    ),
  );
  for (const scriptName of scriptOrder) {
    for (const candidate of [join(entryDir, "scripts", scriptName), join(entryDir, scriptName)]) {
      const content = await readTextSafe(candidate);
      if (content !== null) {
        script = content;
        scriptPath = candidate;
        break;
      }
    }
    if (scriptPath !== null) {
      break;
    }
  }

  const parameters = parseParameters(
    data.parameters ?? asRecord(data.metadata)[PARAMS_METADATA_KEY],
  );

  return {
    name: fileName,
    dir: entryDir,
    docsPath,
    scriptPath,
    description: asString(data.description),
    parameters,
    docs: parsed.content.trim(),
    script,
    isRiff: source !== "skills" || (isRiffMarked(data) && script !== null),
    source,
  };
}

async function discoverDir(
  dir: string,
  source: RiffSource,
  mode: RiffMode | undefined,
): Promise<RiffRecord[]> {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const records: RiffRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const record = await loadEntry(dir, entry.name, source, mode);
    if (record) {
      records.push(record);
    }
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

async function discoverAll(
  riffsDir: string,
  skillsDir: string,
  mode: RiffMode | undefined,
): Promise<RiffRecord[]> {
  const records = [
    ...(await discoverDir(riffsDir, "riffs", mode)),
    ...(await discoverDir(skillsDir, "skills", mode)),
  ];
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.name)) {
      return false;
    }
    seen.add(record.name);
    return true;
  });
}

async function findRiff(
  name: string,
  riffsDir: string,
  skillsDir: string,
  mode: RiffMode | undefined,
): Promise<RiffRecord | null> {
  const normalized = name.toLowerCase();
  for (const [dir, source] of [
    [riffsDir, "riffs"],
    [skillsDir, "skills"],
  ] as const) {
    if (!existsSync(dir)) {
      continue;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const match = entries.find(
      (entry) => entry.isDirectory() && entry.name.toLowerCase() === normalized,
    );
    if (!match) {
      continue;
    }
    const record = await loadEntry(dir, match.name, source, mode);
    if (record) {
      return record;
    }
  }
  return null;
}

function buildRiffDocs(
  name: string,
  description: string,
  parameters: Record<string, string>,
  scriptName: string,
): string {
  const keys = Object.keys(parameters);
  const paramLines =
    keys.length === 0
      ? ["- none"]
      : keys.map((key) => `- ${key}: ${parameters[key] || "(no description)"}`);

  return [
    `# ${name}`,
    "",
    description,
    "",
    "## Parameters",
    ...paramLines,
    "",
    "## Execution",
    `Executed by one-agent via \`riff run ${name}\`. The script is scripts/${scriptName}; parameters are injected as \`RIFF_PARAMS\` (${
      scriptName.endsWith(".sh") ? "shell environment variable" : "Python global"
    }).`,
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createRiffTool(cwd: string, mode?: RiffMode) {
  const rootDir = resolveToCwd(cwd, cwd);
  const riffsDir = join(rootDir, RIFFS_DIR);
  const skillsDir = join(rootDir, SKILLS_DIR);

  return {
    description:
      "Persist reusable riffs in .agents/riffs/<name> as standard agent skills (SKILL.md + scripts/ras.py|ras.sh), and list/read standard skills from .agents/skills/. Action params: list(action); read(action,name,includeScript?); upsert(action,name,description,script|content,scriptName?,parameters?); run(action,name,parameters?). run returns an inline exec payload for Python riffs, or a bash command to execute with the bash tool for .sh riffs.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "upsert", "run"],
          description:
            "Operation to perform. list: discover riffs and skills; read: inspect docs/script; upsert: create/update riff; run: execute riff script inline.",
        },
        name: {
          type: "string",
          description:
            "Riff/skill name (lowercase letters, numbers, hyphens; folder name under .agents/riffs or .agents/skills)",
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
          description: "Python or bash code saved to scripts/ras.py (or scripts/ras.sh)",
        },
        scriptName: {
          type: "string",
          description: 'Script filename for upsert: "ras.py" (default) or "ras.sh"',
        },
        content: {
          type: "string",
          description: "Deprecated alias for script (accepted for compatibility)",
        },
        includeScript: {
          type: "boolean",
          description: "For read action: include script content in response",
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
        scriptName,
        includeScript,
      }: {
        action: "list" | "read" | "upsert" | "run";
        name?: string;
        description?: string;
        parameters?: Record<string, unknown>;
        script?: string;
        content?: string;
        scriptName?: string;
        includeScript?: boolean;
      },
      _extra?: unknown,
    ) => {
      try {
        if (action === "list") {
          const records = await discoverAll(riffsDir, skillsDir, mode);
          const items = records.map((record) => ({
            name: record.name,
            description: record.description,
            parameters: record.parameters,
            docsPath: record.docsPath,
            scriptPath: record.scriptPath,
            isRiff: record.isRiff,
            source: record.source,
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    riffsFolder: riffsDir,
                    skillsFolder: skillsDir,
                    total: items.length,
                    riffs: items,
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
        const riffDir = join(riffsDir, riffName);
        const docsPath = join(riffDir, "SKILL.md");

        if (action === "read") {
          const record = await findRiff(riffName, riffsDir, skillsDir, mode);
          if (!record) {
            throw new Error(`Riff not found: ${riffName}`);
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    action: "read",
                    name: record.name,
                    path: record.dir,
                    docsPath: record.docsPath,
                    scriptPath: record.scriptPath,
                    description: record.description,
                    parameters: record.parameters,
                    isRiff: record.isRiff,
                    source: record.source,
                    docs: record.docs,
                    ...(includeScript && record.script !== null ? { script: record.script } : {}),
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
          const resolvedScriptName = scriptName?.trim() || "ras.py";

          if (!description?.trim()) {
            throw new Error("description is required for upsert");
          }
          if (description.trim().length > 1024) {
            throw new Error("description must be at most 1024 characters");
          }
          if (!normalizedScript) {
            throw new Error("script is required for upsert");
          }
          if (!/^ras\.(py|sh)$/.test(resolvedScriptName)) {
            throw new Error('scriptName must be "ras.py" or "ras.sh"');
          }

          const schemaMap: Record<string, string> = {};
          if (parameters && typeof parameters === "object") {
            for (const [key, value] of Object.entries(parameters)) {
              schemaMap[key] = String(value);
            }
          }

          const markdown = matter.stringify(
            buildRiffDocs(riffName, description.trim(), schemaMap, resolvedScriptName),
            {
              name: riffName,
              description: description.trim(),
              metadata: {
                [RIFF_METADATA_KEY]: "true",
                script: resolvedScriptName,
                [PARAMS_METADATA_KEY]: JSON.stringify(schemaMap),
              },
            },
          );

          const scriptPath = join(riffDir, "scripts", resolvedScriptName);
          await mkdir(riffsDir, { recursive: true });
          await mkdir(join(riffDir, "scripts"), { recursive: true });
          await writeFile(docsPath, markdown, "utf-8");
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
                    docsPath,
                    scriptPath,
                    folder: riffsDir,
                    format: "agentskills.io",
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

        const record = await findRiff(riffName, riffsDir, skillsDir, mode);
        if (!record) {
          throw new Error(`Riff not found: ${riffName}`);
        }
        if (!record.isRiff) {
          throw new Error(
            `"${riffName}" is a plain skill in .agents/skills/, not a riff; it cannot be executed`,
          );
        }
        if (record.script === null) {
          throw new Error(
            `Riff "${riffName}" has no executable script (scripts/ras.py or scripts/ras.sh)`,
          );
        }

        const runtimeParams = parameters && typeof parameters === "object" ? parameters : {};
        const requiredParamKeys = Object.keys(record.parameters || {});
        const missingParams = requiredParamKeys.filter((key) => runtimeParams[key] === undefined);

        if (missingParams.length > 0) {
          throw new Error(
            `Missing required parameters for riff \"${riffName}\": ${missingParams.join(", ")}`,
          );
        }

        const payload = JSON.stringify(runtimeParams ?? {});

        if (record.scriptPath?.endsWith(".sh")) {
          const command = `RIFF_PARAMS=${shellQuote(payload)} bash ${shellQuote(record.scriptPath)}`;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    action: "run",
                    kind: "bash",
                    command,
                    scriptPath: record.scriptPath,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const wrappedScript = `import json\nRIFF_PARAMS = json.loads(${JSON.stringify(payload)})\n${record.script}\n`;
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
