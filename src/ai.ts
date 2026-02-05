import { jsonSchema, stepCountIs, type StopCondition, streamText, tool } from "ai";
import { venus, vercel } from "./model.js";
import {
  type AIResult,
  buildPrompt,
  compileAiResultValidator,
  errorsTextFromAjv,
  exampleToJsonSchema,
} from "./utils/schema.js";
import { writeFileSync } from "node:fs";
import { isDebugMode } from "./utils/env.js";

const submitToolName = "submit_result";

export async function ai(prompt: string, example: any): Promise<AIResult> {
  const { validate, outputSchema } = compileAiResultValidator(example);
  const dataSchema = exampleToJsonSchema(example);

  let structuredOutput: AIResult | null = null;
  let lastValidationError = "";

  const submitTool = tool({
    description:
      "Submit structured results, analysis outputs, extracted data, or final conclusions.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        data: dataSchema,
      },
      required: ["data"],
    }),
    execute: (result) => {
      const output = result as AIResult;
      if (validate(result)) {
        structuredOutput = output;
        return `submitted`;
      }
      lastValidationError = errorsTextFromAjv(validate.errors);
      throw new Error(`submit_result validation failed: ${lastValidationError}`);
    },
  });
  const tools = {
    [submitToolName]: submitTool,
  };

  const hasSuccessfullySubmitted: StopCondition<typeof tools> = ({ steps }) => {
    const successfulRes = steps.find((step) =>
      step.toolResults.find((res) => res.toolName === submitToolName && res.output === "submitted"),
    );
    return Boolean(successfulRes);
  };

  const result = streamText({
    model: vercel("anthropic/claude-haiku-4.5"),
    prompt: buildPrompt(prompt, example, outputSchema),
    system: `You process requests and return structured data using the ${submitToolName} tool.

Rules:
- Call ${submitToolName} with data matching the expected schema, when it fails, correct and resubmit.
- The data structure must match the example provided in the prompt`,
    tools: { [submitToolName]: submitTool },
    toolChoice: { type: "tool", toolName: submitToolName },
    stopWhen: [stepCountIs(10), hasSuccessfullySubmitted],
  });

  const text = await result.text;
  const toolCalls = await result.toolCalls;
  const finishReason = await result.finishReason;

  if (isDebugMode) {
    writeFileSync(
      `/tmp/ai-debug-output-${Date.now()}.json`,
      JSON.stringify({ steps: await result.steps, example }, null, 2),
    );
  }

  if (structuredOutput) return structuredOutput;

  return {
    data: null,
    error:
      `Error: get structured output failed. finishReason: ${finishReason}.` +
      (lastValidationError ? ` Last validation error: ${lastValidationError}.` : "") +
      (text
        ? ` Raw output: ${text}.`
        : "" + toolCalls
          ? `Tool calls: ${toolCalls.map((t) => t.toolName).join(", ")}`
          : ""),
  };
}
