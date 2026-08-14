import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashRAS } from "../src/ras/bash.js";

type BashRASConfig = Parameters<typeof createBashRAS>[0];

function makeConfig(overrides: Partial<BashRASConfig> = {}): BashRASConfig {
  return {
    cwd: process.cwd(),
    reasonHandler: async () => ({ data: { result: "ok" }, error: undefined }),
    actHandler: () => async () => ({ content: [{ type: "text", text: "ok" }] }),
    agentHandler: () => async () => ({ data: { text: "agent response" } }),
    ...overrides,
  };
}

function getText(result: Awaited<ReturnType<ReturnType<typeof createBashRAS>["execute"]>>): string {
  return result.content[0].text;
}

describe("createBashRAS", () => {
  let originalCwd: string;
  let tempRoot: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
    tempRoot = await mkdtemp(join(tmpdir(), "one-agent-bash-ras-test-"));
    process.chdir(tempRoot);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("keeps the public tool name as one in bash mode", () => {
    const ras = createBashRAS(makeConfig({ cwd: tempRoot }));

    expect(ras.name).toBe("one");
  });

  it("executes shell commands inside just-bash", async () => {
    const ras = createBashRAS(makeConfig({ cwd: tempRoot }));
    const result = await ras.execute({ command: 'printf "hello" | tr "a-z" "A-Z"' });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("HELLO");
  });

  it("keeps reason available as a custom command", async () => {
    const reasonImpl = vi.fn().mockResolvedValue({
      data: { summary: "Sandbox summary" },
      error: undefined,
    });
    const ras = createBashRAS(
      makeConfig({
        cwd: tempRoot,
        reasonHandler: reasonImpl,
      }),
    );

    const result = await ras.execute({
      command: `printf "raw input" | reason --prompt "Summarize:" --prompt - --structure '{"summary":""}' | jq -r '.summary'`,
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("Sandbox summary");
    expect(reasonImpl).toHaveBeenCalledWith("Summarize:\nraw input", { summary: "" });
  });

  it("routes act bash to the host bash tool alias", async () => {
    const actImpl = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "host bash output" }],
      isError: false,
    });
    const ras = createBashRAS(
      makeConfig({
        cwd: tempRoot,
        actHandler: () => actImpl,
      }),
    );

    const result = await ras.execute({
      command: `act bash '{"command":"echo from host"}'`,
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("host bash output");
    expect(actImpl).toHaveBeenCalledWith("__host_bash__", { command: "echo from host" });
  });

  it("pipes structured inputs to act without shell-quoting source text", async () => {
    const actImpl = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "edited" }],
      isError: false,
    });
    const ras = createBashRAS(
      makeConfig({
        cwd: tempRoot,
        actHandler: () => actImpl,
      }),
    );
    const edit = {
      path: "src/example.ts",
      oldText: 'const pattern = "\\\\d+";\nconst shell = "$(echo untouched)";',
      newText: 'const pattern = "\\\\w+";\nconst shell = "`still data`";',
    };

    const result = await ras.execute({
      command: "one-input edit | act edit -",
      inputs: { edit },
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("edited");
    expect(actImpl).toHaveBeenCalledWith("edit", edit);
  });

  it("renders act output like the CLI, including attachment URLs", async () => {
    const actImpl = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Image fetched successfully: https://example.com/cat.png" }],
      attachments: [
        {
          type: "file",
          mime: "image/png",
          url: "https://cdn.example.com/cat.png",
        },
      ],
      isError: false,
    });
    const ras = createBashRAS(
      makeConfig({
        cwd: tempRoot,
        actHandler: () => actImpl,
      }),
    );

    const result = await ras.execute({
      command: `act webfetch '{"url":"https://example.com/cat.png"}'`,
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("Image fetched successfully: https://example.com/cat.png");
    expect(getText(result)).toContain("https://cdn.example.com/cat.png");
  });

  it("rewrites host bash alias in act manual output", async () => {
    const actImpl = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Tool: __host_bash__" }],
      isError: false,
    });
    const ras = createBashRAS(
      makeConfig({
        cwd: tempRoot,
        actHandler: () => actImpl,
      }),
    );

    const result = await ras.execute({ command: "act --manual bash" });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("Tool: bash");
    expect(getText(result)).not.toContain("__host_bash__");
    expect(actImpl).toHaveBeenCalledWith("__manual__", { name: "__host_bash__" });
  });

  it("matches reason CLI error behavior in bash mode", async () => {
    const ras = createBashRAS(
      makeConfig({
        cwd: tempRoot,
        reasonHandler: async () => ({
          data: { partial: true },
          error: "reason failed",
        }),
      }),
    );

    const result = await ras.execute({
      command:
        "reason --prompt 'Decide' --structure '{\"ok\":true}' > out.json; code=$?; cat out.json; exit $code",
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('"error": "reason failed"');
    expect(getText(result)).toContain('"partial": true');
  });
});
