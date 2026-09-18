import type { JevAnswers, JevQuestion, JevQuestions, MappedQuestions } from "./types.js";

const CHOICE_SEP = "|";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJevMarker(value: unknown): value is Record<string, unknown> & { $jev: string } {
  return isPlainObject(value) && typeof value.$jev === "string";
}

function fieldInstructions(path: string, override?: unknown): string {
  if (typeof override === "string" && override.trim()) return override.trim();
  const label = path || "result";
  return `Decide the value for \`${label}\` based on the provided state.`;
}

function parseChoiceCriteria(raw: unknown): Record<string, string | null> {
  if (Array.isArray(raw)) {
    const criteria: Record<string, string | null> = {};
    for (const item of raw) {
      if (typeof item === "string" && item.trim()) {
        criteria[item.trim()] = null;
      } else if (isPlainObject(item) && typeof item.id === "string") {
        criteria[item.id] = typeof item.description === "string" ? item.description : null;
      }
    }
    return criteria;
  }
  if (isPlainObject(raw)) {
    const criteria: Record<string, string | null> = {};
    for (const [key, desc] of Object.entries(raw)) {
      criteria[key] = desc == null ? null : String(desc);
    }
    return criteria;
  }
  if (typeof raw === "string") {
    const criteria: Record<string, string | null> = {};
    for (const part of raw.split(CHOICE_SEP)) {
      const option = part.trim();
      if (option) criteria[option] = null;
    }
    return criteria;
  }
  throw new Error(`Invalid choice criteria for Jev mapping: ${JSON.stringify(raw)}`);
}

function parseScoreCriteria(raw: unknown, fallbackLevels: number): string[] {
  if (Array.isArray(raw) && raw.length >= 2) {
    return raw.map((item) => String(item));
  }
  const levels = Math.min(10, Math.max(2, fallbackLevels));
  return Array.from({ length: levels }, (_, i) => `level ${i}`);
}

function questionFromExplicit(
  path: string,
  marker: Record<string, unknown>,
): { question: JevQuestion; exampleValue: unknown } {
  const kind = String(marker.$jev).toLowerCase();
  const instructions = fieldInstructions(path, marker.instructions);
  const exampleValue = marker.value ?? marker.example;

  if (kind === "noul" || kind === "boolean" || kind === "bool") {
    let criteria: { true?: string; false?: string } | undefined;
    if (
      isPlainObject(marker.criteria) &&
      ("true" in marker.criteria || "false" in marker.criteria)
    ) {
      criteria = {
        ...(marker.criteria.true != null ? { true: String(marker.criteria.true) } : {}),
        ...(marker.criteria.false != null ? { false: String(marker.criteria.false) } : {}),
      };
    }
    return {
      question: {
        type: "noul",
        instructions,
        ...(criteria ? { criteria } : {}),
      },
      exampleValue: typeof exampleValue === "boolean" ? exampleValue : false,
    };
  }

  if (kind === "choice") {
    const criteria = parseChoiceCriteria(marker.criteria ?? marker.options);
    if (Object.keys(criteria).length < 2) {
      throw new Error(`Jev choice at \`${path}\` needs at least 2 options (criteria/options).`);
    }
    return {
      question: { type: "choice", instructions, criteria },
      exampleValue: typeof exampleValue === "string" ? exampleValue : Object.keys(criteria)[0],
    };
  }

  if (kind === "score") {
    const fallback =
      typeof exampleValue === "number" && Number.isFinite(exampleValue)
        ? Math.ceil(Math.abs(exampleValue)) + 1
        : 3;
    const criteria = parseScoreCriteria(marker.criteria, fallback);
    return {
      question: { type: "score", instructions, criteria },
      exampleValue: typeof exampleValue === "number" ? exampleValue : 0,
    };
  }

  throw new Error(
    `Unknown $jev type "${marker.$jev}" at \`${path}\`. Expected noul|boolean|choice|score.`,
  );
}

function questionFromInferred(
  path: string,
  value: unknown,
): { question: JevQuestion | null; passthrough: unknown } {
  if (typeof value === "boolean") {
    return {
      question: { type: "noul", instructions: fieldInstructions(path) },
      passthrough: value,
    };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const levels = Math.min(10, Math.max(3, Math.ceil(Math.abs(value)) + 1));
    return {
      question: {
        type: "score",
        instructions: fieldInstructions(path),
        criteria: parseScoreCriteria(undefined, levels),
      },
      passthrough: value,
    };
  }

  if (typeof value === "string") {
    if (value.includes(CHOICE_SEP)) {
      const criteria = parseChoiceCriteria(value);
      if (Object.keys(criteria).length >= 2) {
        return {
          question: {
            type: "choice",
            instructions: fieldInstructions(path),
            criteria,
          },
          passthrough: Object.keys(criteria)[0],
        };
      }
    }
    // Free-text string: Jev cannot emit arbitrary text — keep example value.
    return { question: null, passthrough: value };
  }

  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((item) => typeof item === "string")
  ) {
    const criteria = parseChoiceCriteria(value);
    return {
      question: {
        type: "choice",
        instructions: fieldInstructions(path),
        criteria,
      },
      passthrough: value[0],
    };
  }

  return { question: null, passthrough: value };
}

type LeafPlan =
  | { kind: "question"; path: string; question: JevQuestion; exampleValue: unknown }
  | { kind: "passthrough"; path: string; value: unknown };

