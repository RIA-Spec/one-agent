import { streamText, stepCountIs } from 'ai';
import { model } from './model';
import { getTools } from './tools';

export async function agent(message: string) {
  const tools = await getTools();

  const result = streamText({
    model,
    tools,
    prompt: message,
    system: `You are a helpful assistant with Python code execution capabilities.

You have access to a pythonRunner tool that executes Python code in a secure sandbox.
Use it for data analysis, calculations, and algorithm validation.
Always execute code when it helps answer accurately.`,
    stopWhen: stepCountIs(50)
  });

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case 'text-delta':
        process.stdout.write(chunk.text);
        break;
      case 'tool-call':
        console.log(`\n[Tool: ${chunk.toolName}]`);
        break;
      case 'tool-result':
        console.log(`[Result]: ${chunk.output}`);
        break;
      case 'error':
        console.error(`[Error]: ${chunk.error}`);
        break;
    }
  }

  console.log('\n');
  return result.finishReason;
}
