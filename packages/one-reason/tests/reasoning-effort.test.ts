import { describe, expect, it, vi } from "vitest";
import { resolveInterfaceModel, type InterfaceProvider } from "../src/model.js";

type RequestBody = Record<string, unknown>;

/**
 * Resolves the model the same way the reason CLI does (env-driven config) and
 * captures the HTTP request body that the AI SDK would actually send. The
 * global fetch is stubbed to fail right after capturing, so no real provider
 * is contacted.
 */
async function captureRequestBody(
  provider: InterfaceProvider,
  modelId: string,
  effort: string | undefined,
): Promise<{ body: RequestBody; providerOptions: unknown }> {
  const isAnthropic = provider === "anthropic";
  vi.stubEnv("ONE_REASON_PROVIDER", provider);
  vi.stubEnv("ONE_REASON_MODEL", modelId);
  if (effort != null) {
    vi.stubEnv("ONE_REASON_REASONING_EFFORT", effort);
  }
  if (isAnthropic) {
    vi.stubEnv("ONE_REASON_ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("ONE_REASON_ANTHROPIC_BASE_URL", "http://127.0.0.1:1");
  } else {
    vi.stubEnv("ONE_REASON_OPENAI_API_KEY", "test-key");
    vi.stubEnv("ONE_REASON_OPENAI_BASE_URL", "http://127.0.0.1:1");
  }

  const requests: RequestBody[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: { body?: string }) => {
      requests.push(JSON.parse(init?.body ?? "{}") as RequestBody);
      throw new TypeError("mock network failure");
    }),
  );

  try {
    const resolved = await resolveInterfaceModel("reason");
    try {
      await (
        resolved.model as unknown as {
          doStream(args: unknown): Promise<unknown>;
        }
      ).doStream({
        inputFormat: "messages",
        mode: { type: "regular" },
        prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
        providerOptions: resolved.providerOptions,
      });
    } catch {
      // The stubbed fetch rejects after capturing the request body.
    }
    expect(requests).toHaveLength(1);
    return { body: requests[0], providerOptions: resolved.providerOptions };
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
}

function thinkingOf(body: RequestBody): Record<string, unknown> | undefined {
  return body.thinking as Record<string, unknown> | undefined;
}

function outputConfigOf(body: RequestBody): Record<string, unknown> | undefined {
  return body.output_config as Record<string, unknown> | undefined;
}

describe("reasoning effort -> Anthropic request body", () => {
  it("enables adaptive thinking with effort on Claude 4.6+ and Claude 5 models", async () => {
    const adaptiveModels = [
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-fable-5-1",
    ];
    for (const modelId of adaptiveModels) {
      for (const effort of ["low", "medium", "high"] as const) {
        const { body } = await captureRequestBody("anthropic", modelId, effort);
        expect(thinkingOf(body)).toEqual({ type: "adaptive" });
        expect(outputConfigOf(body)).toEqual({ effort });
      }
    }
  });

  it("accepts a gateway-prefixed model id for adaptive thinking models", async () => {
    const { body } = await captureRequestBody("anthropic", "anthropic/claude-sonnet-5", "high");
    expect(thinkingOf(body)).toEqual({ type: "adaptive" });
    expect(outputConfigOf(body)).toEqual({ effort: "high" });
  });

  it("enables legacy extended thinking with a fixed budget on older Claude models", async () => {
    const legacyModels = [
      "claude-sonnet-4-5",
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-haiku-4-5",
      "claude-sonnet-4-20250514",
      "claude-3-7-sonnet-20250219",
    ];
    const budgetByEffort = { low: 2048, medium: 8192, high: 16384 };
    for (const modelId of legacyModels) {
      for (const effort of ["low", "medium", "high"] as const) {
        const { body } = await captureRequestBody("anthropic", modelId, effort);
        expect(thinkingOf(body)).toEqual({
          type: "enabled",
          budget_tokens: budgetByEffort[effort],
        });
        // Effort is an adaptive-thinking parameter; it must not leak into
        // requests that use the legacy enabled + budget form.
        expect(outputConfigOf(body)).toBeUndefined();
      }
    }
  });

  it("sends thinking disabled on the wire when effort is off", async () => {
    for (const modelId of ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5"]) {
      const { body } = await captureRequestBody("anthropic", modelId, "off");
      expect(thinkingOf(body)).toEqual({ type: "disabled" });
    }
  });
});

describe("reasoning effort -> OpenAI-compatible request body", () => {
  it("forwards low/medium/high as reasoning_effort and off as none", async () => {
    const expectedByEffort: Record<string, string> = {
      low: "low",
      medium: "medium",
      high: "high",
      off: "none",
    };
    for (const effort of ["off", "low", "medium", "high"] as const) {
      const { body } = await captureRequestBody("openai-compatible", "kimi-k2.6", effort);
      expect((body as { reasoning_effort?: unknown }).reasoning_effort).toBe(
        expectedByEffort[effort],
      );
    }
  });
});

describe("reasoning effort -> OpenAI request body", () => {
  it("maps low/medium/high/off into the reasoning effort field", async () => {
    const expectedByEffort: Record<string, string> = {
      low: "low",
      medium: "medium",
      high: "high",
      off: "minimal",
    };
    for (const effort of ["off", "low", "medium", "high"] as const) {
      const { body } = await captureRequestBody("openai", "gpt-5.1", effort);
      const reasoning = (body as { reasoning?: { effort?: string } }).reasoning;
      expect(reasoning?.effort).toBe(expectedByEffort[effort]);
    }
  });
});

describe("reasoning effort resolution edge cases", () => {
  it("leaves providerOptions unset when REASONING_EFFORT is not configured", async () => {
    const { providerOptions } = await captureRequestBody(
      "anthropic",
      "claude-sonnet-4-6",
      undefined,
    );
    expect(providerOptions).toBeUndefined();
  });

  it("rejects unsupported values", async () => {
    vi.stubEnv("ONE_REASON_PROVIDER", "anthropic");
    vi.stubEnv("ONE_REASON_MODEL", "claude-sonnet-4-6");
    vi.stubEnv("ONE_REASON_ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("ONE_REASON_ANTHROPIC_BASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("ONE_REASON_REASONING_EFFORT", "turbo");
    await expect(resolveInterfaceModel("reason")).rejects.toThrow(
      'Invalid REASONING_EFFORT "turbo"',
    );
    vi.unstubAllEnvs();
  });

  it("rejects REASONING_EFFORT for the acp provider", async () => {
    vi.stubEnv("ONE_REASON_PROVIDER", "acp");
    vi.stubEnv("ONE_REASON_MODEL", "some-model");
    vi.stubEnv("ONE_REASON_REASONING_EFFORT", "high");
    await expect(resolveInterfaceModel("reason")).rejects.toThrow(
      "REASONING_EFFORT is not supported for provider: acp",
    );
    vi.unstubAllEnvs();
  });
});
