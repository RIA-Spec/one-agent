/** TypeSafe System One question types (native API). */
export type TypesafeQuestionType = "noul" | "choice" | "score";

/** Vercel AI Gateway evaluation question types. */
export type GatewayQuestionType = "boolean" | "choice" | "score";

export type JevProvider = "typesafe" | "gateway";

export type JevQuestion =
  | {
      type: "noul" | "boolean";
      instructions: string;
      criteria?: { true?: string; false?: string };
    }
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string | null>;
    }
  | {
      type: "score";
      instructions: string;
      criteria: string[];
    };

export type JevQuestions = Record<string, JevQuestion>;

export type TypesafeAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities?: Record<string, number>;
      confidence?: number;
    }
  | {
      type: "score";
      score: number;
      probabilities?: Record<string, number>;
      confidence?: number;
      legend?: Record<string, string>;
    };

export type GatewayAnswer =
  | { type: "boolean"; probability: number }
  | {
      type: "choice";
      choice: string;
      probabilities?: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      probabilities?: Record<string, number>;
    };

export type JevAnswer = TypesafeAnswer | GatewayAnswer;
export type JevAnswers = Record<string, JevAnswer>;

export type MappedQuestions = {
  questions: JevQuestions;
  applyAnswers: (answers: JevAnswers, booleanThreshold?: number) => unknown;
};

export type ResolvedJevBackend = {
  kind: "jev";
  provider: JevProvider;
  apiKey: string;
  baseURL: string;
  modelId: string;
};

/** How `reason()` chooses between Jev evaluation and the LLM streamText path. */
export type ReasonMode = "auto" | "jev" | "llm";

/**
 * Optional third argument to `reason(prompt, example, options?)`.
 *
 * - `mode: "auto"` (default): use Jev when PROVIDER is typesafe|gateway and the
 *   example is decision-shaped (or `questions` is provided); otherwise LLM.
 * - `mode: "jev"`: always Jev (requires a Jev backend); errors if free-text
 *   cannot map and `questions` is not provided.
 * - `mode: "llm"`: always LLM streamText + submit_result (even if PROVIDER is Jev).
 */
export type ReasonOptions = {
  mode?: ReasonMode;
  /** Explicit Jev questions; when set, skip inference from `example` for Jev. */
  questions?: JevQuestions;
  /** Evaluation state override (default: the `prompt` string). */
  state?: string | Record<string, unknown> | unknown[];
  /** Probability threshold for noul/boolean → boolean (default 0.5). */
  booleanThreshold?: number;
};
