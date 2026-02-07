import type { ComposableMCPServer } from "@mcpc-tech/core";
import { jsonSchema, stepCountIs, type StopCondition, streamText } from "ai";
import { tool as aiTool } from "ai";
import { venus } from "../model.js";
import { getTracer } from "../tracing.js";
import { processStream } from "../utils/stream.js";

export function getToolFn(server: ComposableMCPServer) {
  const tool = async (name: string, prompt: string) => {
    const toolDef = server.getComposedTool(name);

    const tools = {
      [name]: aiTool({
        description: toolDef?.description ?? "",
        // @ts-expect-error - schema type mismatch
        inputSchema: jsonSchema(toolDef?.inputSchema),
        // @ts-expect-error - execute type mismatch
        execute: toolDef?.execute,
      }),
    };

    const hasSuccessfullyCalled: StopCondition<typeof tools> = ({ steps }) =>
      steps.some((step) =>
        step.toolResults.some(
          (res) =>
            res.toolName === name &&
            // @ts-expect-error - output type mismatch
            res.output?.isError !== true,
        ),
      );

    const result = streamText({
      model: venus("gemini-3-flash"),
      system: `Execute user requests using the ${name} tool. Follow the input schema strictly and ONLY provide required fields unless explicitly instructed.`,
      prompt: JSON.stringify(prompt),
      experimental_telemetry: {
        isEnabled: true,
        functionId: "functions.act.streamText",
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

    await processStream(result, "act");

    const toolResult = (await result.toolResults).reverse().find((tr) => tr.toolName === name);

    if (toolResult) {
      return toolResult.output;
    }

    const errorText = await result.text;

    return {
      content: [{ type: "text", text: errorText }],
      isError: true,
    };
  };

  return tool;
}
