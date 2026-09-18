import type { AIResult } from "../utils/schema.js";
import { evaluateJev, JevHttpError } from "./client.js";
import {
  classifyExampleForJev,
  mapExampleToQuestions,
  mapExplicitQuestions,
} from "./map-example.js";
import type { ReasonOptions, ResolvedJevBackend } from "./types.js";

function formatState(state: ReasonOptions["state"], prompt: string): string {
  if (state === undefined) return prompt;
  if (typeof state === "string") return state;
  return JSON.stringify(state);
}

/**
 * Run `reason(prompt, example)` through TypeSafe Jev / AI Gateway evaluation
 * instead of streamText + submit_result.
 *
 * `prompt` (or `options.state`) becomes the evaluation `state`. Questions come
 * from `options.questions` when provided, otherwise from `example`
 * (see map-example.ts). Answers are mapped back into an example-shaped `data`.
 */
export async function reasonWithJev<T = unknown>(
  prompt: string,
  example: T,
  backend: ResolvedJevBackend,
  options: ReasonOptions = {},
): Promise<AIResult<T>> {
  try {
    const mapped = options.questions
      ? mapExplicitQuestions(example, options.questions)
      : mapExampleToQuestions(example);

    if (!options.questions) {
      const classified = classifyExampleForJev(example);
      if (classified.kind === "llm-synthesis") {
        throw new Error(
          `Jev cannot synthesize free-text / summary fields (${classified.reason}). ` +
            `Use mode: "llm" (or auto-fallback), or pass explicit options.questions for decision fields only.`,
        );
      }
    }

    const answers = await evaluateJev({
      backend,
      state: formatState(options.state, prompt),
      questions: mapped.questions,
    });
    const data = mapped.applyAnswers(answers, options.booleanThreshold ?? 0.5) as T;
    return { data, error: null };
  } catch (error) {
    if (error instanceof JevHttpError) {
      return { data: null, error: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { data: null, error: `Jev reason() failed: ${message}` };
  }
}
