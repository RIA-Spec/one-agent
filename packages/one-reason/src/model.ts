import { createAnthropic } from "@ai-sdk/anthropic";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createACPProvider } from "@mcpc-tech/acp-ai-provider";
import { type LanguageModel, wrapLanguageModel } from "ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getOneConfigDir } from "./config-path.js";
import type { JevProvider, ResolvedJevBackend } from "./jev/types.js";

export const DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1";
export const DEFAULT_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai";
export const DEFAULT_TYPESAFE_MODEL = "jev-latest";
export const DEFAULT_GATEWAY_MODEL = "typesafe-ai/jev";

export function isJevProvider(provider: string): provider is JevProvider {
  return provider === "typesafe" || provider === "gateway";
}

export type InterfaceProvider =
  | "openai-compatible"
  | "openai"
  | "anthropic"
  | "acp"
  | "typesafe"
  | "gateway";

export type ResolvedInterfaceModel = {
  model: LanguageModel;
  provider: InterfaceProvider;
  modelId: string;
  providerOptions?: ModelProviderOptions;
  cleanup?: () => Promise<void> | void;
};

export type ReasoningEffort = "off" | "low" | "medium" | "high";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type ModelProviderOptions = Record<string, Record<string, JsonValue>>;

type Scope = "reason" | "act" | "one";
type ScopeConfig = Record<string, unknown>;
type WrappedModelConfig = Parameters<typeof wrapLanguageModel>[0];
type AcpProviderConfig = Parameters<typeof createACPProvider>[0];
type AcpSessionConfig = NonNullable<AcpProviderConfig["session"]>;

function wrap(model: LanguageModel, enableDevTools: boolean): LanguageModel {
  if (!enableDevTools) {
    return model;
  }

  return wrapLanguageModel({
    model: model as WrappedModelConfig["model"],
    middleware: devToolsMiddleware() as WrappedModelConfig["middleware"],
  }) as LanguageModel;
}

function readScopedEnv(scope: Scope, key: string): string | undefined {
  const upperScope = scope.toUpperCase();
  return process.env[`ONE_${upperScope}_${key}`] ?? process.env[`ONE_${key}`];
}

function parseConfigFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function loadScopedConfig(scope: Scope): ScopeConfig {
  const rootPath = getOneConfigDir();
  const sharedConfig = parseConfigFile(join(rootPath, "config.json"));
  const scopeConfig = parseConfigFile(join(rootPath, `${scope}.json`));
  const scopedInShared = sharedConfig[scope];

  return {
    ...(typeof scopedInShared === "object" && scopedInShared !== null
      ? (scopedInShared as Record<string, unknown>)
      : {}),
    ...scopeConfig,
  };
}

function readScopedValue(scope: Scope, key: string, config: ScopeConfig): string | undefined {
  const envValue = readScopedEnv(scope, key);
  if (envValue != null && envValue !== "") return envValue;

  const configValue = config[key];
  if (configValue == null) return undefined;
  if (typeof configValue === "string") return configValue;
  if (typeof configValue === "number" || typeof configValue === "boolean")
    return String(configValue);
  return undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value == null || value === "") return undefined;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "yes" || value.toLowerCase() === "on") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "no" || value.toLowerCase() === "off") return false;
  return undefined;
}

function isDebugEnabled(scope: Scope, config: ScopeConfig): boolean {
  const scopedValue = parseBoolean(readScopedValue(scope, "DEBUG", config));
  if (scopedValue != null) {
    return scopedValue;
  }

  return (
    parseBoolean(process.env.ONE_AGENT_DEBUG) ??
    parseBoolean(process.env.RIA_PROXY_DEBUG) ??
    parseBoolean(process.env.DEBUG) ??
    false
  );
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  return JSON.parse(value) as T;
}

