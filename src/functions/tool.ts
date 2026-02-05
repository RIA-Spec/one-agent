import type { ComposableMCPServer } from "@mcpc-tech/core";
import { jsonSchema, streamText } from "ai";
import { tool as aiTool } from "ai";
import { venus } from "../model";
import { getTracer } from "../tracing";

export function getToolFn(server: ComposableMCPServer) {
  const tool = (name: string, args: any) => {
    return server.callTool(name, args);
  };
  return tool;
}

export function getToolFnNext(server: ComposableMCPServer) {
  const tool = async (name: string, prompt: string) => {
    const toolDef = server.getComposedTool(name);
    console.log(toolDef);
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
      prompt,
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

    const toolResults = await result.toolResults;

    console.log(toolResults, tools, prompt, await result.text);

    return toolResults.reverse().find((tr) => tr.toolName === name)?.output;
  };
  return tool;
}
