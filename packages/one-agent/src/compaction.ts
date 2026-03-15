import { generateText, type LanguageModel, type ModelMessage } from "ai";

const TOKENS_PER_CHAR = 0.25;
const DEFAULT_MODEL_CONTEXT_WINDOW = 65_536;
const DEFAULT_AUTO_COMPACT_RATIO = 0.85;
const DEFAULT_RESERVED_TOKENS = 8_000;
const DEFAULT_TAIL_MESSAGES = 8;
const ESTIMATE_BASE_OVERHEAD_TOKENS = 2_000;
const ESTIMATE_SAFETY_MULTIPLIER = 1.35;
const CALIBRATION_ALPHA = 0.2;
const CALIBRATION_MIN = 0.7;
const CALIBRATION_MAX = 2.5;

let adaptiveMultiplier = 1;

const COMPACTION_PROMPT = `You are performing a context checkpoint compaction for a coding assistant conversation.

Create a concise but information-dense handoff summary so another assistant can continue seamlessly.

Include:
- User goal and required outcomes
- Constraints, instructions, and preferences that must be preserved
- Key decisions made and why
- Important findings and unresolved issues
- Relevant files, symbols, and commands touched
- Clear next steps

Return markdown with short sections and bullets. Avoid filler.`;

function contentToText(content: ModelMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part: any) => {
      if (typeof part === "string") {
        return part;
      }

      if (!part || typeof part !== "object") {
        return "";
      }

      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }

      if (typeof part.input === "string") {
        return part.input;
      }

      if (typeof part.output === "string") {
        return part.output;
      }

      // Fall back to serialized payload so non-text tool parts still count.
      return JSON.stringify(part);
    })
    .join("\n");
}

function estimateTokens(messages: ModelMessage[], system?: string): number {
  const chars = messages.reduce((sum, msg) => {
    const roleCost = msg.role.length + 4;
    return sum + roleCost + contentToText(msg.content).length;
  }, 0);

  const systemChars = typeof system === "string" ? system.length : 0;
  const rawEstimate = Math.ceil((chars + systemChars) * TOKENS_PER_CHAR);

  return Math.ceil(
    (rawEstimate + ESTIMATE_BASE_OVERHEAD_TOKENS) * ESTIMATE_SAFETY_MULTIPLIER * adaptiveMultiplier,
  );
}

export function recordCompactionUsageObservation(params: {
  messages: ModelMessage[];
  system?: string;
  observedInputTokens?: number;
}) {
  const { messages, system, observedInputTokens } = params;
  if (!Number.isFinite(observedInputTokens) || (observedInputTokens as number) <= 0) {
    return;
  }

  const observed = Math.floor(observedInputTokens as number);
  const estimated = estimateTokens(messages, system);
  if (estimated <= 0) {
    return;
  }

  const ratio = observed / estimated;
  const boundedRatio = Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, ratio));
  adaptiveMultiplier =
    adaptiveMultiplier * (1 - CALIBRATION_ALPHA) + boundedRatio * CALIBRATION_ALPHA;
}

function getAutoCompactTokenLimit(): number {
  const explicit = process.env.ONE_AUTO_COMPACT_TOKEN_LIMIT?.trim();
  if (explicit) {
    const parsed = Number(explicit);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  const contextWindow = process.env.ONE_MODEL_CONTEXT_WINDOW?.trim();
  if (contextWindow) {
    const parsed = Number(contextWindow);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed * DEFAULT_AUTO_COMPACT_RATIO);
    }
  }

  return Math.floor(DEFAULT_MODEL_CONTEXT_WINDOW * DEFAULT_AUTO_COMPACT_RATIO);
}

function shouldAutoCompact(messages: ModelMessage[], system?: string): boolean {
  return estimateTokens(messages, system) >= getAutoCompactTokenLimit();
}

export function getCompactionDiagnostics(messages: ModelMessage[], system?: string) {
  const estimatedTokens = estimateTokens(messages, system);
  const tokenLimit = getAutoCompactTokenLimit();

  return {
    estimatedTokens,
    tokenLimit,
    willCompact: estimatedTokens >= tokenLimit,
  };
}

function trimToTokenBudget(messages: ModelMessage[], tokenLimit: number): ModelMessage[] {
  const output = [...messages];

  while (output.length > 1 && estimateTokens(output) > tokenLimit) {
    output.shift();
  }

  return output;
}

function compactSummaryMessage(summary: string): ModelMessage {
  return {
    role: "assistant",
    content:
      "[Context checkpoint summary]\n" +
      summary.trim() +
      "\n\nUse this summary as compressed history and continue from the newest user request.",
  };
}

async function summarizeHistory(params: {
  model: LanguageModel;
  system: string;
  history: ModelMessage[];
  reservedTokens?: number;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  const { model, system, history, reservedTokens = DEFAULT_RESERVED_TOKENS, abortSignal } = params;
  if (history.length === 0) return null;

  const compactLimit = Math.max(8_000, getAutoCompactTokenLimit() - reservedTokens);
  const trimmedHistory = trimToTokenBudget(history, compactLimit);

  const { text } = await generateText({
    model,
    abortSignal,
    system,
    messages: [...trimmedHistory, { role: "user", content: COMPACTION_PROMPT }],
  });

  const summary = text.trim();
  return summary.length > 0 ? summary : null;
}

export async function autoCompactMessages(params: {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  abortSignal?: AbortSignal;
  force?: boolean;
}): Promise<ModelMessage[]> {
  const { model, system, messages, abortSignal, force = false } = params;
  if (!force && !shouldAutoCompact(messages, system)) {
    return messages;
  }

  const maybeIncomingUser = messages.at(-1);
  const hasIncomingUser = maybeIncomingUser?.role === "user";

  const historyOnly = hasIncomingUser ? messages.slice(0, -1) : [...messages];
  const incoming = hasIncomingUser ? [maybeIncomingUser as ModelMessage] : [];

  const summary = await summarizeHistory({
    model,
    system,
    history: historyOnly,
    abortSignal,
  });
  if (!summary) {
    if (!force) {
      return messages;
    }

    // Forced compaction must always reduce history to avoid retrying the same
    // oversized payload when summarization yields empty output.
    const fallbackTail = historyOnly.slice(-DEFAULT_TAIL_MESSAGES);
    return trimToTokenBudget([...fallbackTail, ...incoming], getAutoCompactTokenLimit());
  }

  const tail = historyOnly.slice(-DEFAULT_TAIL_MESSAGES);
  const compacted = [compactSummaryMessage(summary), ...tail, ...incoming];

  return trimToTokenBudget(compacted, getAutoCompactTokenLimit());
}
