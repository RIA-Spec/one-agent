---
name: one-runner
mode: agentic
deps:
  mcpServers:
    playwright:
      transportType: stdio
      command: npx
      args: ["-y", "@playwright/mcp"]
      env:
        PLAYWRIGHT_MCP_HEADLESS: "0"
refs:
  - '<tool name="playwright.__ALL__"/>'
---

# Python Action Execution Runtime (AER)

**The Programmatic Approach**: Manage control flows using code execution (conditions, loops, branches).

## API Reference

### reason(prompt, example) -> {data, error}

Call LLM for structured data extraction and decision-making.

**Parameters:**

- `prompt` (str): What you want the AI to do
- `example`: Expected output shape - AI returns data matching this structure

**Returns:**

- `data`: Structured result (bool, array, object, number, string)
- `error`: Error message if validation fails, null otherwise

**Use Cases:**

- Boolean decisions: `await reason('Should we alert?', True)`
- Array extraction: `await reason('List top 3 items', ['item1'])`
- Object structuring: `await reason('Categorize data', {'cat1': [], 'cat2': []})`
- Batch analysis: `await reason('Analyze all items', [{'item': '', 'summary': ''}])`

### act(name, prompt) -> {content, isError}

Call MCP server tools with AI-powered parameter inference.

**Parameters:**

- `name` (str): Tool name (e.g., 'playwright_browser_navigate', 'bash')
- `prompt` (str): Natural language description of what you want the tool to do

**Returns:**

- `content`: Array of content blocks [{type: 'text', text: '...'}, ...]
- `isError`: Boolean indicating failure (optional)

**Available Tools:** bash (shell commands), Playwright tools (browser automation).

## Environment Constraints

- Python runs in WebAssembly sandbox (Pyodide)
- No subprocess support (use `bash` via act for shell commands)
- Both Python file I/O and bash work for file operations

## Async Pattern (REQUIRED)

```python
import asyncio

async def main():
    result = await reason('prompt', example)
    data = await act('tool_name', 'description of what to do')
    print(result['data'])

asyncio.run(main())
```

**NEVER** use `await` at module level - causes SyntaxError!

## Examples

### 1. Conditional Logic with AI

```python
import asyncio

async def main():
    log_content = open("build.log").read() if os.path.exists("build.log") else "No log"

    result = await reason(
        f"Analyze this build log: {log_content}\nDid the build succeed?",
        {"success": False, "reason": ""}
    )

    if result['data']['success']:
        print("✓ Build succeeded! Deploying...")
        await act("bash", "git push production main")
    else:
        print(f"✗ Build failed: {result['data']['reason']}")

asyncio.run(main())
```

### 2. Batch Analysis (PREFERRED - one reason() call)

```python
import asyncio

async def main():
    news = ['News A', 'News B', 'News C']
    result = await reason(
        f'Analyze each news item and overall trend: {news}',
        {
            'analyses': [{'title': 'News A', 'summary': 'brief analysis'}],
            'trend': 'overall trend summary'
        }
    )
    for item in result['data']['analyses']:
        print(f"{item['title']}: {item['summary']}")
    print(f"Trend: {result['data']['trend']}")

asyncio.run(main())
```

### 3. Loop with Dynamic Decisions

```python
import asyncio

async def main():
    urls = [
        "https://api.example.com/data1",
        "https://api.example.com/data2",
        "https://api.example.com/data3"
    ]

    for url in urls:
        response = await act("bash", f"curl -s {url}")
        data = response['content'][0]['text']

        check = await reason(
            f"Is this API response valid JSON? {data[:200]}",
            {"valid": False, "action": ""}
        )

        if check['data']['valid']:
            print(f"✓ {url}: Valid")
        else:
            print(f"✗ {url}: Invalid - {check['data']['action']}")
            break

asyncio.run(main())
```

### 4. Browser Automation with AI Analysis

```python
import asyncio

async def main():
    await act('playwright_browser_navigate', 'Navigate to https://example.com')
    snapshot = await act('playwright_browser_snapshot', 'Take a snapshot')
    page_content = snapshot['content'][0]['text']

    result = await reason(
        f'Extract all links and categorize: {page_content[:2000]}',
        {'nav_links': [], 'content_links': [], 'external_links': []}
    )
    print(result['data'])

asyncio.run(main())
```

### 5. Error Handling

```python
import asyncio

async def main():
    result = await reason('Extract data', {'items': []})
    if result['error']:
        print(f"Error: {result['error']}")
    elif result['data'] is None:
        print('No data returned')
    else:
        print(result['data'])

asyncio.run(main())
```
