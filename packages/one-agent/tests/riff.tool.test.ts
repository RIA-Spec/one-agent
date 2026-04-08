import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("riff tool", () => {
  it("upserts into .agent/riff and lists riffs", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-riff-"));

    try {
      const riffTool = createRiffTool(root);

      const upsertResult = (await riffTool.execute({
        action: "upsert",
        name: "sum_numbers",
        description: "Aggregate values for analytics reports",
        parameters: {
          numbers: "Array of numbers to aggregate",
        },
        script: 'print(sum(RIFF_PARAMS["numbers"]))',
      })) as ToolResult;

      expect(upsertResult.isError).not.toBe(true);

      const riffFile = join(root, ".agent", "riff", "sum_numbers", "riff.md");
      const scriptFile = join(root, ".agent", "riff", "sum_numbers", "ras.py");
      const markdown = await readFile(riffFile, "utf-8");
      const script = await readFile(scriptFile, "utf-8");
      expect(markdown).toContain("description: Aggregate values for analytics reports");
      expect(markdown).toContain("parameters:");
      expect(script).toContain('print(sum(RIFF_PARAMS["numbers"]))');

      const listResult = (await riffTool.execute({ action: "list" })) as ToolResult;
      expect(listResult.isError).not.toBe(true);

      const listText = getText(listResult);
      expect(listText).toContain("sum_numbers");
      expect(listText).toContain('"folder":');
      expect(listText).toContain('"docsPath":');
      expect(listText).toContain('"scriptPath":');
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
        name: "send_report",
        description: "Generate weekly report",
        parameters: {
          week: "Week number",
        },
        script: 'print("week:", RIFF_PARAMS["week"])',
      });

      const runResult = (await riffTool.execute({
        action: "run",
        name: "send_report",
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
        name: "deploy_release",
        description: "Deploy release candidates to production with gated checks",
        parameters: {
          version: "Release version",
        },
        script: 'print(RIFF_PARAMS["version"])',
      });

      const runResult = (await riffTool.execute({
        action: "run",
        name: "deploy_release",
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
        name: "content_alias_case",
        description: "Create riff via content alias",
        content: 'print("ok")',
      })) as ToolResult;

      expect(upsertResult.isError).not.toBe(true);

      const scriptFile = join(root, ".agent", "riff", "content_alias_case", "ras.py");
      const script = await readFile(scriptFile, "utf-8");
      expect(script).toContain('print("ok")');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
