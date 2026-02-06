import type { ComposableMCPServer } from "@mcpc-tech/core";
import { jsonSchema, stepCountIs, type StopCondition, streamText } from "ai";
import { tool as aiTool } from "ai";
import { venus } from "../model";
import { getTracer } from "../tracing";
import { processStream } from "../utils/stream";

export function getToolFn(server: ComposableMCPServer) {
  const tool = async (name: string, prompt: string) => {
    const toolDef = server.getComposedTool(name);
    const tools = {
      [name]: aiTool({
        description: toolDef?.description ?? "",
        // @ts-expect-error -
        inputSchema: jsonSchema(toolDef?.inputSchema),
        // @ts-expect-error -
        execute: toolDef?.execute,
      }),
    };

    const hasSuccessfullyCalled: StopCondition<typeof tools> = ({ steps }) => {
      const successfulCall = steps.find((step) =>
        step.toolResults.find(
          (res) =>
            res.toolName === name &&
            // @ts-expect-error -
            res.output?.isError !== true,
        ),
      );
      return Boolean(successfulCall);
    };

    const result = streamText({
      model: venus("deepseek-v3.2"),
      system: `Execute user requests using the ${name} tool. Follow the input schema strictly and ONLY provide required fields unless explicitly instructed.`,
      prompt: JSON.stringify(prompt),
      experimental_telemetry: {
        isEnabled: true,
        functionId: "functions.tool.streamText",
        tracer: getTracer("one-agent-aer-ai"),
        metadata: {
          functionType: "tool-invocation",
          modelProvider: "deepseek",
          toolName: name,
        },
      },
      tools,
      toolChoice: { type: "tool", toolName: name },
      stopWhen: [stepCountIs(10), hasSuccessfullyCalled],
    });

    await processStream(result, "tool");

    const toolResults = await result.toolResults;
    const toolResult = toolResults.reverse().find((tr) => tr.toolName === name);

    if (!toolResult) {
      console.log(
        "No tool result found.",
        await result.text,
        await result.toolCalls,
        await result.finishReason,
      );
      const text = await result.text;
      return {
        content: [{ type: "text", text }],
        isError: true,
      };
    }

    return toolResult.output;
  };
  return tool;
}
