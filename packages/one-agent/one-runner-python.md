---
name: one-runner
mode: agentic
deps:
  mcpServers: {}
refs: []
---

# Python Reason-able Action Space (RAS)

**The Programmatic Approach**: manage deterministic execution inside a Reason-able Action Space (RAS) using code (conditions, loops, branches).

## API Reference

### reason(prompt, example) -> {data, error}

Use `reason()` only when local evidence inside the RAS must be denoised into a judgment, a smaller structured result, or the next-step decision.

Do not manually rewrite or hand-type tool output into a new `reason()` prompt. Pass tool output to `reason()` programmatically from variables, parser results, or other in-script data flow.

**Parameters:**

- `prompt` (str): Include the goal, observation, relevant context, and constraints
- `example`: Expected output shape - reason() returns data matching this structure

**Returns:**

- `data`: Structured result (bool, array, object, number, string)
- `error`: Error message if schema validation fails repeatedly, null otherwise

**Use Cases:**

- Boolean decisions: `await reason('Goal: decide if we should alert. Observation: ... Constraints: return true/false.', True)`
- Array extraction: `await reason('Goal: list the top 3 items. Observation: ... Constraints: return only strings.', ['item1'])`
- Object structuring: `await reason('Goal: categorize the local data. Observation: ... Constraints: use these keys only.', {'cat1': [], 'cat2': []})`
- Batch analysis: `await reason('Goal: analyze all items. Observation: ... Constraints: return one record per item.', [{'item': '', 'summary': ''}])`
- Batched act flow: use `reason()` between `act()` calls when tool output is noisy and you need to choose the next target, branch, retry, escalate, or summarize only the signal before the next action

**Do not use it for:** cases where the exact output or exact next edit is already clear.

When writing a Python RAS script, prefer batching related `act()` calls in one run. Put `reason()` only at the decision nodes inside that batch. After a command/tool call, use `reason()` only if you need to denoise the output into a smaller structured result or the next control decision for the workflow or the user. Observation content should come directly from runtime data, not hand-written restatements.

### act(name, args) -> {content, isError}

Call MCP server tools with exact arguments.

**Tool discovery:**

- `await act('__manual__', {})`: list available tools
- `await act('__manual__', {'name': 'bash'})`: inspect one tool definition

**Parameters:**

- `name` (str): Tool name (e.g., 'bash', 'websearch', 'webfetch')
- `args`: Exact tool arguments as JSON-compatible values

**Returns:**

- `content`: Array of content blocks [{type: 'text', text: '...'}, ...]
- `isError`: Boolean indicating failure (optional)

**Available Tools:** bash (shell commands), websearch (internet search), webfetch (fetch and transform page content).

**Reusable workflows:** use the `riff` tool for recurring, stable workflows. Storage lives under `.agents/riffs/<name>/SKILL.md` and `.agents/riffs/<name>/scripts/ras.py` (or `scripts/ras.sh` for bash riffs). `riff run` executes Python riffs inline and returns a bash command for `.sh` riffs (run it with `act bash`).

## Environment Constraints

- Python runs in WebAssembly sandbox (Pyodide)
- No subprocess support (use `bash` via act for shell commands)
- Both Python file I/O and bash work for file operations

## Async Pattern (REQUIRED)

```python
import asyncio

async def main():
    result = await reason('Goal: ... Observation: ... Constraints: ...', example)
    data = await act('tool_name', {'key': 'value'})
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
        f"Goal: decide if the build succeeded. Observation: {log_content}\nConstraints: return success plus a short grounded reason.",
        {"success": False, "reason": ""}
    )

    if result['data']['success']:
        print("✓ Build succeeded! Deploying...")
        await act("bash", {"command": "git push production main"})
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
        f'Goal: analyze each news item and the overall trend. Observation: {news}. Constraints: keep each summary brief and grounded in the input.',
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
        response = await act("bash", {"command": f"curl -s {url}"})
        data = response['content'][0]['text']

        check = await reason(
            f"Goal: decide whether this API response is valid JSON. Observation: {data[:200]}. Constraints: return valid plus one short next action.",
            {"valid": False, "action": ""}
        )

        if check['data']['valid']:
            print(f"✓ {url}: Valid")
        else:
            print(f"✗ {url}: Invalid - {check['data']['action']}")
            break

asyncio.run(main())
```

### 4. Web Fetch with AI Analysis

```python
import asyncio

async def main():
    fetched = await act('webfetch', {
        'url': 'https://example.com',
        'format': 'markdown'
    })
    page_content = fetched['content'][0]['text']

    result = await reason(
        f'Goal: extract links and categorize them. Observation: {page_content[:8000]}. Constraints: return only the requested buckets.',
        {'nav_links': [], 'content_links': [], 'external_links': []}
    )
    print(result['data'])

asyncio.run(main())
```

### 5. Error Handling

```python
import asyncio

async def main():
    result = await reason('Goal: extract the items. Observation: local input data. Constraints: return {items}.', {'items': []})
    if result['error']:
        print(f"Error: {result['error']}")
    elif result['data'] is None:
        print('No data returned')
    else:
        print(result['data'])

asyncio.run(main())
```

### 6. Web Search

```python
import asyncio

async def main():
    search = await act("websearch", {
        "query": "Python asyncio cancellation best practices",
        "type": "fast",
        "numResults": 5,
    })
    print(search["content"][0]["text"])

asyncio.run(main())
```

### 7. Web Fetch

```python
import asyncio

async def main():
    result = await act("webfetch", {
        "url": "https://example.com/docs",
        "format": "text",
        "timeout": 20,
    })
    print(result["content"][0]["text"][:2000])

asyncio.run(main())
```
