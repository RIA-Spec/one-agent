import { gateway, type LanguageModel, wrapLanguageModel } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const vercel = (modelId: string): LanguageModel =>
  wrapLanguageModel({
    model: gateway(modelId),
    middleware: devToolsMiddleware(),
  });

// OpenAI-compatible model provider
const openaiCompatibleProvider = createOpenAICompatible({
  name: "openaiCompatible",
  baseURL: process.env.OPENAI_BASE_URL || "",
  apiKey: process.env.OPENAI_API_KEY || "",
});

export const openaiCompatible: (modelId: string) => LanguageModel = (modelId: string) =>
  wrapLanguageModel({
    model: openaiCompatibleProvider(modelId),
    middleware: devToolsMiddleware(),
  });
