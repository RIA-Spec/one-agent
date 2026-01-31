import { tool } from 'ai';
import { z } from 'zod';
import { mcpc } from '@mcpc-tech/core';
import type { ComposeDefinition } from '@mcpc-tech/core';

const DESCRIPTION = `
A Python code execution assistant that runs code in a secure sandbox environment.

Capabilities:
- Execute Python code for data analysis, scientific computing, and machine learning
- Dynamically install and use any PyPI package
- Handle mathematical calculations, statistics, and text processing

Available Tools:
<tool name="python-code-runner" />

Guidelines:
1. Write clear, valid Python code
2. Use print() to output results
3. Provide importToPackageMap for packages with different import names
`;

const MANUAL = `
## Python Code Runner Manual

### Parameters

**code** (string, required)
Python source code to execute. Must be compatible with Pyodide runtime.
- Use print() to output results
- Supports standard Python syntax and most pure Python packages

**importToPackageMap** (Record<string, string>, optional)
Mapping from import names to PyPI package names when they differ.

Common mappings:
- {"sklearn": "scikit-learn"}
- {"PIL": "Pillow"}
- {"cv2": "opencv-python"}
- {"skimage": "scikit-image"}

### Examples

Basic calculation:
\`\`\`python
import math
print(math.factorial(10))
\`\`\`

Data analysis:
\`\`\`python
import json
data = [{"score": 85}, {"score": 92}]
avg = sum(d["score"] for d in data) / len(data)
print(f"Average: {avg}")
\`\`\`

Machine learning:
\`\`\`python
from sklearn.datasets import load_iris
data = load_iris()
print(data.feature_names)
\`\`\`
importToPackageMap: {"sklearn": "scikit-learn"}
`;

const compose: ComposeDefinition = {
  name: "python-runner",
  description: DESCRIPTION,
  manual: MANUAL,
  deps: {
    mcpServers: {
      "code-runner": {
        command: "deno",
        args: ["run", "--allow-all", "jsr:@mcpc/code-runner-mcp/bin"],
        env: { "ALLOWED_TOOLS": "python" },
        transportType: "stdio",
      },
    },
  },
  options: {
    mode: "agentic",
    refs: ['<tool name="code-runner.python-code-runner" />'],
  },
};

let server: Awaited<ReturnType<typeof mcpc>> | null = null;

async function getServer() {
  if (!server) {
    server = await mcpc(
      [{ name: "python-agent", version: "1.0.0" }, { capabilities: { tools: {} } }],
      [compose]
    );
  }
  return server;
}

export const pythonRunner = tool({
  description: `Execute Python code in a secure Pyodide sandbox.

Use for:
- Data analysis (pandas, numpy)
- Machine learning (scikit-learn)
- Mathematical calculations
- Text processing

Code runs in an isolated WebAssembly environment. Always use print() to output results.`,
  inputSchema: z.object({
    code: z.string().describe(`Python code to execute. Examples:
- "import math; print(math.sqrt(16))"
- "import pandas as pd; print(pd.DataFrame({'a': [1]}).describe())"
- "from sklearn.datasets import load_iris; print(load_iris().feature_names)"`),
    importToPackageMap: z.record(z.string(), z.string()).optional().describe(
      `Package name mappings. Common: {"sklearn": "scikit-learn", "PIL": "Pillow", "cv2": "opencv-python"}`
    ),
  }),
  execute: async ({ code, importToPackageMap }) => {
    const s = await getServer();
    const result = await s.callTool('python-code-runner', {
      code,
      ...(importToPackageMap && { importToPackageMap }),
    });

    if (result && typeof result === 'object' && 'content' in result) {
      const content = (result as any).content;
      if (Array.isArray(content) && content.length > 0) {
        return content.map((c: any) => c.text || '').join('\n');
      }
    }
    return JSON.stringify(result);
  },
});

export async function getTools() {
  await getServer();
  return { pythonRunner };
}
