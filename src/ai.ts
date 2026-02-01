import { streamText, stepCountIs, tool, type StopCondition } from 'ai';
import { z } from 'zod';
import { venus } from './model.js';
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
      data: z.any().describe('The structured data to submit (must match the expected shape)'),
      text: z.string().describe('Context-aware text for response or explanation')
    }),
    execute: (result) => {
      const out = result as AIResult;
      if (validate(out)) {
        structuredOutput = out;
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
    model: venus('minimax-m2'),
    prompt: buildPrompt(prompt, example, outputSchema),
    system: `You are a helpful AI assistant with the ability to:
- Summarize information concisely and extract key insights
- Make data-driven decisions and recommendations
- Structure unstructured data into organized formats
- Generate efficient, context-aware responses

When you need to return structured data (like analysis results, extracted information, or status reports), use the \`submit_result\` tool.

IMPORTANT:
- You MUST call \`submit_result\` exactly once with a JSON payload.
- Do not output prose outside the tool call.
- The \`data\` field MUST validate against the provided JSON Schema.`,
    tools: { submit_result: submitTool },
    stopWhen: [
      stepCountIs(10),
      hasSuccessfullySubmitted
    ],
  });

  const text = await result.text
  const toolCalls = await result.toolCalls

  if (isDebugMode) {
    writeFileSync(`/tmp/ai-debug-output-${Date.now()}.json`, JSON.stringify(await result.steps, null, 2));
  }

  if (structuredOutput) return structuredOutput;

  return {
    data: null,
    text: `Error: get structured output failed. finishReason: ${result.finishReason}.` +
      (lastValidationError ? ` Last validation error: ${lastValidationError}.` : '') +
      (text ? ` Raw output: ${text}.` : '' +
        toolCalls ? `Tool calls: ${(toolCalls.map(t => t.toolName)).join(', ')}` : ''
      ),
  };
}

