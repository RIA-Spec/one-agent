import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveLlmFallbackModel = vi.fn();
const resolveInterfaceModel = vi.fn();
const resolveJevBackend = vi.fn();
const reasonWithJev = vi.fn();
const streamText = vi.fn();
const processStream = vi.fn();

vi.mock("../src/model.js", async () => {
  const actual = await vi.importActual<typeof import("../src/model.js")>("../src/model.js");
  return {
    ...actual,
    resolveLlmFallbackModel: (...args: unknown[]) => resolveLlmFallbackModel(...args),
    resolveInterfaceModel: (...args: unknown[]) => resolveInterfaceModel(...args),
    resolveJevBackend: (...args: unknown[]) => resolveJevBackend(...args),
  };
});

vi.mock("../src/jev/reason-jev.js", () => ({
  reasonWithJev: (...args: unknown[]) => reasonWithJev(...args),
}));

vi.mock("../src/utils/stream.js", () => ({
  processStream: (...args: unknown[]) => processStream(...args),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (...args: unknown[]) => streamText(...args),
  };
});

describe("reason() mode routing", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveLlmFallbackModel.mockReset();
    resolveInterfaceModel.mockReset();
    resolveJevBackend.mockReset();
    reasonWithJev.mockReset();
    streamText.mockReset();
    processStream.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function loadReason() {
    const mod = await import("../src/reason.js");
    return mod.reason;
  }

  function stubLlmSuccess(data: unknown) {
    const cleanup = vi.fn();
    resolveLlmFallbackModel.mockResolvedValue({
      model: { modelId: "mock-llm" },
      provider: "openai-compatible",
      modelId: "mock-llm",
      cleanup,
    });
    resolveInterfaceModel.mockResolvedValue({
      model: { modelId: "mock-llm" },
      provider: "openai-compatible",
      modelId: "mock-llm",
      cleanup,
    });

    // streamText path: submit_result execute is called by our tool; we short-circuit
    // by making the stream resolve and having execute populate via the tool wiring.
    // Easier: make streamText return resolved promises and have execute set via tool —
    // instead return structured output by invoking the tool execute from the mock.
    streamText.mockImplementation((opts: { tools?: { submit_result?: { execute?: (r: unknown) => unknown } } }) => {
      const payload = { data, error: null };
      opts.tools?.submit_result?.execute?.(payload);
      return {
        text: Promise.resolve(""),
        toolResults: Promise.resolve([{ toolName: "submit_result", output: "submitted" }]),
        finishReason: Promise.resolve("tool-calls"),
      };
    });
    return cleanup;
  }

  it("mode=jev + decision example → Jev when backend present", async () => {
    resolveJevBackend.mockReturnValue({
      kind: "jev",
      provider: "typesafe",
      apiKey: "k",
      baseURL: "https://api.typesafe.ai/v1",
      modelId: "jev-latest",
    });
    reasonWithJev.mockResolvedValue({ data: { retry: true }, error: null });

    const reason = await loadReason();
    const result = await reason("should we retry?", { retry: false }, { mode: "jev" });

    expect(reasonWithJev).toHaveBeenCalledOnce();
    expect(streamText).not.toHaveBeenCalled();
    expect(result.data).toEqual({ retry: true });
  });

  it("omitted mode preserves the historical LLM path", async () => {
    resolveJevBackend.mockReturnValue({
      kind: "jev",
      provider: "typesafe",
      apiKey: "k",
      baseURL: "https://api.typesafe.ai/v1",
      modelId: "jev-latest",
    });
    stubLlmSuccess({ retry: true });

    const reason = await loadReason();
    const result = await reason("should we retry?", { retry: false });

    expect(reasonWithJev).not.toHaveBeenCalled();
    expect(resolveInterfaceModel).toHaveBeenCalled();
    expect(result.data).toEqual({ retry: true });
  });

  it("mode=jev + summary example → LLM fallback when backend present", async () => {
    resolveJevBackend.mockReturnValue({
      kind: "jev",
      provider: "typesafe",
      apiKey: "k",
      baseURL: "https://api.typesafe.ai/v1",
      modelId: "jev-latest",
    });
    stubLlmSuccess({ summary: "all good", findings: "none", next: "ship" });

    const reason = await loadReason();
    const result = await reason(
      "summarize",
      {
        summary: "",
        findings: "",
        next: "",
      },
      { mode: "jev" },
    );

    expect(reasonWithJev).not.toHaveBeenCalled();
    expect(resolveLlmFallbackModel).toHaveBeenCalled();
    expect(streamText).toHaveBeenCalledOnce();
    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      summary: "all good",
      findings: "none",
      next: "ship",
    });
  });

  it("mode=llm forces LLM even with Jev backend", async () => {
    resolveJevBackend.mockReturnValue({
      kind: "jev",
      provider: "gateway",
      apiKey: "k",
      baseURL: "https://ai-gateway.vercel.sh/v4/ai",
      modelId: "typesafe-ai/jev",
    });
    stubLlmSuccess({ ok: true });

    const reason = await loadReason();
    const result = await reason("check", { ok: false }, { mode: "llm" });

    expect(reasonWithJev).not.toHaveBeenCalled();
    expect(resolveInterfaceModel).toHaveBeenCalled();
    expect(result.data).toEqual({ ok: true });
  });

  it("mode=jev with free-text example falls back to LLM", async () => {
    resolveJevBackend.mockReturnValue({
      kind: "jev",
      provider: "typesafe",
      apiKey: "k",
      baseURL: "https://api.typesafe.ai/v1",
      modelId: "jev-latest",
    });

    stubLlmSuccess({ summary: "all good", findings: "none" });
    const reason = await loadReason();
    const result = await reason(
      "summarize",
      { summary: "", findings: "" },
      { mode: "jev" },
    );

    expect(reasonWithJev).not.toHaveBeenCalled();
    expect(resolveLlmFallbackModel).toHaveBeenCalled();
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ summary: "all good", findings: "none" });
  });

  it("mode=jev with decision example calls Jev", async () => {
    resolveJevBackend.mockReturnValue({
      kind: "jev",
      provider: "typesafe",
      apiKey: "k",
      baseURL: "https://api.typesafe.ai/v1",
      modelId: "jev-latest",
    });
    reasonWithJev.mockResolvedValue({ data: { retry: false }, error: null });

    const reason = await loadReason();
    await reason("retry?", { retry: false }, { mode: "jev", booleanThreshold: 0.7 });

    expect(reasonWithJev).toHaveBeenCalledOnce();
    const args = reasonWithJev.mock.calls[0];
    expect(args[3]).toMatchObject({ mode: "jev", booleanThreshold: 0.7 });
  });

  it("mode=jev without Jev backend falls back to LLM", async () => {
    resolveJevBackend.mockReturnValue(null);
    stubLlmSuccess({ ok: true });

    const reason = await loadReason();
    const result = await reason("x", { ok: true }, { mode: "jev" });

    expect(resolveInterfaceModel).toHaveBeenCalled();
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ ok: true });
  });

});
