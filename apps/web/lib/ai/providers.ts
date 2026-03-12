import { gateway } from "@ai-sdk/gateway";
import { openaiCompatible } from "@one/agent";
import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { isTestEnvironment } from "../constants";

const THINKING_SUFFIX_REGEX = /-thinking$/;

export const myProvider = isTestEnvironment
  ? (() => {
      const {
        artifactModel,
        chatModel,
        reasoningModel,
        titleModel,
      } = require("./models.mock");
      return customProvider({
        languageModels: {
          "chat-model": chatModel,
          "chat-model-reasoning": reasoningModel,
          "title-model": titleModel,
          "artifact-model": artifactModel,
        },
      });
    })()
  : null;

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  // ONE Agent models - use OpenAI-compatible provider
  if (modelId === "one-agent" || modelId === "one-agent-reasoning") {
    const model = openaiCompatible("gemini-3.1-pro") as Parameters<
      typeof wrapLanguageModel
    >[0]["model"];

    if (modelId === "one-agent-reasoning") {
      return wrapLanguageModel({
        model,
        middleware: extractReasoningMiddleware({ tagName: "think" }),
      });
    }

    return model;
  }

  const isReasoningModel =
    modelId.includes("reasoning") || modelId.endsWith("-thinking");

  if (isReasoningModel) {
    const gatewayModelId = modelId.replace(THINKING_SUFFIX_REGEX, "");

    return wrapLanguageModel({
      model: gateway.languageModel(gatewayModelId),
      middleware: extractReasoningMiddleware({ tagName: "thinking" }),
    });
  }

  return gateway.languageModel(modelId);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  // Use OpenAI-compatible provider for title generation instead of AI Gateway
  return openaiCompatible("gemini-3.1-flash-lite");
}

export function getArtifactModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("artifact-model");
  }
  // Use OpenAI-compatible provider for artifact generation instead of AI Gateway
  return openaiCompatible("gemini-3.1-flash-lite");
}
