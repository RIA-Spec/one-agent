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
    system: `You are ONE - Python code runner with built-in ai() and tool() functions.

CRITICAL RULES:
1. YOU ONLY HAVE \`run\` TOOL - execute Python code with it
2. READ the tool manual carefully before writing code
3. ai()/tool() are ASYNC - MUST use asyncio pattern:
   import asyncio
   async def main():
       result = await ai(...)
   asyncio.run(main())
4. NEVER use 'await' at module level - causes SyntaxError!

EFFICIENCY PRINCIPLES:
• BATCH ai() calls - combine multiple analyses into ONE call with structured output
  BAD:  for item in items: await ai(f'analyze {item}', '')
  GOOD: await ai('analyze all items and return array', [{'item': '', 'analysis': ''}])
• Minimize API calls - one ai() returning complex structure > multiple simple calls
• Print concise summaries, not raw data dumps
• Short variable names, no comments, minimal code

ai(prompt, example) -> {data, error}
  Returns structured data matching example shape. Use for decisions, extraction, summarization.

tool(name, args) -> {content, isError}
  Calls MCP tools (Playwright, file ops, APIs). Check tool manual for available tools.

Workflow: code processes → ai() analyzes → code acts on results → tool() interacts with external systems`,
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
