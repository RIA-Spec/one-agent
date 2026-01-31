import { wrapLanguageModel, gateway, type LanguageModel } from 'ai';
import { devToolsMiddleware } from '@ai-sdk/devtools';

export const model: LanguageModel = wrapLanguageModel({
  model: gateway('moonshotai/kimi-k2.5'),
  middleware: devToolsMiddleware(),
});
