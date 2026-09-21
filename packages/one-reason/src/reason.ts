import * as ai from "ai";
import {
  resolveInterfaceModel,
  resolveJevBackend,
  resolveLlmFallbackModel,
} from "./model.js";
import { reasonWithJev } from "./jev/reason-jev.js";
import { classifyExampleForJev } from "./jev/map-example.js";
import type { ReasonMode, ReasonOptions } from "./jev/types.js";
import {
  type AIResult,
  buildPrompt,
  compileAiResultValidator,
  errorsTextFromAjv,
  exampleToJsonSchema,
} from "./utils/schema.js";
import { getTracer } from "./tracing.js";
import { processStream } from "./utils/stream.js";

export type { ReasonMode, ReasonOptions } from "./jev/types.js";

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

function debugLog(message: string): void {
  if (process.env.ONE_REASON_VERBOSE === "1" || process.env.ONE_AGENT_DEBUG === "1") {
    console.error(`[one-reason] ${message}`);
  }
}

async function reasonWithLlm<T = any>(
  prompt: string,
  example: T,
  resolveModel: () => ReturnType<typeof resolveInterfaceModel>,
): Promise<AIResult<T>> {
  const { jsonSchema, stepCountIs, streamText, tool } = ai;
  const { validate, outputSchema } = compileAiResultValidator(example);
  const dataSchema = exampleToJsonSchema(example);

  let structuredOutput: AIResult<T> | null = null;
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
      const output = result as AIResult<T>;
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

  const resolved = await resolveModel();
  const result = streamText({
    model: resolved.model,
    providerOptions: resolved.providerOptions,
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

/**
 * Bounded local judgment: turn prompt text + a required JSON example shape into
 * structured output.
 *
 * In `jev` mode, a configured Jev backend handles decision-shaped examples
 * (boolean / choice / score / `$jev`), while summary / free-text examples use
 * the LLM `streamText` path. The default `llm` mode preserves historical behavior.
 */
export async function reason<T = any>(
  prompt: string,
  example: T,
  options: ReasonOptions = {},
): Promise<AIResult<T>> {
  const envMode = (
    process.env.ONE_REASON_MODE ??
    process.env.ONE_MODE
  )?.toLowerCase() as ReasonMode | undefined;
  // Preserve the historical LLM behavior unless callers opt into Jev routing.
  const mode: ReasonMode = options.mode ?? envMode ?? "llm";
  const jevBackend =
    mode === "jev"
      ? resolveJevBackend("reason", { jevEnabled: options.jevEnabled })
      : null;

  if (mode === "llm") {
    return reasonWithLlm(prompt, example, () =>
      resolveInterfaceModel("reason", "gemini-3.1-flash-lite"),
    );
  }

  if (mode === "jev") {
    if (!jevBackend) {
      debugLog('mode=jev: Jev unavailable → LLM fallback');
      return reasonWithLlm(prompt, example, () =>
        resolveInterfaceModel("reason", "gemini-3.1-flash-lite"),
      );
    }
    const classified = classifyExampleForJev(example);
    if (classified.kind === "llm-synthesis") {
      debugLog(`mode=jev: ${classified.reason} → LLM fallback`);
      return reasonWithLlm(prompt, example, () =>
        resolveLlmFallbackModel("reason", "gemini-3.1-flash-lite"),
      );
    }
    debugLog(`mode=jev: decision-shaped example → Jev (${jevBackend.provider})`);
    return reasonWithJev(prompt, example, jevBackend, options);
  }

  return reasonWithLlm(prompt, example, () =>
    resolveInterfaceModel("reason", "gemini-3.1-flash-lite"),
  );
}
