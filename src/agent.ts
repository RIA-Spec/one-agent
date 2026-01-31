import { streamText, stepCountIs, jsonSchema, tool } from 'ai';
import { model } from './model';
import { getServer } from './tools';
import { convertToAISDKTools } from '@mcpc-tech/core'

export async function agent(message: string) {
  const tools = convertToAISDKTools((await getServer()), {
    tool: tool,
    jsonSchema: jsonSchema,
  })

  const result = streamText({
    model,
    tools,
    prompt: message,
    system: `You are a helpful assistant with Python code execution capabilities.`,
    stopWhen: stepCountIs(101)
  });

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case 'text-delta':
        process.stdout.write(chunk.text);
        break;
      case 'tool-call':
        console.log(`\n[Tool: ${chunk.toolName}]`);
        console.log(`[Args]: ${JSON.stringify(chunk.input, null, 2)}`);
        break;
      case 'tool-result':
        console.log(`[Result]: ${JSON.stringify(chunk.output, null, 2)}`);
        break;
      case 'error':
        console.error(`[Error]: ${chunk.error}`);
        break;
    }
  }

  console.log('\n');
  return result.finishReason;
}