function parseArgs(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    return parseJson<string[]>(trimmed, []);
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

function normalizeReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;
  if (
    normalized === "off" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }
  throw new Error(`Invalid REASONING_EFFORT "${value}". Expected one of: off, low, medium, high.`);
}

// Anthropic models that enable thinking through adaptive thinking
// (`thinking: { type: "adaptive" }` plus the `effort` output-config parameter).
// This covers Claude 4.6 and later and the Claude 5 family. On Claude Opus 4.7
// and later (and Claude 5), adaptive is the only accepted way to turn thinking
// on; the legacy `enabled` + `budgetTokens` form returns a 400 error there.
// Substring matches also cover dated aliases such as claude-sonnet-4-6-20250805.
const ANTHROPIC_ADAPTIVE_THINKING_MODEL_SUBSTRINGS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
];

type ReasoningEffortLevel = Exclude<ReasoningEffort, "off">;

// Legacy Anthropic models (Claude 4.6 and earlier) enable thinking through
// `thinking: { type: "enabled", budgetTokens }` and have no effort parameter.
// Each REASONING_EFFORT level therefore maps to a fixed thinking token budget.
const ANTHROPIC_LEGACY_THINKING_BUDGET_BY_EFFORT: Record<ReasoningEffortLevel, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
};

