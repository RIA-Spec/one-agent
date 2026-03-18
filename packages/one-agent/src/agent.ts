import chalk from "chalk";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type StreamTextResult,
} from "ai";
import { getServer } from "./tools";
import { convertToAISDKTools } from "@mcpc-tech/core";
import { openaiCompatible } from "./model";
import { getTracer } from "./tracing";
import { AGENT_SYSTEM_PROMPT } from "./prompts";
import { processStream } from "./utils/stream";
import {
  autoCompactMessages,
  getCompactionDiagnostics,
  recordCompactionUsageObservation,
} from "./compaction";

interface AgentTelemetryOptions {
  isEnabled?: boolean;
  functionId?: string;
  metadata?: Record<string, unknown>;
}

interface PersistentCompactionState {
  baseMessages: ModelMessage[];
  sourceMessageCount: number;
  compactedAtStep: number;
}

const DEFAULT_MODEL_CONTEXT_WINDOW = 65_536;
const DEFAULT_STEP_GUARD_RESERVE_TOKENS = 2_048;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const TOOL_RESULT_TOKENS_PER_CHAR = 0.5;
const DEFAULT_CHAT_MODEL_ID = "gemini-3.1-pro";

function resolveDefaultChatModelId(): string {
  // Keep aligned with web runtime precedence for one-agent chat model selection.
  return (
    process.env.ONE_CHAT_MODEL?.trim() ||
    process.env.ONE_AGENT_MODEL?.trim() ||
    process.env.MODEL?.trim() ||
    DEFAULT_CHAT_MODEL_ID
  );
}

function estimateToolResultsTokens(toolResults: unknown): number {
  if (!toolResults) {
    return 0;
  }

  let serialized = "";
  try {
    serialized = JSON.stringify(toolResults);
  } catch {
    return 0;
  }

  return Math.ceil(serialized.length * TOOL_RESULT_TOKENS_PER_CHAR);
}

function getPersistentCompactionState(
  experimentalContext: unknown,
): PersistentCompactionState | undefined {
  if (!experimentalContext || typeof experimentalContext !== "object") {
    return undefined;
  }

  const state = (experimentalContext as { persistentCompaction?: unknown }).persistentCompaction;

  if (!state || typeof state !== "object") {
    return undefined;
  }

  const candidate = state as Partial<PersistentCompactionState>;
  if (
    !Array.isArray(candidate.baseMessages) ||
    typeof candidate.sourceMessageCount !== "number" ||
    typeof candidate.compactedAtStep !== "number"
  ) {
    return undefined;
  }

  return {
    baseMessages: candidate.baseMessages,
    sourceMessageCount: candidate.sourceMessageCount,
    compactedAtStep: candidate.compactedAtStep,
  };
}

function withPersistentCompactionState(
  experimentalContext: unknown,
  persistentCompaction: PersistentCompactionState,
): Record<string, unknown> {
  const baseContext =
    experimentalContext &&
    typeof experimentalContext === "object" &&
    !Array.isArray(experimentalContext)
      ? (experimentalContext as Record<string, unknown>)
      : {};

  return {
    ...baseContext,
    persistentCompaction,
  };
}

function applyPersistentCompaction(
  messages: ModelMessage[],
  persistentCompaction: PersistentCompactionState | undefined,
): ModelMessage[] {
  if (!persistentCompaction) {
    return messages;
  }

  const suffixStart = Math.min(
    Math.max(persistentCompaction.sourceMessageCount, 0),
    messages.length,
  );

  return [...persistentCompaction.baseMessages, ...messages.slice(suffixStart)];
}

