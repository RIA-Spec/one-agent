import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { getServer } from "./tools";
import { convertToAISDKTools } from "@mcpc-tech/core";
import { venus, vercel } from "./model";
import { getTracer } from "./tracing";
import { AGENT_SYSTEM_PROMPT_NEXT } from "./prompts";
import { processStream } from "./utils/stream";

export async function agent(message: string) {
  const tools = convertToAISDKTools(await getServer(), {
    tool: tool,
    jsonSchema: jsonSchema,
  });

  const result = streamText({
    model: venus("deepseek-v3.2"),
    tools,
    prompt: message,
    experimental_telemetry: {
      isEnabled: true,
      functionId: "agent.streamText",
      tracer: getTracer("one-agent-next"),
      metadata: {
        agentType: "one-runner-next",
        modelProvider: "deepseek",
      },
    },
    system: AGENT_SYSTEM_PROMPT_NEXT,
    stopWhen: stepCountIs(101),
    onError: (e) => {
      console.log("An error occurred during streaming.", e);
    },
  });

  await processStream(result);
  return await result.finishReason;
}
