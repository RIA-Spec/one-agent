import * as ai from "ai";
import { resolveInterfaceModel } from "./model.js";
import {
  type AIResult,
  buildPrompt,
  compileAiResultValidator,
  errorsTextFromAjv,
  exampleToJsonSchema,
} from "./utils/schema.js";
import { getTracer } from "./tracing.js";
import { processStream } from "./utils/stream.js";

type SubmitToolResult = {
  toolName?: string;
  output?: unknown;
};

type StreamStep = {
  toolResults?: SubmitToolResult[];
};

function hasSubmittedResult(steps: StreamStep[] | undefined): boolean {
  if (!Array.isArray(steps)) return false;

  return steps.some((step) =>
    Array.isArray(step.toolResults)
      ? step.toolResults.some(
          (result) => result.toolName === "submit_result" && result.output === "submitted",
        )
      : false,
  );
}

export async function reason(prompt: string, example: unknown): Promise<AIResult> {
  const { jsonSchema, stepCountIs, streamText, tool } = ai;
  const { validate, outputSchema } = compileAiResultValidator(example);
  const dataSchema = exampleToJsonSchema(example);

  let structuredOutput: AIResult | null = null;
  let lastValidationError = "";

  const submitTool = tool({
    description: "Submit the bounded local judgment for this reason() call as structured data.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        data: dataSchema,
      },
      required: ["data"],
    }),
    execute: (result: unknown) => {
      const output = result as AIResult;
      if (validate(result)) {
        structuredOutput = { ...output, error: null };
        return "submitted";
      }
      lastValidationError = errorsTextFromAjv(validate.errors);
      throw new Error(`submit_result validation failed: ${lastValidationError}`);
    },
  });
  const tools = {
    submit_result: submitTool,
  };

  const hasSuccessfullySubmitted = ({ steps }: { steps?: StreamStep[] }) => {
    return hasSubmittedResult(steps);
  };

  const resolved = await resolveInterfaceModel("reason", "gemini-3.1-flash-lite");
  const result = streamText({
    model: resolved.model,
    prompt: buildPrompt(prompt, example, outputSchema),
    experimental_telemetry: {
      isEnabled: true,
      functionId: "functions.reason.streamText",
      tracer: getTracer("one-reason"),
      metadata: {
        functionType: "structured-output",
        modelProvider: resolved.provider,
      },
    },
    system: `You are an isolated local regulator inside a Reason-able Action Space. Return structured data using the submit_result tool.

Rules:
  - Treat the prompt as the complete local context; do not assume hidden memory
  - Convert the goal, observation, context, and constraints in the prompt into one bounded structured judgment
  - Call submit_result with data matching the expected schema
  - If validation fails, read the error message carefully and retry with corrected data
  - The data structure must match the example provided in the prompt`,
    tools,
    stopWhen: [stepCountIs(10), hasSuccessfullySubmitted],
  });

  try {
    if (process.env.ONE_REASON_VERBOSE === "1") {
      await processStream(result, "reason");
    }
    const text = await result.text;
    const toolResults = await result.toolResults;
    const finishReason = await result.finishReason;

    if (structuredOutput) return structuredOutput;

    const toolCallSummary = toolResults.length
      ? ` Tool calls: ${toolResults.map((toolResult) => String(toolResult.toolName)).join(", ")}.`
      : "";

    return {
      data: null,
      error:
        `Error: reason() failed to produce schema-valid output. finishReason: ${finishReason}.` +
        (lastValidationError ? ` Last validation error: ${lastValidationError}.` : "") +
        (text ? ` Raw output: ${text}.` : "") +
        toolCallSummary,
    };
  } finally {
    await resolved.cleanup?.();
  }
}
