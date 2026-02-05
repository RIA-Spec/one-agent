import type { ComposableMCPServer } from "@mcpc-tech/core";
import { jsonSchema, streamText } from "ai";
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

    const result = streamText({
      model: venus("deepseek-v3.2"),
      system: `You are a tool execution agent. Use the provided tool to execute the user's request.
You MUST follow the user's instructions exactly and only use the provided tool: ${name}.`,
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
    });

    await processStream(result, "tool");

    const toolResults = await result.toolResults;

    return toolResults.reverse().find((tr) => tr.toolName === name)?.output;
  };
  return tool;
}
