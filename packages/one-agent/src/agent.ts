import chalk from "chalk";
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

export interface AgentStreamOptions {
  messages: ModelMessage[];
  model?: LanguageModel;
  system?: string;
  maxSteps?: number;
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
    model = openaiCompatible("gemini-3.1-pro"),
    system = AGENT_SYSTEM_PROMPT,
    maxSteps = 101,
    onError,
  } = options;

  const tools = convertToAISDKTools(await getServer(), {
    tool: tool,
    jsonSchema: jsonSchema,
  });

  const result = streamText({
    providerOptions: {
      openaiCompatible: {
        thinkingEnabled: true,
      },
    },
    model,
    tools,
    messages,
    experimental_telemetry: {
      isEnabled: true,
      functionId: "agent.streamText",
      tracer: getTracer("one-agent"),
      metadata: {
        agentType: "one-runner",
        modelProvider: "openaiCompatible",
      },
    },
    system,
    stopWhen: stepCountIs(maxSteps),
    onError:
      onError ||
      ((e) => {
        console.log(chalk.red.bold("An error occurred during streaming."), e);
      }),
  });

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
