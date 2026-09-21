import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateJev, JevHttpError } from "../src/jev/client.js";
import { mapExampleToQuestions } from "../src/jev/map-example.js";
import { reasonWithJev } from "../src/jev/reason-jev.js";
import { resolveJevBackend, resolveLlmFallbackModel } from "../src/model.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("evaluateJev typesafe", () => {
  it("POSTs to /systemone with Bearer auth and noul questions", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.typesafe.ai/v1/systemone");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer ts-key");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("jev-latest");
      expect(body.state).toBe("state text");
      expect(body.questions.urgent.type).toBe("noul");
      return new Response(
        JSON.stringify({
          model: "jev-1.0.0",
          answers: { urgent: { type: "noul", noul: 0.88 } },
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const mapped = mapExampleToQuestions({ urgent: false });
    const answers = await evaluateJev({
      backend: {
        kind: "jev",
        provider: "typesafe",
        apiKey: "ts-key",
        baseURL: "https://api.typesafe.ai/v1",
        modelId: "jev-latest",
      },
      state: "state text",
      questions: mapped.questions,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(answers.urgent).toEqual({ type: "noul", noul: 0.88 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("evaluateJev gateway", () => {
  it("POSTs to /evaluation-model with evaluation headers", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer gw-key");
      expect(headers.get("ai-evaluation-model-specification-version")).toBe("4");
      expect(headers.get("ai-model-id")).toBe("typesafe-ai/jev");
      const body = JSON.parse(String(init?.body));
      expect(body.questions.urgent.type).toBe("boolean");
      return new Response(
        JSON.stringify({
          answers: { urgent: { type: "boolean", probability: 0.77 } },
        }),
        { status: 200 },
      );
    });

    const mapped = mapExampleToQuestions({ urgent: false });
    const answers = await evaluateJev({
      backend: {
        kind: "jev",
        provider: "gateway",
        apiKey: "gw-key",
        baseURL: "https://ai-gateway.vercel.sh/v4/ai",
        modelId: "typesafe-ai/jev",
      },
      state: "state",
      questions: mapped.questions,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(answers.urgent).toEqual({ type: "boolean", probability: 0.77 });
  });

  it("surfaces 401 with a clear message", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ message: "invalid key" }), { status: 401 }),
    );

    await expect(
      evaluateJev({
        backend: {
          kind: "jev",
          provider: "typesafe",
          apiKey: "bad",
          baseURL: "https://api.typesafe.ai/v1",
          modelId: "jev-latest",
        },
        state: "x",
        questions: mapExampleToQuestions({ ok: true }).questions,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(JevHttpError);
  });
});

describe("reasonWithJev", () => {
  it("returns example-shaped data from mocked fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              answers: {
                failed: { type: "noul", noul: 0.95 },
                reason: { type: "choice", choice: "timeout" },
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await reasonWithJev(
      "goal: detect failure\nobservation: request timed out",
      {
        failed: false,
        reason: {
          $jev: "choice",
          options: ["timeout", "network", "other"],
          value: "timeout",
        },
      },
      {
        kind: "jev",
        provider: "typesafe",
        apiKey: "k",
        baseURL: "https://api.typesafe.ai/v1",
        modelId: "jev-latest",
      },
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ failed: true, reason: "timeout" });
  });
});

describe("resolveJevBackend", () => {
  it("resolves typesafe with OpenAI-style env vars", () => {
    vi.stubEnv("ONE_REASON_PROVIDER", "typesafe");
    vi.stubEnv("ONE_REASON_OPENAI_API_KEY", "k");
    vi.stubEnv("ONE_REASON_OPENAI_BASE_URL", "https://api.typesafe.ai/v1");
    vi.stubEnv("ONE_REASON_MODEL", "jev-latest");

    expect(resolveJevBackend("reason")).toEqual({
      kind: "jev",
      provider: "typesafe",
      apiKey: "k",
      baseURL: "https://api.typesafe.ai/v1",
      modelId: "jev-latest",
    });
  });

  it("falls back to TYPESAFE_API_KEY and AI_GATEWAY_API_KEY aliases", () => {
    vi.stubEnv("ONE_REASON_PROVIDER", "gateway");
    vi.stubEnv("AI_GATEWAY_API_KEY", "gw");

    const backend = resolveJevBackend("reason");
    expect(backend?.provider).toBe("gateway");
    expect(backend?.apiKey).toBe("gw");
    expect(backend?.baseURL).toBe("https://ai-gateway.vercel.sh/v4/ai");
    expect(backend?.modelId).toBe("typesafe-ai/jev");
  });

  it("returns null for LLM providers when no Jev keys are set", () => {
    vi.stubEnv("ONE_REASON_PROVIDER", "openai-compatible");
    expect(resolveJevBackend("reason")).toBeNull();
  });

  it("respects ONE_REASON_JEV_ENABLED=0 toggle", () => {
    vi.stubEnv("ONE_REASON_JEV_ENABLED", "0");
    vi.stubEnv("TYPESAFE_API_KEY", "ts-key");

    expect(resolveJevBackend("reason")).toBeNull();
    expect(resolveJevBackend("reason", { jevEnabled: false })).toBeNull();
  });

  it("resolves standalone ONE_REASON_JEV_PROVIDER alongside LLM provider", () => {
    vi.stubEnv("ONE_REASON_PROVIDER", "openai-compatible");
    vi.stubEnv("ONE_REASON_JEV_PROVIDER", "typesafe");
    vi.stubEnv("TYPESAFE_API_KEY", "ts-key");

    const backend = resolveJevBackend("reason");
    expect(backend?.provider).toBe("typesafe");
    expect(backend?.apiKey).toBe("ts-key");
    expect(backend?.baseURL).toBe("https://api.typesafe.ai/v1");
  });

  it("auto-detects Jev provider from API keys when PROVIDER is LLM", () => {
    vi.stubEnv("ONE_REASON_PROVIDER", "openai-compatible");
    vi.stubEnv("AI_GATEWAY_API_KEY", "gw-auto");

    const backend = resolveJevBackend("reason");
    expect(backend?.provider).toBe("gateway");
    expect(backend?.apiKey).toBe("gw-auto");
    expect(backend?.baseURL).toBe("https://ai-gateway.vercel.sh/v4/ai");
  });
});

describe("resolveLlmFallbackModel", () => {
  it("resolves via ONE_REASON_FALLBACK_* when primary provider is Jev", async () => {
    vi.stubEnv("ONE_REASON_PROVIDER", "typesafe");
    vi.stubEnv("ONE_REASON_OPENAI_API_KEY", "jev-key");
    vi.stubEnv("ONE_REASON_FALLBACK_PROVIDER", "openai-compatible");
    vi.stubEnv("ONE_REASON_FALLBACK_OPENAI_API_KEY", "llm-key");
    vi.stubEnv("ONE_REASON_FALLBACK_OPENAI_BASE_URL", "https://api.example.com/v1");
    vi.stubEnv("ONE_REASON_FALLBACK_MODEL", "gpt-test");

    const resolved = await resolveLlmFallbackModel("reason");
    expect(resolved.provider).toBe("openai-compatible");
    expect(resolved.modelId).toBe("gpt-test");
  });

  it("throws a clear error when no fallback LLM is configured", async () => {
    vi.stubEnv("ONE_REASON_PROVIDER", "typesafe");
    vi.stubEnv("ONE_REASON_OPENAI_API_KEY", "jev-key");
    // Ensure one scope is not an LLM either
    vi.stubEnv("ONE_ONE_PROVIDER", "typesafe");
    vi.stubEnv("ONE_ONE_OPENAI_API_KEY", "x");

    await expect(resolveLlmFallbackModel("reason")).rejects.toThrow(/FALLBACK_PROVIDER|LLM synthesis/);
  });
});
