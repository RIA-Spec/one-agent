import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "../src/prompts.js";
import { BUILTIN_RAS_TOOLS } from "../src/ras/tool-catalog.js";

const RESIDENT_CHAR_BUDGET = 5_500;
const EXTENSION_CHAR_BUDGET = 800;

describe.each(["python", "typescript", "bash"] as const)("%s system prompt", (mode) => {
  const prompt = buildAgentSystemPrompt(mode);

  it("uses one as the public tool", () => {
    expect(prompt).toContain("one public tool named `one`");
  });

  it("contains the direct-answer gate", () => {
    expect(prompt).toContain("answer directly");
    expect(prompt).toContain("do not call `one`");
  });

  it("does not mandate manual discovery", () => {
    expect(prompt).not.toContain("YOU MUST fetch the tool list");
  });

  it("lists every stable built-in tool exactly once in the catalog", () => {
    for (const tool of BUILTIN_RAS_TOOLS) {
      const occurrences = prompt.split(`- ${tool.name}:`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("does not contain resident example blocks", () => {
    expect(prompt).not.toContain("<examples>");
    expect(prompt).not.toContain("```");
  });

  it("stays within the resident character budget", () => {
    expect(prompt.length).toBeLessThanOrEqual(RESIDENT_CHAR_BUDGET);
  });

  it("keeps the optional agent extension within budget", () => {
    const withExtension = buildAgentSystemPrompt(mode, { agentExtensionEnabled: true });
    const extensionPart = withExtension.length - prompt.length;
    expect(extensionPart).toBeLessThanOrEqual(EXTENSION_CHAR_BUDGET);
  });
});
