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

# API Reference

## ai(prompt, example) -> {data, error}

Call LLM for structured data extraction and decision-making.

**Parameters:**

- `prompt` (str): What you want the AI to do
- `example`: Expected output shape - AI returns data matching this structure

**Returns:**

- `data`: Structured result (bool, array, object, number, string)
- `error`: Error message if validation fails, null otherwise

**Use Cases:**

- Boolean decisions: `await ai('Should we alert?', True)`
- Array extraction: `await ai('List top 3 items', ['item1'])`
- Object structuring: `await ai('Categorize data', {'cat1': [], 'cat2': []})`
- Batch analysis: `await ai('Analyze all items', [{'item': '', 'summary': ''}])`

## tool(name, args) -> {content, isError}

Call MCP server tools for external interactions.

**Parameters:**

- `name` (str): Tool name (e.g., 'playwright_browser_navigate')
- `args` (dict): Tool-specific arguments

**Returns:**

- `content`: Array of content blocks [{type: 'text', text: '...'}, ...]
- `isError`: Boolean indicating failure (optional)

**Available Tools:** Check Playwright tools for browser automation (navigate, click, type, snapshot, screenshot).

# Async Pattern (REQUIRED)

```python
import asyncio

async def main():
    result = await ai('prompt', example)
    data = await tool('tool_name', {'arg': 'value'})
    print(result['data'])

asyncio.run(main())
```

**NEVER** use `await` at module level - causes SyntaxError!

# Examples

## 1. Batch Analysis (PREFERRED - one ai() call)

```python
import asyncio

async def main():
    news = ['News A', 'News B', 'News C']
    result = await ai(
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

## 2. Boolean Decision

```python
import asyncio

async def main():
    errors, threshold = 12, 10
    result = await ai(f'Should alert? errors={errors}, threshold={threshold}', True)
    if result['data']:
        print('Alert triggered')

asyncio.run(main())
```

## 3. Browser Automation with AI Analysis

```python
import asyncio

async def main():
    await tool('playwright_browser_navigate', {'url': 'https://example.com'})
    snapshot = await tool('playwright_browser_snapshot', {})
    page_content = snapshot['content'][0]['text']

    result = await ai(
        f'Extract all links and categorize: {page_content[:2000]}',
        {'nav_links': ['link1'], 'content_links': ['link2'], 'external_links': ['link3']}
    )
    print(result['data'])

asyncio.run(main())
```

## 4. Error Handling

```python
import asyncio

async def main():
    result = await ai('Extract data', {'items': []})
    if result['error']:
        print(f"Error: {result['error']}")
    elif result['data'] is None:
        print('No data returned')
    else:
        print(result['data'])

asyncio.run(main())
```
