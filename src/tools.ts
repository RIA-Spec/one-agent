import { tool, jsonSchema } from 'ai';
import { mcpc } from '@mcpc-tech/core';
import type { ComposeDefinition } from '@mcpc-tech/core';

const DESCRIPTION = `Execute Python code in a secure Pyodide sandbox with support for any PyPI package installation.

Use for:
- Data analysis and scientific computing (pandas, numpy)
- Machine learning experiments (scikit-learn)
- Mathematical calculations and statistics
- Text processing and NLP tasks
- Algorithm validation and prototyping

The code runs in an isolated WebAssembly environment (Pyodide), making it safe to execute untrusted code. Always use print() to output results.

For packages with different import names vs PyPI names (like sklearn, PIL, cv2), provide importToPackageMap parameter.`;

const MANUAL = `## Python Code Runner Manual

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

### Limitations
- No compiled C/C++ extensions (unless wasm version exists)
- Network requests may be restricted
- File system access limited to configured mount points`;

const compose: ComposeDefinition = {
  name: "python-runner",
  description: DESCRIPTION,
  manual: MANUAL,
  deps: {
    mcpServers: {
      "code-runner": {
        command: "deno",
        args: ["run", "--allow-all", "./node_modules/@mcpc/code-runner-mcp/src/stdio.server.js"],
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

export async function getTools() {
  const s = await getServer();
  const mcpTools = s.getPublicTools();
  
  const tools: Record<string, any> = {};
  
  for (const t of mcpTools) {
    tools[t.name] = tool({
      description: t.description || '',
      inputSchema: jsonSchema(t.inputSchema as any),
      execute: async (args: any) => {
        const result = await s.callTool(t.name, args);
        if (result && typeof result === 'object' && 'content' in result) {
          const content = (result as any).content;
          if (Array.isArray(content) && content.length > 0) {
            return content.map((c: any) => c.text || '').join('\n');
          }
        }
        return JSON.stringify(result);
      },
    });
  }
  
  return tools;
}
