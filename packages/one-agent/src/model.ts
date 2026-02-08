import { gateway, type LanguageModel, wrapLanguageModel } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { createOpenAICompatible } from "@tencent/venus-ai-provider";

export const vercel = (modelId: string): LanguageModel =>
  wrapLanguageModel({
    model: gateway(modelId),
    middleware: devToolsMiddleware(),
  });

// Venus model provider
const venusProvider = createOpenAICompatible({
  name: "venus",
  apiKey: process.env.OPENAI_API_KEY || "",
});

export const venus: (modelId: string) => LanguageModel = (modelId: string) =>
  wrapLanguageModel({
    model: venusProvider(modelId),
    middleware: devToolsMiddleware(),
  });
