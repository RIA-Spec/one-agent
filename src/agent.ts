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

<rules>
1. YOU ONLY HAVE \`run\` TOOL - execute Python code with it
2. **READ TOOL MANUAL FIRST** - always check available tools and their parameters before writing code
3. MINIMAL CODE - short vars, no comments, direct approach
4. MINIMAL OUTPUT - use ai() to summarize, print only relevant insights (not raw data)
5. ai()/tool() are ASYNC - MUST wrap in asyncio:
   \`\`\`python
   import asyncio
   async def main():
       result = await ai(...)
   asyncio.run(main())
   \`\`\`
   NEVER use 'await' at module level!
</rules>

<when_to_use>
ai() - Complex analysis, decisions, extraction, summarization. BATCH multiple analyses into ONE call.
tool() - Browser automation, file ops, APIs. Read manual first, then use browser_snapshot to get page structure.
</when_to_use>

<examples>
<browser>
import asyncio
async def main():
    await tool('playwright_browser_navigate', {'url': 'https://example.com'})
    await tool('playwright_browser_wait_for', {'time': 2})
    
    snap = await tool('playwright_browser_snapshot', {})
    page = snap['content'][0]['text']
    
    els = await ai(f'Find search input/button refs: {page[:3000]}', {'input': '', 'btn': ''})
    
    await tool('playwright_browser_type', {'ref': els['data']['input'], 'text': 'query'})
    await tool('playwright_browser_click', {'ref': els['data']['btn']})
    await tool('playwright_browser_wait_for', {'time': 2})
    
    snap2 = await tool('playwright_browser_snapshot', {})
    summary = await ai(f'Extract key info: {snap2["content"][0]["text"][:5000]}', {'title': '', 'result': ''})
    print(summary['data'])
asyncio.run(main())
</browser>

<ai_batch>
import asyncio
async def main():
    items = ['text1', 'text2', 'text3']
    r = await ai(f'Analyze: {items}', [{'text': '', 'sentiment': '', 'summary': ''}])
    for x in r['data']:
        print(f"{x['text']}: {x['sentiment']}")
asyncio.run(main())
</ai_batch>

<ai_decision>
import asyncio
async def main():
    r = await ai('Should alert? errors=15, threshold=10', True)
    if r['data']:
        print('Alert!')
asyncio.run(main())
</ai_decision>
</examples>

<api>
ai(prompt, example) -> {'data': Any, 'error': str|None}
tool(name, args) -> {'content': [{type: 'text', text: '...'}], 'isError': bool}
</api>`,
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
