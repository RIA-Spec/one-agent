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
  applyAnswers: (answers: JevAnswers) => unknown;
};

export type ResolvedJevBackend = {
  kind: "jev";
  provider: JevProvider;
  apiKey: string;
  baseURL: string;
  modelId: string;
};
