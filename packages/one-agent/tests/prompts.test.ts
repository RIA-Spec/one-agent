import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("does not mention Jev unless a Jev backend is configured", () => {
    expect(prompt).not.toMatch(/jev/i);
    expect(prompt).not.toContain("fast bounded judgment");
  });
});

describe("Jev prompt guidance", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds fast bounded judgment guidance when a TypeSafe key is configured", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "apikey_test");
    const pyTsGuidance =
      'For a fast bounded judgment (boolean, number, or `$jev` choice/score), call `reason(prompt, example, {"mode": "jev"})` — example second, options third. Do not pass `mode=` keyword arguments; `reason()` accepts positional args only. Omit the third argument for free text or synthesis.';
    const bashGuidance =
      'For a fast bounded judgment (boolean, number, or `$jev` choice/score), use `reason --prompt "…" --structure \'…\' --mode jev` (`--structure` is required). Omit `--mode` for free text or synthesis.';
    for (const mode of ["python", "typescript", "bash"] as const) {
      const prompt = buildAgentSystemPrompt(mode);
      expect(prompt.length).toBeLessThanOrEqual(RESIDENT_CHAR_BUDGET);
      if (mode === "bash") {
        expect(prompt).toContain(bashGuidance);
        expect(prompt).not.toContain(pyTsGuidance);
        expect(prompt).not.toMatch(/\{ mode: "jev" \}/);
      } else {
        expect(prompt).toContain(pyTsGuidance);
        expect(prompt).not.toContain(bashGuidance);
        expect(prompt).not.toContain("--structure");
      }
    }
  });

  it("stays on the main prompt when Jev is switched off", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "apikey_test");
    vi.stubEnv("ONE_REASON_JEV_ENABLED", "0");
    const prompt = buildAgentSystemPrompt("bash");
    expect(prompt).not.toMatch(/jev/i);
    expect(prompt).not.toContain("fast bounded judgment");
  });

  it("does not mention Jev when the provider is selected without credentials", () => {
    vi.stubEnv("ONE_REASON_PROVIDER", "typesafe");
    const prompt = buildAgentSystemPrompt("python");
    expect(prompt).not.toMatch(/jev/i);
  });
});
