import { wrapLanguageModel, gateway, type LanguageModel } from 'ai';
import { devToolsMiddleware } from '@ai-sdk/devtools';

export const model: LanguageModel = wrapLanguageModel({
  model: gateway('deepseek/deepseek-v3.2'),
  middleware: devToolsMiddleware(),
});
