import { describe, expect, it } from "vitest";
import { buildDelegatedAgentConfig } from "../src/tools.js";

describe("buildDelegatedAgentConfig", () => {
  it("injects the bounded worker contract and no outer tool catalog", () => {
    const config = buildDelegatedAgentConfig({});
    const injected = (config.extension as { injectSystemPrompt?: string })
      .injectSystemPrompt as string;

    expect(injected).toContain("bounded delegated worker");
    expect(injected).toContain("tools actually available in your own session");
    expect(injected).not.toContain("Runtime tool catalog");
    expect(injected).not.toContain("__manual__");
  });

  it("preserves caller-provided extension config including injectTools", () => {
    const config = buildDelegatedAgentConfig({
      budget: { maxSteps: 5 },
      extension: { injectTools: { mcpServers: { github: {} } } },
    });
    const extension = config.extension as { injectTools?: unknown; enabled?: boolean };

    expect(extension.injectTools).toEqual({ mcpServers: { github: {} } });
    expect(extension.enabled).toBe(true);
  });

  it("keeps base config fields untouched", () => {
    const config = buildDelegatedAgentConfig({
      model: "test-model",
      on_error: "return_error",
    });

    expect(config.model).toBe("test-model");
    expect(config.on_error).toBe("return_error");
  });
});
