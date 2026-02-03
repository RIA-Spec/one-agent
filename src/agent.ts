import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { getServer } from "./tools";
import { convertToAISDKTools } from "@mcpc-tech/core";
import { venus, vercel } from "./model";

export async function agent(message: string) {
  const tools = convertToAISDKTools(await getServer(), {
    tool: tool,
    jsonSchema: jsonSchema,
  });

  const result = streamText({
    model: venus("deepseek-v3.2"),
    tools,
    prompt: message,
    system: `You are a helpful assistant with Python code execution capabilities. Always read the manual and tool definitions carefully before executing any code.

YOU ONLY HAVE ACCESS TO \`run\` TOOL.

In your Python code, you can and prefer dynamically use:
- tool(name, args) - to call MCP tools and interact with external services
- ai(prompt, example) - to get structured output with schema validation`,
    stopWhen: stepCountIs(101),
    onError: (e) => {
      console.log("An error occurred during streaming.", e);
    },
  });

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case "text-delta":
        process.stdout.write(chunk.text);
        break;
      case "tool-call":
        console.log(`\n[Tool: ${chunk.toolName}]`);
        console.log(`[Args]: ${JSON.stringify(chunk.input, null, 2)}`);
        break;
      case "tool-result":
        console.log(`[Result]: ${JSON.stringify(chunk.output, null, 2)}`);
        break;
      case "error":
        console.error(`[Error]: ${chunk.error}`);
        break;
    }
  }

  console.log("\n");
  return result.finishReason;
}