function collectLeaves(value: unknown, path: string, out: LeafPlan[]): void {
  if (isJevMarker(value)) {
    const mapped = questionFromExplicit(path || "$", value);
    out.push({
      kind: "question",
      path: path || "$",
      question: mapped.question,
      exampleValue: mapped.exampleValue,
    });
    return;
  }

  if (Array.isArray(value)) {
    if (value.length >= 2 && value.every((item) => typeof item === "string")) {
      const mapped = questionFromInferred(path || "$", value);
      if (mapped.question) {
        out.push({
          kind: "question",
          path: path || "$",
          question: mapped.question,
          exampleValue: mapped.passthrough,
        });
        return;
      }
    }
    value.forEach((item, index) => {
      const childPath = path ? `${path}.${index}` : String(index);
      collectLeaves(item, childPath, out);
    });
    return;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      out.push({ kind: "passthrough", path: path || "$", value });
      return;
    }
    for (const [key, child] of entries) {
      const childPath = path ? `${path}.${key}` : key;
      collectLeaves(child, childPath, out);
    }
    return;
  }

  const mapped = questionFromInferred(path || "$", value);
  if (mapped.question) {
    out.push({
      kind: "question",
      path: path || "$",
      question: mapped.question,
      exampleValue: mapped.passthrough,
    });
  } else {
    out.push({ kind: "passthrough", path: path || "$", value: mapped.passthrough });
  }
}

function setAtPath(root: unknown, path: string, value: unknown): unknown {
  if (path === "$" || path === "") return value;

  const parts = path.split(".");
  const clone: Record<string, unknown> | unknown[] = Array.isArray(root)
    ? [...root]
    : isPlainObject(root)
      ? { ...root }
      : {};

  let cursor: any = clone;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    const nextIsIndex = /^\d+$/.test(nextPart);
    const existing = cursor[part];
    if (existing == null || typeof existing !== "object") {
      cursor[part] = nextIsIndex ? [] : {};
    } else if (Array.isArray(existing)) {
      cursor[part] = [...existing];
    } else {
      cursor[part] = { ...existing };
    }
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
  return clone;
}

function answerToValue(
  question: JevQuestion,
  answer: JevAnswers[string] | undefined,
  fallback: unknown,
): unknown {
  if (!answer) return fallback;

  if (question.type === "noul" || question.type === "boolean") {
    if (answer.type === "noul") return answer.noul >= 0.5;
    if (answer.type === "boolean") return answer.probability >= 0.5;
    return fallback;
  }

  if (question.type === "choice") {
    if (answer.type === "choice") return answer.choice;
    return fallback;
  }

  if (question.type === "score") {
    if (answer.type === "score") return answer.score;
    return fallback;
  }

  return fallback;
}

/**
 * Derive Jev questions from a `reason(prompt, example)` example value.
 *
 * Mapping rules:
 * - `boolean` → noul/boolean
 * - `number` → score (criteria auto-generated as `level 0` .. `level N`)
 * - `string` with `|` separators, or `string[]` → choice
 * - plain `string` → passthrough (kept as example; Jev cannot emit free text)
 * - explicit marker:
 *   `{ "$jev": "noul"|"choice"|"score", "instructions"?, "criteria"?, "value"? }`
 *
 * Nested objects are flattened to dotted question ids and rebuilt into the
 * example shape when answers are applied.
 */
export function mapExampleToQuestions(example: unknown): MappedQuestions {
  const leaves: LeafPlan[] = [];
  collectLeaves(example, "", leaves);

  const questions: JevQuestions = {};
  for (const leaf of leaves) {
    if (leaf.kind === "question") {
      questions[leaf.path] = leaf.question;
    }
  }

  if (Object.keys(questions).length === 0) {
    throw new Error(
      "TypeSafe/Gateway Jev provider could not derive any questions from the example. " +
        "Use booleans, numbers, pipe-separated choice strings (a|b|c), string arrays, " +
        'or explicit { "$jev": "noul"|"choice"|"score", ... } markers.',
    );
  }

  return {
    questions,
    applyAnswers(answers: JevAnswers) {
      let data: unknown = structuredClone(example);
      for (const leaf of leaves) {
        if (leaf.kind === "passthrough") {
          data = setAtPath(data, leaf.path, leaf.value);
          continue;
        }
        const value = answerToValue(leaf.question, answers[leaf.path], leaf.exampleValue);
        data = setAtPath(data, leaf.path, value);
      }
      return data;
    },
  };
}

/** Convert internal questions to TypeSafe wire format (`noul`). */
export function toTypesafeQuestions(questions: JevQuestions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul" || question.type === "boolean") {
      out[id] = {
        type: "noul",
        instructions: question.instructions,
        ...(question.criteria
          ? {
              criteria: {
                ...(question.criteria.true != null ? { true: question.criteria.true } : {}),
                ...(question.criteria.false != null ? { false: question.criteria.false } : {}),
              },
            }
          : {}),
      };
      continue;
    }
    out[id] = {
      type: question.type,
      instructions: question.instructions,
      criteria: question.criteria,
    };
  }
  return out;
}

/** Convert internal questions to Gateway wire format (`boolean`). */
export function toGatewayQuestions(questions: JevQuestions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul" || question.type === "boolean") {
      out[id] = {
        type: "boolean",
        instructions: question.instructions,
        ...(question.criteria
          ? {
              criteria: {
                ...(question.criteria.true != null ? { true: question.criteria.true } : {}),
                ...(question.criteria.false != null ? { false: question.criteria.false } : {}),
              },
            }
          : {}),
      };
      continue;
    }
    out[id] = {
      type: question.type,
      instructions: question.instructions,
      criteria: question.criteria,
    };
  }
  return out;
}
