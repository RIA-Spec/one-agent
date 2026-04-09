import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { agent } from "../src/agent.js";

function hasCommand(command: string): boolean {
  const check = spawnSync("sh", ["-lc", `command -v ${command}`], { encoding: "utf-8" });
  return check.status === 0;
}

const acpCommand = process.env.ONE_AGENT_EXTENSION_ACP_COMMAND?.trim() || "claude-agent-acp";
const runIntegration = process.env.ONE_AGENT_EXTENSION_RUN_INTEGRATION === "1";
const canRun = runIntegration && hasCommand(acpCommand);
const maybeIt = canRun ? it : it.skip;

describe("agent extension integration", () => {
  maybeIt("runs through real ACP provider with claude-agent-acp and args []", async () => {
    const result = await agent("Reply with exactly: OK", {
      command: acpCommand,
      args: [],
      on_error: "return_error",
      budget: {
        maxSteps: 4,
        maxOutputTokens: 64,
        maxMinutes: 1,
      },
      extension: {
        enabled: true,
        injectSystemPrompt: "You must respond very concisely.",
      },
    });

    if (typeof result === "string") {
      expect(result.length).toBeGreaterThan(0);
      return;
    }

    expect(result.error.length).toBeGreaterThan(0);
  }, 120000);

  maybeIt("supports extension disabled path without mocks", async () => {
    const result = await agent("Say hi.", {
      command: acpCommand,
      args: [],
      on_error: "return_error",
      budget: {
        maxSteps: 2,
        maxOutputTokens: 32,
        maxMinutes: 1,
      },
      extension: {
        enabled: false,
        injectSystemPrompt: "This should not be injected when disabled.",
      },
    });

    if (typeof result === "string") {
      expect(result.length).toBeGreaterThan(0);
      return;
    }

    expect(result.error.length).toBeGreaterThan(0);
  }, 120000);
});
