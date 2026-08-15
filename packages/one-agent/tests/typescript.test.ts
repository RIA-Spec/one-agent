import { describe, expect, it, vi } from "vitest";
import { createTypeScriptRAS, type TypeScriptRASConfig } from "../src/ras/typescript.js";

function makeConfig(overrides: Partial<TypeScriptRASConfig> = {}): TypeScriptRASConfig {
  return {
    nodeFSRoot: process.cwd(),
    nodeFSMountPoint: "/workspace",
    reasonHandler: async () => ({ data: { result: "ok" }, error: null }),
    actHandler: () => async () => ({}),
    agentHandler: () => async () => "agent response",
    ...overrides,
  };
}

function getText(
  result: Awaited<ReturnType<ReturnType<typeof createTypeScriptRAS>["execute"]>>,
): string {
  return result.content[0].text;
}

describe("createTypeScriptRAS", () => {
  it("executes JavaScript and returns stdout", async () => {
    const ras = createTypeScriptRAS(makeConfig());
    const result = await ras.execute({ code: 'console.log("hello world");' });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("hello world");
  }, 60000);

  it("executes TypeScript syntax by transpiling before runtime", async () => {
    const ras = createTypeScriptRAS(makeConfig());
    const result = await ras.execute({
      code: "const total: number = 40 + 2;\nconsole.log(total);",
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("42");
  }, 60000);

  it("exposes structured inputs without embedding source text in code", async () => {
    const actImpl = vi.fn().mockResolvedValue({ ok: true });
    const ras = createTypeScriptRAS(makeConfig({ actHandler: () => actImpl }));
    const edit = {
      path: "src/example.ts",
      oldText: 'const pattern = "\\\\d+";\nconst quote = `"\'${value}`;',
      newText: 'const pattern = "\\\\w+";\nconst quote = `updated`;',
    };

    const result = await ras.execute({
      code: "await act('edit', inputs.edit); console.log('done');",
      inputs: { edit },
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("done");
    expect(actImpl).toHaveBeenCalledWith("edit", edit);
  }, 60000);

  it("returns no-output marker when user code prints nothing", async () => {
    const ras = createTypeScriptRAS(makeConfig());
    const result = await ras.execute({ code: "const x = 1 + 1;" });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toBe("(no output)");
  }, 60000);

  // Unknown-schema fallback: discovery is for dynamic/unknown tools, not the
  // per-task default flow. Known built-ins should be called directly.
  it("supports the manual lookup fallback for an unknown tool schema", async () => {
    const actImpl = vi
      .fn()
      .mockResolvedValueOnce({ tools: ["websearch", "bash"] })
      .mockResolvedValueOnce({ name: "websearch", description: "Search the web" })
      .mockResolvedValueOnce({
        results: [
          { title: "OpenTelemetry semantic conventions" },
          { title: "Span cardinality guidance" },
        ],
      });
    const reasonImpl = vi.fn().mockResolvedValue({
      data: {
        findings: [
          "Prefer stable span names",
          "Avoid high-cardinality attributes",
          "Propagate trace context across tools",
        ],
      },
      error: null,
    });

    const ras = createTypeScriptRAS(
      makeConfig({
        actHandler: () => actImpl,
        reasonHandler: reasonImpl,
      }),
    );

    const result = await ras.execute({
      code: `
const m = await act('__manual__', {});
if (m?.isError) return console.log(m);

const searchDef = await act('__manual__', { name: 'websearch' });
if (searchDef?.isError) return console.log(searchDef);

const res = await act('websearch', { query: 'OpenTelemetry tracing best practices for AI agents' });
if (res?.isError) return console.log(res);

const r = await reason(
  'Goal: extract top findings from web search results about OpenTelemetry tracing best practices for AI agents. Observation: ' + JSON.stringify(res).slice(0, 8000) + ' Constraints: return top 5 key findings as bullet points with brief descriptions.',
  { findings: [''] }
);
if (r?.error) return console.log(r.error);
console.log(r.data?.findings?.join('\\n'));
`,
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("Prefer stable span names");
    expect(getText(result)).toContain("Avoid high-cardinality attributes");
    expect(actImpl.mock.calls).toEqual([
      ["__manual__", {}],
      ["__manual__", { name: "websearch" }],
      ["websearch", { query: "OpenTelemetry tracing best practices for AI agents" }],
    ]);
    expect(reasonImpl).toHaveBeenCalledTimes(1);
    expect(reasonImpl.mock.calls[0]?.[0]).toContain(
      "OpenTelemetry tracing best practices for AI agents",
    );
    expect(reasonImpl.mock.calls[0]?.[1]).toEqual({ findings: [""] });
  }, 60000);

  it("calls a known built-in directly without manual discovery", async () => {
    const actImpl = vi.fn().mockResolvedValue({ ok: true });
    const ras = createTypeScriptRAS(
      makeConfig({
        actHandler: () => actImpl,
      }),
    );

    const result = await ras.execute({
      code: "await act('websearch', { query: 'structured inputs' }); console.log('done');",
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("done");
    expect(actImpl.mock.calls).toEqual([["websearch", { query: "structured inputs" }]]);
  }, 60000);

  it("round-trips a real edit payload with quotes, escapes, shell syntax, and unicode through inputs", async () => {
    const actImpl = vi.fn().mockResolvedValue({ ok: true });
    const ras = createTypeScriptRAS(
      makeConfig({
        actHandler: () => actImpl,
      }),
    );
    const edit = {
      path: "src/example.ts",
      oldText:
        'const quote = `"\'${value}`;\nconst pattern = "\\\\d+ \\\\w+";\nconst shell = "$HOME $(cmd)";\nconst label = "中文";',
      newText:
        'const quote = `"\'updated`;\nconst pattern = "\\\\d+ \\\\w+";\nconst shell = "$HOME $(cmd)";\nconst label = "中文更新";',
    };

    const result = await ras.execute({
      code: "await act('edit', inputs.edit); console.log('done');",
      inputs: { edit },
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("done");
    expect(actImpl).toHaveBeenCalledWith("edit", edit);
  }, 60000);

  it("keeps step markers out of stdout while still running act calls", async () => {
    const actImpl = vi.fn().mockResolvedValue({ ok: true });
    const ras = createTypeScriptRAS(
      makeConfig({
        actHandler: () => actImpl,
      }),
    );

    const result = await ras.execute({
      code: "await act('bash', { command: 'echo hi' });\nconsole.log('done');",
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("done");
    expect(getText(result)).not.toContain("[ONE:STEP_START");
    expect(getText(result)).not.toContain("[ONE:STEP_END");
    expect(actImpl).toHaveBeenCalledWith("bash", { command: "echo hi" });
  }, 60000);

  it("surfaces unresolved npm package failures from the Deno runtime", async () => {
    const ras = createTypeScriptRAS(makeConfig());
    const result = await ras.execute({
      code: "await import('npm:definitely-nonexistent-pkg-xyz-abc-123456');",
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("JavaScript execution failed");
    expect(getText(result)).toContain("ERR_UNSUPPORTED_ESM_URL_SCHEME");
  }, 60000);

  it("formats runtime exceptions as JavaScript execution failures", async () => {
    const ras = createTypeScriptRAS(makeConfig());
    const result = await ras.execute({
      code: "const value: any = undefined;\nconsole.log(value.missing());",
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("JavaScript execution failed");
    expect(getText(result)).toContain("Cannot read properties of undefined");
  }, 60000);

  it("fails before runtime on TypeScript syntax errors", async () => {
    const ras = createTypeScriptRAS(makeConfig());
    const result = await ras.execute({ code: "const value: = 5;" });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("TypeScript compile failed");
  });
});