function isAnthropicAdaptiveThinkingModel(modelId: string): boolean {
  // Accept gateway-style model ids such as "anthropic/claude-sonnet-5".
  const normalizedModelId = modelId.replace(/^anthropic\//, "");
  return ANTHROPIC_ADAPTIVE_THINKING_MODEL_SUBSTRINGS.some((model) =>
    normalizedModelId.includes(model),
  );
}

function anthropicReasoningProviderOptions(
  modelId: string,
  effort: ReasoningEffort,
): ModelProviderOptions {
  if (effort === "off") {
    // Explicitly disable thinking. Requires @ai-sdk/anthropic >= 3.0.93;
    // earlier versions dropped the `disabled` thinking field from the request.
    return { anthropic: { thinking: { type: "disabled" } } };
  }

  if (isAnthropicAdaptiveThinkingModel(modelId)) {
    // Claude 4.6+ and Claude 5 models: adaptive thinking plus the effort level.
    return { anthropic: { thinking: { type: "adaptive" }, effort } };
  }

  // Claude 4.6 and earlier: legacy extended thinking with a fixed token budget.
  return {
    anthropic: {
      thinking: {
        type: "enabled",
        budgetTokens: ANTHROPIC_LEGACY_THINKING_BUDGET_BY_EFFORT[effort],
      },
    },
  };
}

function reasoningEffortProviderOptions(
  provider: InterfaceProvider,
  modelId: string,
  effort: ReasoningEffort,
): ModelProviderOptions | undefined {
  switch (provider) {
    case "openai":
      if (effort === "off") {
        return { openai: { reasoningEffort: "minimal" } };
      }
      return { openai: { reasoningEffort: effort } };
    case "openai-compatible":
      return { openaiCompatible: { reasoningEffort: effort === "off" ? "none" : effort } };
    case "anthropic":
      return anthropicReasoningProviderOptions(modelId, effort);
    default:
      throw new Error(`REASONING_EFFORT is not supported for provider: ${provider}`);
  }
}

export async function resolveInterfaceModel(
  scope: Scope,
  defaultModelId = "gemini-3.1-flash-lite",
): Promise<ResolvedInterfaceModel> {
  const config = loadScopedConfig(scope);
  const enableDevTools = isDebugEnabled(scope, config);
  const provider = (
    readScopedValue(scope, "PROVIDER", config) ?? "openai-compatible"
  ).toLowerCase() as InterfaceProvider;
  const modelId = readScopedValue(scope, "MODEL", config) ?? defaultModelId;
  const reasoningEffort = normalizeReasoningEffort(
    readScopedValue(scope, "REASONING_EFFORT", config),
  );

  if (provider === "anthropic") {
    const anthropicProvider = createAnthropic({
      apiKey: readScopedValue(scope, "ANTHROPIC_API_KEY", config),
      baseURL: readScopedValue(scope, "ANTHROPIC_BASE_URL", config),
      name: "anthropic",
    });
    const providerOptions = reasoningEffort
      ? reasoningEffortProviderOptions(provider, modelId, reasoningEffort)
      : undefined;

    return {
      model: wrap(anthropicProvider(modelId), enableDevTools),
      provider,
      modelId,
      providerOptions,
    };
  }

  if (provider === "openai") {
    const apiKey = readScopedValue(scope, "OPENAI_API_KEY", config);
    if (!apiKey) {
      throw new Error("OpenAI provider selected but OPENAI_API_KEY is not set");
    }

    const openaiProvider = createOpenAI({
      apiKey,
      ...(readScopedValue(scope, "OPENAI_BASE_URL", config)
        ? { baseURL: readScopedValue(scope, "OPENAI_BASE_URL", config) }
        : {}),
    });
    const providerOptions = reasoningEffort
      ? reasoningEffortProviderOptions(provider, modelId, reasoningEffort)
      : undefined;

    return {
      model: wrap(openaiProvider(modelId), enableDevTools),
      provider,
      modelId,
      providerOptions,
    };
  }

  if (provider === "openai-compatible") {
    const apiKey = readScopedValue(scope, "OPENAI_API_KEY", config);
    const baseURL = readScopedValue(scope, "OPENAI_BASE_URL", config);

    if (!apiKey) {
      throw new Error("openai-compatible provider selected but OPENAI_API_KEY is not set");
    }
    if (!baseURL) {
      throw new Error("openai-compatible provider selected but OPENAI_BASE_URL is not set");
    }

    const compatibleProvider = createOpenAICompatible({
      name: "openai-compatible",
      apiKey,
      baseURL,
    });
    const providerOptions = reasoningEffort
      ? reasoningEffortProviderOptions(provider, modelId, reasoningEffort)
      : undefined;

    return {
      model: wrap(compatibleProvider(modelId), enableDevTools),
      provider,
      modelId,
      providerOptions,
    };
  }

  if (provider === "acp") {
    if (reasoningEffort) {
      throw new Error("REASONING_EFFORT is not supported for provider: acp");
    }
    const command = readScopedValue(scope, "ACP_COMMAND", config);
    if (!command) {
      throw new Error("ACP provider selected but ACP_COMMAND is not set");
    }

    const acpProvider = createACPProvider({
      command,
      args: parseArgs(readScopedValue(scope, "ACP_ARGS", config)),
      env: parseJson<Record<string, string> | undefined>(
        readScopedValue(scope, "ACP_ENV", config),
        undefined,
      ),
      session: {
        cwd: readScopedValue(scope, "ACP_SESSION_CWD", config) || process.cwd(),
        mcpServers: parseJson<AcpSessionConfig["mcpServers"]>(
          readScopedValue(scope, "ACP_MCP_SERVERS", config),
          [],
        ),
      },
      persistSession: parseBoolean(readScopedValue(scope, "ACP_PERSIST_SESSION", config)),
    });

    const acpModelId = readScopedValue(scope, "ACP_MODEL", config) || modelId;
    const acpModeId = readScopedValue(scope, "ACP_MODE", config);

    return {
      model: wrap(
        acpProvider.languageModel(acpModelId || undefined, acpModeId || undefined),
        enableDevTools,
      ),
      provider,
      modelId: acpModelId,
      cleanup: async () => {
        acpProvider.cleanup();
      },
    };
  }

  if (isJevProvider(provider)) {
    throw new Error(
      `Provider "${provider}" is a Jev evaluation backend and does not expose a language model. ` +
        `Call reason() directly, or use resolveJevBackend("reason").`,
    );
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value != null && value !== "") return value;
  }
  return undefined;
}

