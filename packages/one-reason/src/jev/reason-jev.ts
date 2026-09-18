import type { AIResult } from "../utils/schema.js";
import { evaluateJev, JevHttpError } from "./client.js";
import { mapExampleToQuestions } from "./map-example.js";
import type { ResolvedJevBackend } from "./types.js";

/**
 * Run `reason(prompt, example)` through TypeSafe Jev / AI Gateway evaluation
 * instead of streamText + submit_result.
 *
 * `prompt` becomes the evaluation `state`. Questions are derived from `example`
 * (see map-example.ts). Answers are mapped back into an example-shaped `data`.
 */
export async function reasonWithJev<T = unknown>(
  prompt: string,
  example: T,
  backend: ResolvedJevBackend,
): Promise<AIResult<T>> {
  try {
    const mapped = mapExampleToQuestions(example);
    const answers = await evaluateJev({
      backend,
      state: prompt,
      questions: mapped.questions,
    });
    const data = mapped.applyAnswers(answers) as T;
    return { data, error: null };
  } catch (error) {
    if (error instanceof JevHttpError) {
      return { data: null, error: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { data: null, error: `Jev reason() failed: ${message}` };
  }
}
