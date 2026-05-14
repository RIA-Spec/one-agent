import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalEnv = { ...process.env };
let tempConfigDir: string | null = null;

afterEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  if (tempConfigDir) {
    rmSync(tempConfigDir, { recursive: true, force: true });
    tempConfigDir = null;
  }
});

describe("resolveOneModel", () => {
  it("reads one scope config from file via reason resolver", async () => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "one-agent-vitest-config-"));
    process.env.XDG_CONFIG_HOME = tempConfigDir;
    mkdirSync(join(tempConfigDir, "one"), { recursive: true });
    writeFileSync(
      join(tempConfigDir, "one", "one.json"),
      JSON.stringify({
        PROVIDER: "openai-compatible",
        OPENAI_API_KEY: "k",
        OPENAI_BASE_URL: "https://example.com/v1",
        MODEL: "demo-model",
      }),
    );

    const { resolveOneModel } = await import("../src/model.js");
    const model = await resolveOneModel("fallback-model");
    expect(model).toBeTruthy();
  });
});
