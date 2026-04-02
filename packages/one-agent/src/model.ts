import { gateway, type LanguageModel, wrapLanguageModel } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

type WrappedModelConfig = Parameters<typeof wrapLanguageModel>[0];

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

// OpenAI-compatible model provider
const openaiCompatibleProvider = createOpenAICompatible({
  name: "openaiCompatible",
  baseURL: process.env.OPENAI_BASE_URL || "",
  apiKey: process.env.OPENAI_API_KEY || "",
});

export const openaiCompatible: (modelId: string) => LanguageModel = (modelId: string) =>
  wrapWithDevTools(openaiCompatibleProvider(modelId));
