import { streamText, stepCountIs } from 'ai';
import { model } from './model';
import { getTools } from './tools';

export async function agent(message: string) {
  const tools = await getTools();

  const stream = streamText({
    model,
    tools,
    prompt: message,
    system: `You are a helpful assistant with Python code execution capabilities.

You have access to a pythonRunner tool that executes Python code in a secure sandbox.
Use it for data analysis, calculations, and algorithm validation.
Always execute code when it helps answer accurately.`,
    stopWhen: stepCountIs(50)
  });

  for (const chunk of await stream.text) {
    process.stdout.write(chunk);
  }

  console.log('\n');
  return stream.finishReason;
}
