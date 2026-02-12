// Curated list of provider/model combinations used by ONE Agent
export const DEFAULT_CHAT_MODEL = "gemini-3-pro";
export const DEFAULT_REASONING_CHAT_MODEL = "gemini-3-pro";

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

export const chatModels: ChatModel[] = [
  // Venus (known working models)
  {
    id: "gemini-3-pro",
    name: "Gemini 3 Pro",
    provider: "venus",
    description: "Default ONE Agent model on Venus",
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    provider: "venus",
    description: "Fast ONE Agent model on Venus",
  },
];

export function isReasoningModelId(modelId: string) {
  return modelId.includes("reasoning") || modelId.includes("thinking");
}

export function normalizeChatModelId(modelId: string | null | undefined) {
  if (!modelId) {
    return DEFAULT_CHAT_MODEL;
  }

  if (modelId === "one-agent") {
    return DEFAULT_CHAT_MODEL;
  }

  if (modelId === "one-agent-reasoning") {
    return DEFAULT_REASONING_CHAT_MODEL;
  }

  if (chatModels.some((model) => model.id === modelId)) {
    return modelId;
  }

  return DEFAULT_CHAT_MODEL;
}

// Group models by provider for UI
export const modelsByProvider = chatModels.reduce(
  (acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  },
  {} as Record<string, ChatModel[]>
);
