import * as ai from "ai";
import {
  resolveInterfaceModel,
  resolveJevBackend,
  resolveLlmFallbackModel,
} from "./model.js";
import { reasonWithJev } from "./jev/reason-jev.js";
import { classifyExampleForJev } from "./jev/map-example.js";
import type { ReasonOptions } from "./jev/types.js";
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
 * When PROVIDER is `typesafe` or `gateway`, decision-shaped examples (boolean /
 * choice / score / `$jev`) use Jev. Summary / free-text synthesis examples
 * auto-fall back to the LLM `streamText` path (see `options.mode`).
 */
export async function reason<T = any>(
  prompt: string,
  example: T,
  options: ReasonOptions = {},
): Promise<AIResult<T>> {
  const mode = options.mode ?? "auto";
  const jevBackend = resolveJevBackend("reason");

  if (mode === "llm") {
    if (jevBackend) {
      debugLog(
        `mode=llm: using LLM fallback despite Jev provider "${jevBackend.provider}"`,
      );
      return reasonWithLlm(prompt, example, () =>
        resolveLlmFallbackModel("reason", "gemini-3.1-flash-lite"),
      );
    }
    return reasonWithLlm(prompt, example, () =>
      resolveInterfaceModel("reason", "gemini-3.1-flash-lite"),
    );
  }

  if (mode === "jev") {
    if (!jevBackend) {
      return {
        data: null,
        error:
          'reason() mode is "jev" but PROVIDER is not typesafe|gateway. ' +
          "Set ONE_REASON_PROVIDER=typesafe or gateway, or use mode: \"auto\"|\"llm\".",
      };
    }
    if (!options.questions) {
      const classified = classifyExampleForJev(example);
      if (classified.kind === "llm-synthesis") {
        return {
          data: null,
          error:
            `reason() mode is "jev" but the example is not decision-shaped (${classified.reason}). ` +
            "Jev only returns noul/choice/score probabilities — it cannot generate free-text summaries. " +
            'Pass options.questions for explicit decision fields, use mode: "llm", or mode: "auto" for LLM fallback.',
        };
      }
    }
    return reasonWithJev(prompt, example, jevBackend, options);
  }

  // mode === "auto"
  if (jevBackend) {
    if (options.questions) {
      debugLog(`mode=auto: explicit questions → Jev (${jevBackend.provider})`);
      return reasonWithJev(prompt, example, jevBackend, options);
    }
    const classified = classifyExampleForJev(example);
    if (classified.kind === "jev-decision") {
      debugLog(`mode=auto: decision-shaped example → Jev (${jevBackend.provider})`);
      return reasonWithJev(prompt, example, jevBackend, options);
    }
    debugLog(
      `mode=auto: ${classified.reason} → LLM fallback (Jev cannot synthesize free text)`,
    );
    return reasonWithLlm(prompt, example, () =>
      resolveLlmFallbackModel("reason", "gemini-3.1-flash-lite"),
    );
  }

  return reasonWithLlm(prompt, example, () =>
    resolveInterfaceModel("reason", "gemini-3.1-flash-lite"),
  );
}