/**
 * Resolve an LLM language model for synthesis-style `reason()` when the primary
 * PROVIDER is typesafe|gateway (Jev).
 *
 * Resolution order:
 * 1. ONE_REASON_FALLBACK_PROVIDER (+ FALLBACK_OPENAI_API_KEY / FALLBACK_MODEL / …)
 * 2. The `one` scope config (`one auth`) when that provider is an LLM
 * 3. Otherwise throw a clear error telling the user how to configure fallback
 */
export async function resolveLlmFallbackModel(
  scope: Scope = "reason",
  defaultModelId = "gemini-3.1-flash-lite",
): Promise<ResolvedInterfaceModel> {
  const config = loadScopedConfig(scope);
  const fallbackProvider = readScopedValue(scope, "FALLBACK_PROVIDER", config)?.toLowerCase();

  if (fallbackProvider) {
    if (isJevProvider(fallbackProvider)) {
      throw new Error(
        `ONE_REASON_FALLBACK_PROVIDER="${fallbackProvider}" is a Jev backend; ` +
          `fallback must be an LLM provider (openai-compatible|openai|anthropic|acp).`,
      );
    }

    const envKeys: Array<[string, string | undefined]> = [
      ["ONE_REASON_PROVIDER", fallbackProvider],
      [
        "ONE_REASON_MODEL",
        readScopedValue(scope, "FALLBACK_MODEL", config) ??
          readScopedValue(scope, "FALLBACK_OPENAI_MODEL", config),
      ],
      [
        "ONE_REASON_OPENAI_API_KEY",
        firstNonEmpty(
          readScopedValue(scope, "FALLBACK_OPENAI_API_KEY", config),
          readScopedValue(scope, "FALLBACK_API_KEY", config),
        ),
      ],
      [
        "ONE_REASON_OPENAI_BASE_URL",
        firstNonEmpty(
          readScopedValue(scope, "FALLBACK_OPENAI_BASE_URL", config),
          readScopedValue(scope, "FALLBACK_BASE_URL", config),
        ),
      ],
      [
        "ONE_REASON_ANTHROPIC_API_KEY",
        readScopedValue(scope, "FALLBACK_ANTHROPIC_API_KEY", config),
      ],
      [
        "ONE_REASON_ANTHROPIC_BASE_URL",
        readScopedValue(scope, "FALLBACK_ANTHROPIC_BASE_URL", config),
      ],
      ["ONE_REASON_ACP_COMMAND", readScopedValue(scope, "FALLBACK_ACP_COMMAND", config)],
      ["ONE_REASON_ACP_ARGS", readScopedValue(scope, "FALLBACK_ACP_ARGS", config)],
      ["ONE_REASON_ACP_MODEL", readScopedValue(scope, "FALLBACK_ACP_MODEL", config)],
      [
        "ONE_REASON_REASONING_EFFORT",
        readScopedValue(scope, "FALLBACK_REASONING_EFFORT", config),
      ],
    ];

    const previous = new Map<string, string | undefined>();
    for (const [key, value] of envKeys) {
      previous.set(key, process.env[key]);
      if (value != null && value !== "") {
        process.env[key] = value;
      } else if (key === "ONE_REASON_PROVIDER") {
        process.env[key] = fallbackProvider;
      } else {
        delete process.env[key];
      }
    }

    try {
      return await resolveInterfaceModel(scope, defaultModelId);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  // Prefer the main agent LLM (`one auth`) when reason PROVIDER is Jev-only.
  if (scope === "reason") {
    try {
      const oneConfig = loadScopedConfig("one");
      const oneProvider = (
        readScopedValue("one", "PROVIDER", oneConfig) ?? ""
      ).toLowerCase();
      if (oneProvider && !isJevProvider(oneProvider)) {
        return await resolveInterfaceModel("one", defaultModelId);
      }
    } catch {
      // fall through to clear error below
    }
  }

  throw new Error(
    "This reason() example needs the LLM synthesis path (free-text / summary fields), " +
      "but PROVIDER is typesafe|gateway (Jev-only). Configure a fallback LLM via " +
      "ONE_REASON_FALLBACK_PROVIDER=openai-compatible (plus ONE_REASON_FALLBACK_OPENAI_API_KEY, " +
      "ONE_REASON_FALLBACK_OPENAI_BASE_URL, ONE_REASON_FALLBACK_MODEL), or run `one auth` " +
      "so the main agent model can be used. Alternatively call reason(prompt, example, { mode: 'llm' }) " +
      "with an LLM PROVIDER.",
  );
}

/**
 * Resolve TypeSafe / AI Gateway Jev config when PROVIDER is `typesafe` or `gateway`.
 * Returns null for LLM providers so `reason()` can fall through to streamText.
 *
 * DX mirrors OpenAI-compatible config: base URL + API key + model.
 * Scoped ONE_REASON_* keys win; provider-specific aliases are accepted as fallbacks.
 */
export function resolveJevBackend(scope: Scope): ResolvedJevBackend | null {
  const config = loadScopedConfig(scope);
  const provider = (
    readScopedValue(scope, "PROVIDER", config) ?? "openai-compatible"
  ).toLowerCase();

  if (!isJevProvider(provider)) {
    return null;
  }

  if (provider === "typesafe") {
    const apiKey = firstNonEmpty(
      readScopedValue(scope, "TYPESAFE_API_KEY", config),
      readScopedValue(scope, "OPENAI_API_KEY", config),
      process.env.TYPESAFE_API_KEY,
      process.env.TYPESAFE_AI_API_KEY,
    );
    if (!apiKey) {
      throw new Error(
        "typesafe provider selected but no API key found. Set ONE_REASON_TYPESAFE_API_KEY " +
          "(or ONE_REASON_OPENAI_API_KEY), or TYPESAFE_API_KEY / TYPESAFE_AI_API_KEY.",
      );
    }
    const baseURL =
      firstNonEmpty(
        readScopedValue(scope, "TYPESAFE_BASE_URL", config),
        readScopedValue(scope, "OPENAI_BASE_URL", config),
        process.env.TYPESAFE_BASE_URL,
        process.env.TYPESAFE_AI_BASE_URL,
      ) ?? DEFAULT_TYPESAFE_BASE_URL;
    const modelId = readScopedValue(scope, "MODEL", config) ?? DEFAULT_TYPESAFE_MODEL;
    return {
      kind: "jev",
      provider: "typesafe",
      apiKey,
      baseURL: baseURL.replace(/\/+$/, ""),
      modelId,
    };
  }

  const apiKey = firstNonEmpty(
    readScopedValue(scope, "GATEWAY_API_KEY", config),
    readScopedValue(scope, "OPENAI_API_KEY", config),
    process.env.AI_GATEWAY_API_KEY,
    process.env.VERCEL_AI_GATEWAY_API_KEY,
  );
  if (!apiKey) {
    throw new Error(
      "gateway provider selected but no API key found. Set ONE_REASON_GATEWAY_API_KEY " +
        "(or ONE_REASON_OPENAI_API_KEY), or AI_GATEWAY_API_KEY.",
    );
  }
  const baseURL =
    firstNonEmpty(
      readScopedValue(scope, "GATEWAY_BASE_URL", config),
      readScopedValue(scope, "OPENAI_BASE_URL", config),
      process.env.AI_GATEWAY_BASE_URL,
    ) ?? DEFAULT_GATEWAY_BASE_URL;
  const modelId = readScopedValue(scope, "MODEL", config) ?? DEFAULT_GATEWAY_MODEL;
  return {
    kind: "jev",
    provider: "gateway",
    apiKey,
    baseURL: baseURL.replace(/\/+$/, ""),
    modelId,
  };
}
