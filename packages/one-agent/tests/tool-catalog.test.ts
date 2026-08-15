import { afterAll, describe, expect, it, vi } from "vitest";
import { getServer } from "../src/tools.js";
import { getToolFn } from "@one-agent/act";
import { BUILTIN_RAS_TOOLS } from "../src/ras/tool-catalog.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";

function listToolNames(manualText: string): string[] {
  return manualText
    .split("\n")
    .map((line) => line.split("\t")[0].trim())
    .filter(Boolean);
}

describe.each(["python", "typescript", "bash"] as const)(
  "%s built-in tool catalog parity",
  (mode) => {
    afterAll(() => {
      vi.unstubAllEnvs();
    });

    it("matches the real __manual__ listing and hides internal names", async () => {
      vi.stubEnv("RAS_MODE", mode);
      const server = await getServer();
      const result = await getToolFn(server as Parameters<typeof getToolFn>[0])("__manual__", {});
      const names = listToolNames((result.content[0] as TextContent).text);

      const catalogNames = BUILTIN_RAS_TOOLS.map((tool) => tool.name).sort();
      expect([...names].sort()).toEqual(catalogNames);
      expect(names).not.toContain("__host_bash__");
      expect(names).not.toContain("one");
    }, 60_000);
  },
);
