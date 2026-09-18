import { toGatewayQuestions, toTypesafeQuestions } from "./map-example.js";
import type {
  GatewayAnswer,
  JevAnswers,
  JevQuestions,
  ResolvedJevBackend,
  TypesafeAnswer,
} from "./types.js";

export class JevHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, message: string, body: string) {
    super(message);
    this.name = "JevHttpError";
    this.status = status;
    this.body = body;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessageForStatus(status: number, bodyText: string): string {
  let detail = bodyText.trim();
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const message =
      (typeof parsed.message === "string" && parsed.message) ||
      (typeof parsed.error === "string" && parsed.error) ||
      (typeof (parsed.error as { message?: unknown } | undefined)?.message === "string"
        ? (parsed.error as { message: string }).message
        : undefined) ||
      (typeof parsed.detail === "string" && parsed.detail) ||
      (typeof parsed.error_type === "string" && parsed.error_type);
    if (message) detail = message;
  } catch {
    // keep raw body
  }

  switch (status) {
    case 401:
      return `Jev authentication failed (401). Check your API key. ${detail}`.trim();
    case 422:
      return `Jev request validation failed (422). ${detail}`.trim();
    case 429:
      return `Jev rate limited (429). ${detail}`.trim();
    case 529:
      return `Jev service overloaded (529). ${detail}`.trim();
    default:
      return `Jev request failed (${status}). ${detail}`.trim();
  }
}

async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  maxRetries = 2,
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const response = await fetchImpl(url, init);
    if (response.status !== 429 && response.status !== 529) {
      return response;
    }
    if (attempt >= maxRetries) {
      return response;
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt;
    await sleep(delayMs);
    attempt += 1;
  }
}

function normalizeTypesafeAnswers(raw: unknown): JevAnswers {
  if (!raw || typeof raw !== "object") {
    throw new Error("TypeSafe Jev response missing answers object");
  }
  const answers: JevAnswers = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const answer = value as Record<string, unknown>;
    if (answer.type === "noul" && typeof answer.noul === "number") {
      answers[id] = { type: "noul", noul: answer.noul } satisfies TypesafeAnswer;
      continue;
    }
    if (answer.type === "choice" && typeof answer.choice === "string") {
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        ...(answer.probabilities && typeof answer.probabilities === "object"
          ? { probabilities: answer.probabilities as Record<string, number> }
          : {}),
        ...(typeof answer.confidence === "number" ? { confidence: answer.confidence } : {}),
      };
      continue;
    }
    if (answer.type === "score" && typeof answer.score === "number") {
      answers[id] = {
        type: "score",
        score: answer.score,
        ...(answer.probabilities && typeof answer.probabilities === "object"
          ? { probabilities: answer.probabilities as Record<string, number> }
          : {}),
        ...(typeof answer.confidence === "number" ? { confidence: answer.confidence } : {}),
      };
      continue;
    }
    throw new Error(`Unexpected TypeSafe answer shape for "${id}": ${JSON.stringify(answer)}`);
  }
  return answers;
}

function normalizeGatewayAnswers(raw: unknown): JevAnswers {
  if (!raw || typeof raw !== "object") {
    throw new Error("Gateway Jev response missing answers object");
  }
  const answers: JevAnswers = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const answer = value as Record<string, unknown>;
    if (answer.type === "boolean" && typeof answer.probability === "number") {
      answers[id] = {
        type: "boolean",
        probability: answer.probability,
      } satisfies GatewayAnswer;
      continue;
    }
    if (answer.type === "choice" && typeof answer.choice === "string") {
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        ...(answer.probabilities && typeof answer.probabilities === "object"
          ? { probabilities: answer.probabilities as Record<string, number> }
          : {}),
      };
      continue;
    }
    if (answer.type === "score" && typeof answer.score === "number") {
      answers[id] = {
        type: "score",
        score: answer.score,
        ...(answer.probabilities && typeof answer.probabilities === "object"
          ? { probabilities: answer.probabilities as Record<string, number> }
          : {}),
      };
      continue;
    }
    throw new Error(`Unexpected Gateway answer shape for "${id}": ${JSON.stringify(answer)}`);
  }
  return answers;
}

export type EvaluateJevInput = {
  backend: ResolvedJevBackend;
  state: unknown;
  questions: JevQuestions;
  fetchImpl?: typeof fetch;
};

/**
 * Call TypeSafe System One (`POST {baseURL}/systemone`) or Vercel AI Gateway
 * evaluation (`POST {baseURL}/evaluation-model`) via fetch.
 */
export async function evaluateJev(input: EvaluateJevInput): Promise<JevAnswers> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this runtime");
  }

  const baseURL = stripTrailingSlash(input.backend.baseURL);
  const { provider, apiKey, modelId } = input.backend;

  if (provider === "typesafe") {
    const url = `${baseURL}/systemone`;
    const body = {
      model: modelId,
      state: input.state,
      questions: toTypesafeQuestions(input.questions),
    };
    const response = await fetchWithRetry(fetchImpl, url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new JevHttpError(response.status, errorMessageForStatus(response.status, text), text);
    }
    const json = JSON.parse(text) as { answers?: unknown };
    return normalizeTypesafeAnswers(json.answers);
  }

  // gateway — AI SDK GatewayEvaluationModel posts to `{baseURL}/evaluation-model`
  // with ai-evaluation-model-specification-version: 4 and ai-model-id headers.
  // Default baseURL: https://ai-gateway.vercel.sh/v4/ai
  const url = `${baseURL}/evaluation-model`;
  const body = {
    state: input.state,
    questions: toGatewayQuestions(input.questions),
  };
  const response = await fetchWithRetry(fetchImpl, url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": modelId,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new JevHttpError(response.status, errorMessageForStatus(response.status, text), text);
  }
  const json = JSON.parse(text) as { answers?: unknown };
  return normalizeGatewayAnswers(json.answers);
}
