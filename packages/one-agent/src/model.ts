import { gateway, type LanguageModel, wrapLanguageModel } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getOneConfigDir, resolveInterfaceModel } from "@one-agent/reason";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type WrappedModelConfig = Parameters<typeof wrapLanguageModel>[0];

function parseConfigFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function getOneScopedConfig(): Record<string, unknown> {
  const rootPath = getOneConfigDir();
  const sharedConfig = parseConfigFile(join(rootPath, "config.json"));
  const scopeConfig = parseConfigFile(join(rootPath, "one.json"));
  const scopedInShared = sharedConfig.one;

  return {
    ...(typeof scopedInShared === "object" && scopedInShared !== null
      ? (scopedInShared as Record<string, unknown>)
      : {}),
    ...scopeConfig,
  };
}

function readOneScopedValue(key: string): string | undefined {
  const scopedEnvValue = process.env[`ONE_ONE_${key}`];
  if (scopedEnvValue != null && scopedEnvValue !== "") {
    return scopedEnvValue;
  }

  const envValue = process.env[`ONE_${key}`];
  if (envValue != null && envValue !== "") {
    return envValue;
  }

  const config = getOneScopedConfig();
  const configValue = config[key];
  if (typeof configValue === "string" && configValue !== "") {
    return configValue;
  }
  if (typeof configValue === "number" || typeof configValue === "boolean") {
    return String(configValue);
  }

  return undefined;
}

function isDebugEnabled(): boolean {
  const value = process.env.ONE_AGENT_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function wrapWithDevTools(model: LanguageModel): LanguageModel {
  if (!isDebugEnabled()) {
    return model;
  }

  return wrapLanguageModel({
    model: model as WrappedModelConfig["model"],
    middleware: devToolsMiddleware() as WrappedModelConfig["middleware"],
  }) as LanguageModel;
}

export const vercel = (modelId: string): LanguageModel => wrapWithDevTools(gateway(modelId));

export const openaiCompatible = (modelId: string): LanguageModel => {
  const provider = readOneScopedValue("PROVIDER")?.trim().toLowerCase();
  if (provider === "vercel") {
    return vercel(modelId);
  }

  const apiKey = readOneScopedValue("OPENAI_API_KEY") || process.env.OPENAI_API_KEY || "";
  const baseURL = readOneScopedValue("OPENAI_BASE_URL") || process.env.OPENAI_BASE_URL || "";
  const compatibleProvider = createOpenAICompatible({
    name: "openai-compatible",
    apiKey,
    baseURL,
  });

  return wrapWithDevTools(compatibleProvider(modelId));
};

export async function resolveOneModel(defaultModelId: string): Promise<LanguageModel> {
  if (process.env.ONE_PROVIDER?.trim()?.toLowerCase() === "vercel") {
    const modelId = process.env.ONE_MODEL?.trim() || process.env.MODEL?.trim() || defaultModelId;
    return vercel(modelId);
  }

  const resolved = await resolveInterfaceModel("one", defaultModelId);
  return wrapWithDevTools(resolved.model);
}