function isDebugEnabled(): boolean {
  const value = process.env.ONE_AGENT_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function getDebugLogFilePath(): string {
  const explicit = process.env.ONE_AGENT_DEBUG_FILE?.trim();
  if (explicit) {
    return explicit;
  }

  return join(tmpdir(), "one-agent-debug.log");
}

function debugLog(message: string, payload?: Record<string, unknown>) {
  if (!isDebugEnabled()) {
    return;
  }

  const line = JSON.stringify({
    time: new Date().toISOString(),
    message,
    ...(payload ? { payload } : {}),
  });

  try {
    appendFileSync(getDebugLogFilePath(), `${line}\n`, "utf8");
  } catch {
    // Ignore debug logging failures.
  }
}

function readPositiveIntEnv(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.floor(parsed);
}

interface CompactionEvent {
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  tokenLimit: number;
  messagesBefore: number;
  messagesAfter: number;
}

export interface AgentStreamOptions {
  messages: ModelMessage[];
  model?: LanguageModel;
  system?: string;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  enableAutoCompact?: boolean;
  onCompaction?: (event: CompactionEvent) => void;
  telemetry?: AgentTelemetryOptions;
  onError?: (error: unknown) => void;
}

/**
 * Core streaming function for Chat SDK integration.
 * Returns StreamTextResult without consuming the stream (no console output).
 */
export async function agentStream(
  options: AgentStreamOptions,
): Promise<StreamTextResult<any, any>> {
  const {
    messages,
    model,
    system = AGENT_SYSTEM_PROMPT,
    maxSteps = 101,
    abortSignal,
    enableAutoCompact = true,
    onCompaction,
    telemetry,
    onError,
  } = options;

  const resolvedModel = model ?? openaiCompatible(resolveDefaultChatModelId());

  const tools = convertToAISDKTools(await getServer(), {
    tool: tool,
    jsonSchema: jsonSchema,
  });

  const diagnosticsBefore = getCompactionDiagnostics(messages, system);
  const streamMessages = enableAutoCompact
    ? await autoCompactMessages({
        model: resolvedModel,
        system,
        messages,
        abortSignal,
      })
    : messages;
  const diagnosticsAfter = getCompactionDiagnostics(streamMessages, system);

  if (enableAutoCompact && streamMessages !== messages) {
    onCompaction?.({
      estimatedTokensBefore: diagnosticsBefore.estimatedTokens,
      estimatedTokensAfter: diagnosticsAfter.estimatedTokens,
      tokenLimit: diagnosticsBefore.tokenLimit,
      messagesBefore: messages.length,
      messagesAfter: streamMessages.length,
    });
  }

  const contextWindow =
    readPositiveIntEnv("ONE_MODEL_CONTEXT_WINDOW") ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  const stepGuardReserve =
    readPositiveIntEnv("ONE_STEP_GUARD_RESERVE_TOKENS") ?? DEFAULT_STEP_GUARD_RESERVE_TOKENS;
  const stepGuardLimit = Math.max(1, contextWindow - stepGuardReserve);
  const maxOutputTokens = readPositiveIntEnv("ONE_MAX_OUTPUT_TOKENS") ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const shouldCompactForNextStep = (
    steps: Array<{ usage?: { totalTokens?: number }; toolResults?: unknown }>,
  ) => {
    const lastStep = steps.at(-1);
    const totalTokens = lastStep?.usage?.totalTokens;
    const toolResultsTokens = estimateToolResultsTokens(lastStep?.toolResults);
    const estimatedNextInputTokens =
      (typeof totalTokens === "number" ? totalTokens : 0) + toolResultsTokens;

    return {
      shouldCompact: estimatedNextInputTokens >= stepGuardLimit,
      estimatedNextInputTokens,
      toolResultsTokens,
      totalTokens,
    };
  };

  debugLog("agentStream config", {
    maxSteps,
    contextWindow,
    stepGuardReserve,
    stepGuardLimit,
    maxOutputTokens,
    messages: streamMessages.length,
  });

  const result = streamText({
    providerOptions: {
      openaiCompatible: {
        thinkingEnabled: true,
      },
    },
    model: resolvedModel,
    maxOutputTokens,
    abortSignal,
    tools: { one: tools["one"] },
    messages: streamMessages,
    experimental_telemetry: {
      isEnabled: telemetry?.isEnabled ?? true,
      functionId: telemetry?.functionId ?? "agent.streamText",
      tracer: getTracer("one-agent"),
      metadata: {
        agentType: "one-runner",
        modelProvider: "openaiCompatible",
        ...(telemetry?.metadata ?? {}),
      },
    },
    system,
    stopWhen: stepCountIs(maxSteps),
    prepareStep: async ({ steps, messages: stepMessages, stepNumber, experimental_context }) => {
      const persistentCompaction = getPersistentCompactionState(experimental_context);
      const effectiveMessages = applyPersistentCompaction(stepMessages, persistentCompaction);

      const nextStepState = shouldCompactForNextStep(
        steps as Array<{ usage?: { totalTokens?: number }; toolResults?: unknown }>,
      );
      const currentDiagnostics = getCompactionDiagnostics(effectiveMessages, system);
      const shouldCompactByCurrentMessages = currentDiagnostics.estimatedTokens >= stepGuardLimit;
      const shouldCompact = nextStepState.shouldCompact || shouldCompactByCurrentMessages;

      if (!shouldCompact && effectiveMessages !== stepMessages) {
        debugLog("prepareStep persistent compaction applied", {
          stepNumber,
          messagesBefore: stepMessages.length,
          messagesAfter: effectiveMessages.length,
          compactedAtStep: persistentCompaction?.compactedAtStep,
        });

        return {
          messages: effectiveMessages,
        };
      }

      if (!shouldCompact) {
        return undefined;
      }

      debugLog("prepareStep compact triggered", {
        stepNumber,
        reason: {
          byPreviousStepProjection: nextStepState.shouldCompact,
          byCurrentMessages: shouldCompactByCurrentMessages,
        },
        estimatedNextInputTokens: nextStepState.estimatedNextInputTokens,
        toolResultsTokens: nextStepState.toolResultsTokens,
        currentEstimatedTokens: currentDiagnostics.estimatedTokens,
        stepGuardLimit,
        messagesBefore: effectiveMessages.length,
        originalMessagesBefore: stepMessages.length,
        compactedAtStep: persistentCompaction?.compactedAtStep,
      });

      const compactedMessages = await autoCompactMessages({
        model: resolvedModel,
        system,
        messages: effectiveMessages,
        abortSignal,
        force: true,
      });
      const nextPersistentCompaction: PersistentCompactionState = {
        baseMessages: compactedMessages,
        sourceMessageCount: stepMessages.length,
        compactedAtStep: stepNumber,
      };

      debugLog("prepareStep compact result", {
        stepNumber,
        messagesAfter: compactedMessages.length,
        compactedEstimatedTokens: getCompactionDiagnostics(compactedMessages, system)
          .estimatedTokens,
      });

      return {
        messages: compactedMessages,
        experimental_context: withPersistentCompactionState(
          experimental_context,
          nextPersistentCompaction,
        ),
      };
    },
    onStepFinish: ({ usage, finishReason, response, toolResults }) => {
      const totalTokens = usage.totalTokens;
      const inputTokens = usage.inputTokens;
      const outputTokens = usage.outputTokens;
      const toolResultsTokens = estimateToolResultsTokens(toolResults);
      const estimatedNextInputTokens =
        (typeof totalTokens === "number" ? totalTokens : 0) + toolResultsTokens;
      const shouldStop = estimatedNextInputTokens >= stepGuardLimit;

      debugLog("step finished", {
        finishReason,
        responseId: response.id,
        totalTokens,
        inputTokens,
        outputTokens,
        toolResultsTokens,
        estimatedNextInputTokens,
        stepGuardLimit,
        shouldStop,
      });
    },
    onError:
      onError ||
      ((e) => {
        console.log(chalk.red.bold("An error occurred during streaming."), e);
      }),
  });

  void (async () => {
    try {
      const usage = await result.totalUsage;
      recordCompactionUsageObservation({
        messages: streamMessages,
        system,
        observedInputTokens: usage.inputTokens,
      });
    } catch {
      // Ignore usage read failures; calibration is best-effort.
    }
  })();

  return result;
}

/**
 * Original CLI/REPL interface - consumes stream and prints to console.
 * Preserved for backward compatibility.
 */
export async function agent(message: string) {
  const result = await agentStream({
    messages: [{ role: "user", content: message }],
  });

  await processStream(result);
  return await result.finishReason;
}
