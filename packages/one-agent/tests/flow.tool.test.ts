import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFlowTool } from "../src/interfaces/tools/flow.js";

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

function getText(result: unknown): string {
  const typed = result as ToolResult;
  return typed.content?.[0]?.text ?? "";
}

describe("flow tool", () => {
  it("upserts into .agent/flow and lists flows", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-flow-"));

    try {
      const flowTool = createFlowTool(root);

      const upsertResult = (await flowTool.execute({
        action: "upsert",
        name: "sum_numbers",
        description: "Aggregate values for analytics reports",
        parameters: {
          numbers: "Array of numbers to aggregate",
        },
        script: 'print(sum(FLOW_PARAMS["numbers"]))',
      })) as ToolResult;

      expect(upsertResult.isError).not.toBe(true);

      const flowFile = join(root, ".agent", "flow", "sum_numbers.md");
      const markdown = await readFile(flowFile, "utf-8");
      expect(markdown).toContain("description: Aggregate values for analytics reports");
      expect(markdown).toContain("parameters:");

      const listResult = (await flowTool.execute({ action: "list" })) as ToolResult;
      expect(listResult.isError).not.toBe(true);

      const listText = getText(listResult);
      expect(listText).toContain("sum_numbers");
      expect(listText).toContain('"folder":');
      expect(listText).toContain(".agent/flow");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks run when purpose does not match description", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-agent-flow-"));

    try {
      const flowTool = createFlowTool(root);

      await flowTool.execute({
        action: "upsert",
        name: "deploy_release",
        description: "Deploy release candidates to production with gated checks",
        parameters: {
          version: "Release version",
        },
        script: 'print(FLOW_PARAMS["version"])',
      });

      const runResult = (await flowTool.execute({
        action: "run",
        name: "deploy_release",
        purpose: "Generate monthly chart images for marketing",
        parameters: {
          version: "1.2.3",
        },
      })) as ToolResult;

      expect(runResult.isError).toBe(true);
      expect(getText(runResult)).toContain("Flow description mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
