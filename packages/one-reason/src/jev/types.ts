/** TypeSafe System One question types (native API). */
export type TypesafeQuestionType = "noul" | "choice" | "score";

/** Vercel AI Gateway evaluation question types. */
export type GatewayQuestionType = "boolean" | "choice" | "score";

export type JevProvider = "typesafe" | "gateway";

export type ScoreRange = {
  min: number;
  max: number;
};

/** A choice option accepted by the `$jev: "choice"` example marker. */
export type JevChoiceOption = string | { id: string; description?: string };

/** Choice criteria can be written as a list, map, or `a|b|c` shorthand. */
export type JevChoiceCriteria =
  | string
  | readonly JevChoiceOption[]
  | Record<string, string | null | undefined>;

/** Explicit Jev schema marker for boolean / noul questions. */
export type JevNoulMarker = {
  $jev: "noul" | "boolean";
  instructions?: string;
  criteria?: { true?: string; false?: string };
  value?: boolean;
  example?: boolean;
};

/** Explicit Jev schema marker for finite choices. */
export type JevChoiceMarker = {
  $jev: "choice";
  instructions?: string;
  options?: JevChoiceCriteria;
  criteria?: JevChoiceCriteria;
  value?: string;
  example?: string;
};

/** Explicit Jev schema marker for score questions and optional numeric ranges. */
export type JevScoreMarker = {
  $jev: "score";
  instructions?: string;
  range?: readonly [number, number];
  levels?: number;
  criteria?: readonly string[];
  value?: number;
  example?: number;
};

/** Union of explicit `$jev` markers accepted inside a reason example. */
export type JevExampleMarker = JevNoulMarker | JevChoiceMarker | JevScoreMarker;

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
      scoreRange?: ScoreRange;
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
export type ReasonMode = "jev" | "llm";

/**
 * Optional third argument to `reason(prompt, example, options?)`.
 *
 * - omitted: preserve the historical LLM behavior (`mode: "llm"`).
 * - `mode: "jev"`: enable Jev routing for decision-shaped examples and fall
 *   back to LLM for free-text examples or when Jev is unavailable.
 * - `mode: "llm"`: always LLM streamText + submit_result (even if PROVIDER is Jev).
 */
export type ReasonOptions = {
  mode?: ReasonMode;
  /** Explicitly toggle Jev decision backend on/off (overrides ONE_REASON_JEV_ENABLED). */
  jevEnabled?: boolean;
  /** Evaluation state override (default: the `prompt` string). */
  state?: string | Record<string, unknown> | unknown[];
  /** Probability threshold for noul/boolean → boolean (default 0.5). */
  booleanThreshold?: number;
};
