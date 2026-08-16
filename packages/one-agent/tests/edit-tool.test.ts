import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool } from "../src/interfaces/tools/edit.js";

describe("createEditTool", () => {
  it("fails with an actionable message when given a JSON-encoded string instead of an object", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "one-agent-edit-tool-"));
    try {
      await writeFile(join(cwd, "a.txt"), "line one\nline two\n");
      const tool = createEditTool(cwd);
      // A JSON-encoded string survives JSON.parse as a string: no path/oldText/newText.
      const result = await tool.execute(
        '{"path":"a.txt","oldText":"line one","newText":"LINE ONE"}' as never,
      );
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).not.toContain("split");
      expect(text.toLowerCase()).toContain("json-encoded string");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("still edits successfully with a proper object", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "one-agent-edit-tool-"));
    try {
      await writeFile(join(cwd, "a.txt"), "line one\nline two\n");
      const tool = createEditTool(cwd);
      const result = await tool.execute({
        path: "a.txt",
        oldText: "line one",
        newText: "LINE ONE",
      });
      expect(result.isError).not.toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("LINE ONE");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
