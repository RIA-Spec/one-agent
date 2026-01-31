import { generateText, stepCountIs } from 'ai';
import { model } from './model.js';

export async function ai(message: string): Promise<string> {
  const result = await generateText({
    model: model,
    prompt: message,
    system: `You are a helpful assistant.`,
    stopWhen: stepCountIs(10) ,
  });
  return result.text;
}
