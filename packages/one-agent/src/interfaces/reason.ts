import { jsonSchema, stepCountIs, type StopCondition, streamText, tool } from "ai";
import { venus } from "../model.js";
import {
  type AIResult,
  buildPrompt,
  compileAiResultValidator,
  errorsTextFromAjv,
  exampleToJsonSchema,
} from "../utils/schema.js";
import { getTracer } from "../tracing.js";
import { processStream } from "../utils/stream.js";

export async function reason(prompt: string, example: any): Promise<AIResult> {
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
        structuredOutput = { ...output, error: null };
        return `submitted`;
      }
      lastValidationError = errorsTextFromAjv(validate.errors);
      throw new Error(`submit_result validation failed: ${lastValidationError}`);
    },
  });
  const tools = {
    submit_result: submitTool,
  };

  const hasSuccessfullySubmitted: StopCondition<typeof tools> = ({ steps }) => {
    const successfulRes = steps.find((step) =>
      step.toolResults.find(
        (res) => res.toolName === "submit_result" && res.output === "submitted",
      ),
    );
    return Boolean(successfulRes);
  };

  const result = streamText({
    model: venus("gemini-3.1-flash-lite"),
    prompt: buildPrompt(prompt, example, outputSchema),
    experimental_telemetry: {
      isEnabled: true,
      functionId: "functions.reason.streamText",
      tracer: getTracer("one-agent-aer-ai"),
      metadata: {
        functionType: "structured-output",
        modelProvider: "deepseek",
      },
    },
    system: `You process requests and return structured data using the submit_result tool.

Rules:
- Call submit_result with data matching the expected schema
- If validation fails, read the error message carefully and retry with corrected data
- The data structure must match the example provided in the prompt`,
    tools: { submit_result: submitTool },
    stopWhen: [stepCountIs(10), hasSuccessfullySubmitted],
  });

  await processStream(result, "reason");
  const text = await result.text;
  const toolResults = await result.toolResults;
  const finishReason = await result.finishReason;

  if (structuredOutput) return structuredOutput;

  return {
    data: null,
    error:
      `Error: get structured output failed. finishReason: ${finishReason}.` +
      (lastValidationError ? ` Last validation error: ${lastValidationError}.` : "") +
      (text
        ? ` Raw output: ${text}.`
        : "" + toolResults
          ? `Tool calls: ${toolResults.map((t) => t.toolName).join(", ")}`
          : ""),
  };
}
