import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { createRiffTool } from "../src/interfaces/tools/riff.js";

const INLINE_EXEC_PREFIX = "__ONE_INLINE_EXEC__:";

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

function getText(result: unknown): string {
  const typed = result as ToolResult;
  return typed.content?.[0]?.text ?? "";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

describe("riff tool", () => {
  it("upserts into .agents/riffs as a standard skill and lists riffs", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-riff-"));

    try {
      const riffTool = createRiffTool(root);

      const upsertResult = (await riffTool.execute({
        action: "upsert",
        name: "sum-numbers",
        description: "Aggregate values for analytics reports",
        parameters: {
          numbers: "Array of numbers to aggregate",
        },
        script: 'print(sum(RIFF_PARAMS["numbers"]))',
      })) as ToolResult;

      expect(upsertResult.isError).not.toBe(true);

      const skillFile = join(root, ".agents", "riffs", "sum-numbers", "SKILL.md");
      const scriptFile = join(root, ".agents", "riffs", "sum-numbers", "scripts", "ras.py");
      const markdown = await readFile(skillFile, "utf-8");
      const script = await readFile(scriptFile, "utf-8");

      const parsed = matter(markdown);
      expect(parsed.data.name).toBe("sum-numbers");
      expect(parsed.data.description).toBe("Aggregate values for analytics reports");
      expect(parsed.data.metadata).toEqual({
        riff: "true",
        script: "ras.py",
        parameters: JSON.stringify({ numbers: "Array of numbers to aggregate" }),
      });
      expect(parsed.content).toContain("## Parameters");
      expect(script).toContain('print(sum(RIFF_PARAMS["numbers"]))');

      const listResult = (await riffTool.execute({ action: "list" })) as ToolResult;
      expect(listResult.isError).not.toBe(true);

      const listText = getText(listResult);
      expect(listText).toContain("sum-numbers");
      expect(listText).toContain('"riffsFolder":');
      expect(listText).toContain('"docsPath":');
      expect(listText).toContain('"scriptPath":');
      expect(listText).toContain('"isRiff": true');
      expect(listText).toContain('"source": "riffs"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("run returns inline execution payload with wrapped script", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-riff-"));

    try {
      const riffTool = createRiffTool(root);

      await riffTool.execute({
        action: "upsert",
        name: "send-report",
        description: "Generate weekly report",
        parameters: {
          week: "Week number",
        },
        script: 'print("week:", RIFF_PARAMS["week"])',
      });

      const runResult = (await riffTool.execute({
        action: "run",
        name: "send-report",
        parameters: {
          week: 12,
        },
      })) as ToolResult;

      expect(runResult.isError).not.toBe(true);
      const text = getText(runResult);
      expect(text.startsWith(INLINE_EXEC_PREFIX)).toBe(true);

      const encoded = text.slice(INLINE_EXEC_PREFIX.length);
      const wrappedScript = Buffer.from(encoded, "base64").toString("utf-8");

      expect(wrappedScript).toContain("import json");
      expect(wrappedScript).toContain("RIFF_PARAMS = json.loads(");
      expect(wrappedScript).toContain('print("week:", RIFF_PARAMS["week"])');

      const payloadMatch = wrappedScript.match(/RIFF_PARAMS = json\.loads\((.+)\)/);
      expect(payloadMatch).not.toBeNull();
      const serializedJsonLiteral = payloadMatch![1];
      const parsedParams = JSON.parse(JSON.parse(serializedJsonLiteral));
      expect(parsedParams).toEqual({ week: 12 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("run returns error when required params are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-riff-"));

    try {
      const riffTool = createRiffTool(root);

      await riffTool.execute({
        action: "upsert",
        name: "deploy-release",
        description: "Deploy release candidates to production with gated checks",
        parameters: {
          version: "Release version",
        },
        script: 'print(RIFF_PARAMS["version"])',
      });

      const runResult = (await riffTool.execute({
        action: "run",
        name: "deploy-release",
        parameters: {},
      })) as ToolResult;

      expect(runResult.isError).toBe(true);
      expect(getText(runResult)).toContain("Missing required parameters for riff");
      expect(getText(runResult)).toContain("version");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("upsert accepts deprecated content alias for script", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-riff-"));

    try {
      const riffTool = createRiffTool(root);

      const upsertResult = (await riffTool.execute({
        action: "upsert",
        name: "content-alias-case",
        description: "Create riff via content alias",
        content: 'print("ok")',
      })) as ToolResult;

      expect(upsertResult.isError).not.toBe(true);

      const scriptFile = join(root, ".agents", "riffs", "content-alias-case", "scripts", "ras.py");
      const script = await readFile(scriptFile, "utf-8");
      expect(script).toContain('print("ok")');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects names that violate agentskills.io naming", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-riff-"));

    try {
      const riffTool = createRiffTool(root);

      for (const badName of ["..", "Foo.Bar_baz", "-leading", "trailing-", "double--hyphen"]) {
        const result = (await riffTool.execute({
          action: "upsert",
          name: badName,
          description: "Should be rejected",
          script: 'print("nope")',
        })) as ToolResult;

        expect(result.isError).toBe(true);
        expect(getText(result)).toContain("agentskills.io naming");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("upserts and runs a bash riff (ras.sh)", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-riff-"));

    try {
      const riffTool = createRiffTool(root);

      const upsertResult = (await riffTool.execute({
        action: "upsert",
        name: "backup-db",
        description: "Back up the database to object storage",
        scriptName: "ras.sh",
        parameters: {
          env: "Environment to back up",
        },
        script: 'echo "env: $RIFF_PARAMS"',
      })) as ToolResult;

      expect(upsertResult.isError).not.toBe(true);

      const scriptFile = join(root, ".agents", "riffs", "backup-db", "scripts", "ras.sh");
      const script = await readFile(scriptFile, "utf-8");
      expect(script).toContain('echo "env: $RIFF_PARAMS"');

      const listResult = (await riffTool.execute({ action: "list" })) as ToolResult;
      expect(getText(listResult)).toContain("backup-db");
      expect(getText(listResult)).toContain("ras.sh");

      const runResult = (await riffTool.execute({
        action: "run",
        name: "backup-db",
        parameters: { env: "prod" },
      })) as ToolResult;

      expect(runResult.isError).not.toBe(true);
      const text = getText(runResult);
      expect(text.startsWith(INLINE_EXEC_PREFIX)).toBe(false);

      const parsed = JSON.parse(text);
      expect(parsed.kind).toBe("bash");
      expect(parsed.command).toContain("RIFF_PARAMS=");
      expect(parsed.command).toContain('{"env":"prod"}');
      expect(parsed.command).toContain("scripts/ras.sh");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid scriptName", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-riff-"));

    try {
      const riffTool = createRiffTool(root);

      const result = (await riffTool.execute({
        action: "upsert",
        name: "bad-script",
        description: "Should be rejected",
        scriptName: "main.py",
        script: 'print("nope")',
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('scriptName must be "ras.py" or "ras.sh"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-upserting with a different script type records the active script", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-riff-"));

    try {
      const toolNoMode = createRiffTool(root);

      await toolNoMode.execute({
        action: "upsert",
        name: "switch-type",
        description: "Switch from python to bash",
        scriptName: "ras.py",
        script: 'print("python")',
      });

      const upsertResult = (await toolNoMode.execute({
        action: "upsert",
        name: "switch-type",
        description: "Switch from python to bash",
        scriptName: "ras.sh",
        script: 'echo "bash"',
      })) as ToolResult;
      expect(upsertResult.isError).not.toBe(true);

      const pyScript = join(root, ".agents", "riffs", "switch-type", "scripts", "ras.py");
      const activeSh = join(root, ".agents", "riffs", "switch-type", "scripts", "ras.sh");
      const markdown = await readFile(
        join(root, ".agents", "riffs", "switch-type", "SKILL.md"),
        "utf-8",
      );
      expect(matter(markdown).data.metadata.script).toBe("ras.sh");

      // both scripts coexist; the declared script wins without a mode hint
      expect(await pathExists(pyScript)).toBe(true);
      expect(await pathExists(activeSh)).toBe(true);

      const runResult = (await toolNoMode.execute({
        action: "run",
        name: "switch-type",
        parameters: {},
      })) as ToolResult;
      expect(runResult.isError).not.toBe(true);
      const text = getText(runResult);
      expect(text.startsWith(INLINE_EXEC_PREFIX)).toBe(false);
      expect(JSON.parse(text).kind).toBe("bash");

      // with a mode hint, the matching script is preferred
      const pythonTool = createRiffTool(root, "python");
      const pythonRun = (await pythonTool.execute({
        action: "run",
        name: "switch-type",
        parameters: {},
      })) as ToolResult;
      expect(pythonRun.isError).not.toBe(true);
      expect(getText(pythonRun).startsWith(INLINE_EXEC_PREFIX)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("riff with both scripts picks by mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-riff-"));

    try {
      const tool = createRiffTool(root, "bash");

      await tool.execute({
        action: "upsert",
        name: "multi",
        description: "Ships both python and bash scripts",
        scriptName: "ras.py",
        script: 'print("python")',
      });

      // add the sibling bash script manually (both flavors coexist)
      await writeFile(
        join(root, ".agents", "riffs", "multi", "scripts", "ras.sh"),
        'echo "bash: $RIFF_PARAMS"\n',
        "utf-8",
      );

      const bashRun = (await tool.execute({
        action: "run",
        name: "multi",
        parameters: {},
      })) as ToolResult;
      expect(bashRun.isError).not.toBe(true);
      const bashText = getText(bashRun);
      expect(bashText.startsWith(INLINE_EXEC_PREFIX)).toBe(false);
      expect(JSON.parse(bashText).kind).toBe("bash");
      expect(JSON.parse(bashText).command).toContain("ras.sh");

      const pythonTool = createRiffTool(root, "python");
      const pythonRun = (await pythonTool.execute({
        action: "run",
        name: "multi",
        parameters: {},
      })) as ToolResult;
      expect(pythonRun.isError).not.toBe(true);
      expect(getText(pythonRun).startsWith(INLINE_EXEC_PREFIX)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists .agents/skills plain skills as non-riff and refuses to run them", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-riff-"));

    try {
      const skillDir = join(root, ".agents", "skills", "pdf-processing");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        matter.stringify("Extract text and fill forms from PDF files.", {
          name: "pdf-processing",
          description: "Extract text, fill forms, merge PDFs. Use when handling PDF files.",
        }),
        "utf-8",
      );

      const riffTool = createRiffTool(root);

      const listResult = (await riffTool.execute({ action: "list" })) as ToolResult;
      expect(listResult.isError).not.toBe(true);
      const listText = getText(listResult);
      expect(listText).toContain("pdf-processing");
      expect(listText).toContain('"isRiff": false');
      expect(listText).toContain('"source": "skills"');

      const runResult = (await riffTool.execute({
        action: "run",
        name: "pdf-processing",
        parameters: {},
      })) as ToolResult;

      expect(runResult.isError).toBe(true);
      expect(getText(runResult)).toContain("not a riff");

      const readResult = (await riffTool.execute({
        action: "read",
        name: "pdf-processing",
      })) as ToolResult;
      expect(readResult.isError).not.toBe(true);
      expect(getText(readResult)).toContain("Extract text and fill forms from PDF files.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs riff-marked skills from .agents/skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-riff-"));

    try {
      const skillDir = join(root, ".agents", "skills", "weekly-report");
      await mkdir(join(skillDir, "scripts"), { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        matter.stringify("Generate a weekly report.", {
          name: "weekly-report",
          description: "Generate weekly report. Use for recurring weekly reporting.",
          metadata: { riff: "true" },
        }),
        "utf-8",
      );
      await writeFile(
        join(skillDir, "scripts", "ras.py"),
        'print("week:", RIFF_PARAMS["week"])',
        "utf-8",
      );

      const riffTool = createRiffTool(root);

      const listResult = (await riffTool.execute({ action: "list" })) as ToolResult;
      expect(listResult.isError).not.toBe(true);
      const listText = getText(listResult);
      expect(listText).toContain("weekly-report");
      expect(listText).toContain('"isRiff": true');
      expect(listText).toContain('"source": "skills"');

      const runResult = (await riffTool.execute({
        action: "run",
        name: "weekly-report",
        parameters: { week: 12 },
      })) as ToolResult;

      expect(runResult.isError).not.toBe(true);
      const text = getText(runResult);
      expect(text.startsWith(INLINE_EXEC_PREFIX)).toBe(true);
      const wrappedScript = Buffer.from(text.slice(INLINE_EXEC_PREFIX.length), "base64").toString(
        "utf-8",
      );
      expect(wrappedScript).toContain('print("week:", RIFF_PARAMS["week"])');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
