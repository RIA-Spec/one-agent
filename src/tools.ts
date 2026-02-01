import { jsonSchema } from 'ai';
import { mcpc } from '@mcpc-tech/core';
import type { ComposeDefinition } from '@mcpc-tech/core';
import { runPy, getPythonPrompt } from '@mcpc/code-runner-mcp';

const nodeFSRoot = '/Users/beet/Downloads'
const nodeFSMountPoint = '/data';

const DESCRIPTION = `INSIDE - Use run() to execute Python code in a secure Pyodide sandbox with built-in ai() async function for intelligent data processing, analysis, and structured decision-making.`;

const MANUAL = `
YOU PREFER using <ai_function/> to solve complex problems with code in one shot. YOU MUST follow the <async_requirement/> and <code_style/> sections. Check <examples/> for patterns. Read <output_tips/> for efficient output.

<overview>
Use INSIDE for:
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
  • text: Context-aware text response or explanation

The AI validates returned data against the shape inferred from your example.
</ai_function>

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
Print concise summaries, not raw data dumps. Like ai() text field - keep it meaningful and compact.
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
Code + AI Combination:
Combine Python code with ai() for powerful dynamic workflows:
  • Process data with code → AI summarizes findings
  • AI returns booleans/flags → Code makes conditional decisions
  • AI extracts structured arrays → Code iterates and processes
  • AI generates objects → Code uses for further computation
  • Create adaptive workflows with intelligent branching logic
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
  print(result['text'])

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
  print(result['text'])

asyncio.run(main())
</examples>`;

const compose: ComposeDefinition = {
  name: "inside-runner",
  description: DESCRIPTION,
  manual: MANUAL,
  deps: {
    mcpServers: {
      playwright: {
        transportType: 'stdio',
        command: "npx",
        args: ['-y', '@playwright/mcp@latest']
      }
    }
  },
  options: { mode: "agentic", refs: [] },
};

const DEV_MODE = true;

let server: Awaited<ReturnType<typeof mcpc>> | null = null;

export async function getServer() {
  if (!server || DEV_MODE) {
    server = await mcpc(
      [{ name: "inside", version: "1.0.0" }, { capabilities: { tools: {} } }],
      [compose],
      (server) => {
        server.tool(
          "run",
          `INSIDE Runner - Execute Python with built-in ai() function.

Features:
  • Built-in async ai(prompt, example) function for intelligent analysis
  • Returns structured data: booleans, arrays, objects for dynamic decisions
  • Combine code computation with AI intelligence
  • File system access at /data (maps to ${nodeFSRoot})

CRITICAL: ai() MUST be used inside async function with asyncio.run():

import asyncio

async def main():
    result = await ai('Summarize in 1 sentence: Python is a programming language.', '')
    print(result['data'])

asyncio.run(main())

DO NOT use 'await ai()' directly - will cause SyntaxError!
See manual for complete examples.

${getPythonPrompt(nodeFSRoot, nodeFSMountPoint)}
`,
          jsonSchema({
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Python code to execute. MUST use print() to see results.',
              },
              packages: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Map import names to PyPI package names. Use when names differ or for indirectly imported packages. Example: {"sklearn": "scikit-learn", "openpyxl": "openpyxl"}',
              },
            },
            required: ['code']
          }),
          async ({ code, packages }: { code: string, packages?: Record<string, string> }, extra) => {
            const { ai } = await import('./ai.js');
            const stream = await runPy(code, {
              handlers: { ai },
              packages,
              nodeFSRoot,
              nodeFSMountPoint,
            });
            const decoder = new TextDecoder();
            let output = "";
            for await (const chunk of stream) {
              output += decoder.decode(chunk);
            }
            return {
              content: [{ type: "text", text: output || "(no output)" }],
            };
          },
          { internal: true }
        );
      }
    );
  }
  return server;
}
