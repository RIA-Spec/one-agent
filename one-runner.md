---
name: one-runner
description: ONE - Python code runner with built-in ai() and tool() functions for intelligent data processing
mode: agentic
deps:
  mcpServers:
    playwright:
      transportType: stdio
      command: npx
      args: ["-y", "@playwright/mcp@latest"]
      env:
        PLAYWRIGHT_MCP_HEADLESS: "0"
refs:
  - '<tool name="playwright.__ALL__"/>'
---

YOU PREFER using <ai_function/> with <tool_function/> to solve complex problems with code in one shot. YOU MUST follow the <async_requirement/> and <code_style/> sections. Check <examples/> for patterns. Read <output_tips/> for efficient output.

<overview>
Use ONE for:
- Data analysis and scientific computing (pandas, numpy)
- Machine learning experiments (scikit-learn)
- Mathematical calculations and statistics
- Text processing and NLP tasks
- Algorithm validation and prototyping
</overview>

<ai_function>
Built-in ai(prompt, example) Function:
Call LLM for intelligent data processing and structured decision-making:
• Summarizing information and extracting key insights
• Making data-driven decisions and recommendations  
 • Structuring unstructured data into organized formats
• Generating efficient, context-aware responses
• Returning structured data (booleans, arrays, objects) for code logic

Return Value:
ai() returns an object with:
• data: Any structured data - booleans, arrays, objects, numbers, etc.
• error: Error message if validation fails, null otherwise

The AI validates returned data against the shape inferred from your example.
</ai_function>

<tool_function>
Built-in tool(name, args) Function:
Call MCP server tools for extended capabilities:
• Browser automation (Playwright - navigate, click, scrape)
• File operations (read, write, search files)
• API calls and web requests
• Database queries and operations
• Combine with ai() for intelligent data processing

Parameters:
• name: Tool name (str)
• args: Tool arguments (use man to understand schema)

Return Value:
tool() returns an object with:
• content: Array of content blocks (text, images, resources)
• isError: Boolean indicating execution failure (optional)

IMPORTANT: tool() is ASYNC and MUST be called with await inside async function!
</tool_function>

<async_requirement>
IMPORTANT - Async Function Requirement:
ai() is an ASYNC function and MUST be called inside an async function with asyncio:

import asyncio

async def main():
result = await ai('Summarize in 1 sentence: Python is a programming language.', '')
print(result['data'])

asyncio.run(main())

DO NOT use await directly in module-level code - it will cause "SyntaxError: 'await' outside function"!
</async_requirement>

<output_tips>
Output Tips - Token Friendly:
Print concise summaries, not raw data dumps. Keep it meaningful and compact.
BAD: print(df) -> GOOD: print(f"{len(df)} rows, mean: {df['col'].mean():.2f}")
</output_tips>

<code_style>
Code Style - Maximum Efficiency:
For best token efficiency and generation speed:
• No comments - code should be self-explanatory
• Short variable names (df, arr, res, etc.)
• Minimal code - only what's needed
• Direct execution - no unnecessary abstractions
</code_style>

<code_ai_combination>
Code + AI + Tools Combination:
Combine Python code, ai(), and tool() for powerful dynamic workflows:
• Process data with code → AI summarizes findings
• AI returns booleans/flags → Code makes conditional decisions
• AI extracts structured arrays → Code iterates and processes
• AI generates objects → Code uses for further computation
• tool() fetches external data → AI analyzes → Code acts on results
• Create adaptive workflows with intelligent branching logic
• Chain multiple tool calls with AI-driven decision making
</code_ai_combination>

<examples>
Complete Working Examples:

1. Boolean Decision:
   import asyncio

async def main():
total_errors = 12
threshold = 10
result = await ai(f'Should we alert? total_errors={total_errors}, threshold={threshold}. Return true/false.', True)
if result['data']:
print('Alert triggered')

asyncio.run(main())

2. Array Extraction:
   import asyncio
   import pandas as pd

async def main():
df = pd.read_csv('/data/sales.csv')
result = await ai('Return the column names as an array: ' + str(list(df.columns)), ['col'])
for product in result['data']:
print(f'Column: {product}')

asyncio.run(main())

3. Structured Object:
   import asyncio

async def main():
items = [
'coffee $4',
'bus ticket $2.5',
'sandwich $8',
'movie ticket $15'
]
result = await ai(
'Categorize these expenses into food/transport/other as 3 arrays: ' + str(items),
{'food': ['coffee $4'], 'transport': ['bus ticket $2.5'], 'other': ['movie ticket $15']}
)
print(result['data'])

asyncio.run(main())

4. Using tool() Function:
   import asyncio

async def main():

# Call an MCP tool (example with filesystem tool)

result = await tool('read_file', {'path': '/data/report.txt'})
content = result['content'][0]['text']
print(f'File content: {content[:100]}...')

asyncio.run(main())

5. Combining tool() and ai():
   import asyncio

async def main():

# Fetch data with tool, analyze with AI

data = await tool('fetch', {'url': 'https://api.example.com/data'})
raw = data['content'][0]['text']

summary = await ai(f'Summarize key points: {raw[:500]}', '')
print(f'Summary: {summary["data"]}')

asyncio.run(main())
</examples>
