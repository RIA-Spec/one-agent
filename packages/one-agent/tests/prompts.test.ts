import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt, CORE_AGENT_PROMPT } from "../src/prompts.js";
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

  it("explains one job = one call via the ReAct round-trip cost model", () => {
    expect(prompt).toContain("one job = one `one` call");
    expect(prompt).toContain("Re in Act");
    expect(prompt).toContain("round trip");
    expect(prompt).toContain("failed, timed out, or returned evidence");
    expect(prompt).toContain("genuinely new target or dependency");
  });

  it("steers stdin JSON pipe usage away from magic tokens", () => {
    if (mode !== "bash") return;
    expect(prompt).toContain("never magic tokens");
    expect(prompt).toContain("one-input <key> | act <tool> -");
  });

  it("documents the inputs contract: act args must be objects, others free-form", () => {
    if (mode === "bash") {
      expect(prompt).toContain("piped into `act <tool> -` must be JSON objects");
      expect(prompt).toContain("Do not pre-serialize an object into a JSON string");
    } else {
      expect(prompt).toContain("Values passed to `act()` must be objects");
      expect(prompt).toContain("do not pre-serialize them into JSON strings");
    }
  });

  it("makes batching the default while reason() stays judgment-only", () => {
    expect(prompt).toContain("gather all evidence with `act()`");
    expect(prompt).toContain("deterministic control");
    expect(prompt).toContain("genuinely uncertain");
  });

  it("lists every stable built-in tool exactly once in the catalog", () => {
    for (const tool of BUILTIN_RAS_TOOLS) {
      const occurrences = prompt.split(`- ${tool.name}:`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("keeps the shared core prompt free of example blocks", () => {
    expect(CORE_AGENT_PROMPT).not.toContain("<examples>");
    expect(CORE_AGENT_PROMPT).not.toContain("```");
  });

  it("keeps resident examples to one minimal block", () => {
    expect(prompt).not.toContain("<examples>");
    const fenceCount = prompt.split("```").length - 1;
    expect(fenceCount).toBeLessThanOrEqual(2);
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
