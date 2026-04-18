import { gateway, type LanguageModel, wrapLanguageModel } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { resolveInterfaceModel } from "@one-agent/reason";

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

export async function resolveOneModel(defaultModelId: string): Promise<LanguageModel> {
  if (process.env.ONE_PROVIDER?.trim()?.toLowerCase() === "vercel") {
    const modelId = process.env.ONE_MODEL?.trim() || process.env.MODEL?.trim() || defaultModelId;
    return vercel(modelId);
  }

  const resolved = await resolveInterfaceModel("one", defaultModelId);
  return wrapWithDevTools(resolved.model);
}
