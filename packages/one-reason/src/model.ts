import { createAnthropic } from "@ai-sdk/anthropic";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { createACPProvider } from "@mcpc-tech/acp-ai-provider";
import { createOpenAICompatible } from "@tencent/venus-ai-provider";
import { type LanguageModel, wrapLanguageModel } from "ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type InterfaceProvider = "venus" | "openai" | "anthropic" | "acp";

export type ResolvedInterfaceModel = {
  model: LanguageModel;
  provider: InterfaceProvider;
  modelId: string;
  cleanup?: () => Promise<void> | void;
};

type Scope = "reason" | "act";
type ScopeConfig = Record<string, unknown>;

function wrap(model: LanguageModel): LanguageModel {
  return wrapLanguageModel({
    model: model as any,
    middleware: devToolsMiddleware() as any,
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
  const rootPath = join(process.cwd(), ".config", "one");
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
  if (typeof configValue === "number" || typeof configValue === "boolean") return String(configValue);
  return undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value == null || value === "") return undefined;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  return undefined;
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

export async function resolveInterfaceModel(
  scope: Scope,
  defaultModelId = "gemini-3.1-flash-lite",
): Promise<ResolvedInterfaceModel> {
  const config = loadScopedConfig(scope);
  const provider = (readScopedValue(scope, "PROVIDER", config) ?? "venus").toLowerCase() as InterfaceProvider;
  const modelId = readScopedValue(scope, "MODEL", config) ?? defaultModelId;

  if (provider === "anthropic") {
    const anthropicProvider = createAnthropic({
      apiKey: readScopedValue(scope, "ANTHROPIC_API_KEY", config),
      baseURL: readScopedValue(scope, "ANTHROPIC_BASE_URL", config),
      name: "anthropic",
    });

    return {
      model: wrap(anthropicProvider(modelId)),
      provider,
      modelId,
    };
  }

  if (provider === "openai") {
    const openaiProvider = createOpenAICompatible({
      name: "openai",
      apiKey: readScopedValue(scope, "OPENAI_API_KEY", config) || "",
      baseURL:
        readScopedValue(scope, "OPENAI_BASE_URL", config) ||
        "https://api.openai.com/v1",
    });

    return {
      model: wrap(openaiProvider(modelId)),
      provider,
      modelId,
    };
  }

  if (provider === "acp") {
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
        mcpServers: parseJson<any[]>(readScopedValue(scope, "ACP_MCP_SERVERS", config), []),
      },
      persistSession: parseBoolean(readScopedValue(scope, "ACP_PERSIST_SESSION", config)),
    });

    const acpModelId = readScopedValue(scope, "ACP_MODEL", config) || modelId;
    const acpModeId = readScopedValue(scope, "ACP_MODE", config);

    return {
      model: wrap(acpProvider.languageModel(acpModelId || undefined, acpModeId || undefined)),
      provider,
      modelId: acpModelId,
      cleanup: async () => {
        acpProvider.cleanup();
      },
    };
  }

  const venusProvider = createOpenAICompatible({
    name: "venus",
    apiKey:
      readScopedValue(scope, "VENUS_API_KEY", config) ||
      readScopedValue(scope, "OPENAI_API_KEY", config) ||
      "",
    ...(readScopedValue(scope, "VENUS_BASE_URL", config)
      ? { baseURL: readScopedValue(scope, "VENUS_BASE_URL", config) }
      : {}),
  });

  return {
    model: wrap(venusProvider(modelId)),
    provider: "venus",
    modelId,
  };
}
