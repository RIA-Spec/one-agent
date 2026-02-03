import { streamText, stepCountIs, tool, type StopCondition } from 'ai';
import { z } from 'zod';
import { venus, vercel } from './model.js';
import { type AIResult, buildPrompt, compileAiResultValidator, errorsTextFromAjv } from './ai-utils.js';
import { writeFileSync } from 'node:fs';

const isDebugMode = process.env.DEBUG === '1'

export async function ai(prompt: string, example: any): Promise<AIResult> {
  const { validate, outputSchema } = compileAiResultValidator(example);

  let structuredOutput: AIResult | null = null;
  let lastValidationError = '';

  const submitTool = tool({
    description: 'Submit structured results, analysis outputs, extracted data, or final conclusions.',
    inputSchema: z.object({
      data: z.object({
        value: z.any().describe('The actual data payload that matches the expected schema')
      }).describe('Wrapper object containing the value field with your structured data'),
      text: z.string().describe('Context-aware text for response or explanation')
    }),
    execute: (result) => {
      // Unwrap the data.value structure
      const unwrapped = {
        data: result.data.value,
        text: result.text
      } as AIResult;

      if (validate(unwrapped)) {
        structuredOutput = unwrapped;
        return `submitted`;
      }
      lastValidationError = errorsTextFromAjv(validate.errors);
      throw new Error(`submit_result validation failed: ${lastValidationError}`);
    },
  });
  const tools = {
    submit_result: submitTool
  }

  const hasSuccessfullySubmitted: StopCondition<typeof tools> = ({ steps }) => {
    const successfulRes = steps.find(step => step.toolResults.find(res =>
      res.toolName === 'submit_result' &&
      res.output === 'submitted'
    ))
    return Boolean(successfulRes)
  };

  const result = streamText({
    model: vercel('anthropic/claude-haiku-4.5'),
    prompt: buildPrompt(prompt, example, outputSchema),
    system: `You process requests and return structured data using the submit_result tool.

Format:
{
  "data": {"value": <your_result>},
  "text": "brief explanation"
}

Rules:
- Call submit_result exactly once
- data.value must match the example structure
- Keep text concise`,
    tools: { submit_result: submitTool },
    stopWhen: [
      stepCountIs(10),
      hasSuccessfullySubmitted
    ],
  });

  const text = await result.text
  const toolCalls = await result.toolCalls
  const finishReason = await result.finishReason

  if (isDebugMode) {
    writeFileSync(`/tmp/ai-debug-output-${Date.now()}.json`, JSON.stringify({ steps: await result.steps, example }, null, 2));
  }

  if (structuredOutput) return structuredOutput;

  return {
    data: null,
    text: `Error: get structured output failed. finishReason: ${finishReason}.` +
      (lastValidationError ? ` Last validation error: ${lastValidationError}.` : '') +
      (text ? ` Raw output: ${text}.` : '' +
        toolCalls ? `Tool calls: ${(toolCalls.map(t => t.toolName)).join(', ')}` : ''
      ),
  };
}

