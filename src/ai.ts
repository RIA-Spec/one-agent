import { generateText, tool as defineTool, stepCountIs, hasToolCall, tool } from 'ai';
import { z } from 'zod';
import { model } from './model.js';

export interface AIResult {
  data: any,
  text: string
}

export async function ai(message: string): Promise<AIResult | null> {
  // Reset structured output
  let structuredOutput: AIResult | null = null;

  const result = await generateText({
    model: model,
    prompt: message,
    system: `You are a helpful AI assistant with the ability to:
- Summarize information concisely and extract key insights
- Make data-driven decisions and recommendations
- Structure unstructured data into organized formats
- Generate efficient, context-aware responses

When you need to return structured data (like analysis results, extracted information, or status reports), use the submit_result tool.`,
    tools: {
      submit_result: tool({
        description: 'Submit structured results, analysis outputs, extracted data, or final conclusions.ext.',
        inputSchema: z.object({
          data: z.any().optional().describe('The structured data to submit (objects, arrays, or any JSON-serializable data)'),
          text: z.string().describe('Context aware text for response or explanation')
        }),
        execute: (result) => {
          return result as AIResult
        }
      })
    },
    stopWhen: [stepCountIs(101), hasToolCall('submit_result')]
  });

  // Store structured output if tool was called
  const toolCalls = result.toolResults || [];
  for (const toolCall of toolCalls) {
    if (toolCall.toolName === 'submit_result' && toolCall.output) {
      structuredOutput = toolCall.output as AIResult
    }
  }

  return structuredOutput
}

