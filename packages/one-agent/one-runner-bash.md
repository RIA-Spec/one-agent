---
name: one-runner
mode: agentic
deps:
  mcpServers:
    playwright:
      transportType: stdio
      command: npx
      args: ["-y", "@playwright/mcp@latest", "--isolated"]
      env:
        PLAYWRIGHT_MCP_HEADLESS: "0"
refs:
  - '<tool name="playwright.__ALL__"/>'
---

# Bash Action Execution Runtime (AER)

Control flow using unix pipes (|) and redirection (>). Intermediate data is persisted transparently on the file system.

## How to Use

Write bash commands directly. Use `reason` and `act` as commands in your pipelines.

Prefer `act` in Unix-shaped forms so it behaves like other shell commands you already know:

```bash
act bash '{"command":"ls -la"}'
jq -c '{command: .action}' result.json | act bash -
act --manual bash
```

Use discovery first when the tool name or schema is unclear:

```bash
act --manual
act --manual playwright_browser_click
act --help
```

**Example:**

```bash
cat file.txt | reason --prompt "Analyze:" --prompt - | jq -r '.summary'
```

## Built-in Commands

### reason - AI Analysis Command

Call AI for structured data extraction and decision-making in bash pipelines.

**Syntax:**

```bash
reason --prompt "text" --prompt - --structure '{"key": ""}'
```

**Options:**

- `--prompt "text"`: Add a prompt (can be used multiple times)
- `--prompt -`: Read prompt from stdin
- `--structure '{"json": ""}'`: Expected output structure (optional)

**Output:** JSON data to stdout

**Examples:**

```bash
# Simple AI call
echo "Python is awesome" | reason --prompt "Summarize:" --prompt - --structure '{"summary": ""}'

# Extract structured data
cat api_docs.md | reason --prompt "Extract API endpoints" --structure '{"endpoints": []}'
```

### act - MCP Tool Command

Execute MCP server tools with exact JSON args.

**Syntax:**

```bash
act <tool_name> '{"key":"value"}'
act <tool_name> -

# Equivalent long form
act --name "tool_name" --args '{"key":"value"}'
act --name "tool_name" --args -
```

**Options:**

- `<tool_name>`: Positional tool name (preferred in bash)
- `'{"key":"value"}'`: Positional JSON args
- `-`: Read JSON args from stdin
- `--name/--args`: Equivalent long form

**Output:** Tool execution result to stdout

**Examples:**

```bash
# Execute with direct args
act bash '{"command":"ls -la"}'

# Use stdin JSON
echo '{"url":"https://google.com"}' | act playwright_browser_navigate -
```

## Pipeline Examples

### 1. API Documentation Pipeline

```bash
# Read API docs → AI analysis → Extract summary → Execute tests
cat api_docs.md | \
  reason --prompt "Read this API documentation:" \
     --prompt - \
     --prompt "Generate a summary of how to test this API." \
     --structure '{"summary": "", "test_commands": []}' | \
    jq -c '{command: .test_commands[0]}' | \
    act bash -
```

### 2. Log Analysis Pipeline

```bash
# Analyze logs → Decide action → Execute
tail -100 app.log | \
  reason --prompt "Analyze these logs for critical errors:" \
     --prompt - \
     --structure '{"critical": false, "action": ""}' | \
  jq -c 'select(.critical) | {command: .action}' | \
    act bash -
```

### 3. Data Processing Pipeline

```bash
# Extract data → Transform with AI → Process each item
cat data.csv | \
  reason --prompt "Extract top 5 highest value items from CSV:" \
     --prompt - \
     --structure '{"items": [{"name": "", "value": 0}]}' | \
  jq -r '.items[] | "\(.name),\(.value)"' | \
  while IFS=, read name value; do
    echo "Processing: $name ($value)"
    act bash "{\"command\":\"echo Processed $name >> results.log\"}"
  done
```

### 4. Multi-step API Pipeline

```bash
# Fetch data → AI extracts errors → Filter → Log
curl -s https://api.example.com/data | \
  reason --prompt "Extract all error messages from this API response:" \
     --prompt - \
     --structure '{"errors": [{"code": "", "message": ""}]}' | \
  jq '.errors[] | select(.code | startswith("5"))' | \
  jq -r '.message' | \
  xargs -I {} act bash "{\"command\":\"echo 'Server Error: {}' >> error.log\"}"
```

### 5. Conditional Branching

```bash
# Check condition with AI → Execute based on result
cat test_results.json | \
  reason --prompt "Did all tests pass?" \
     --prompt - \
     --structure '{"all_passed": false, "action": ""}' | \
  jq -r 'if .all_passed then "deploy" else "notify" end' | \
  case $(cat) in
    deploy)
      act bash '{"command":"git push production main"}'
      ;;
    notify)
      act bash '{"command":"echo '\''Tests failed'\'' | mail -s '\''Build Failed'\'' dev@example.com"}'
      ;;
  esac
```

### 6. Browser Automation Pipeline

```bash
# Navigate → Snapshot → AI analysis → Extract data
act playwright_browser_navigate '{"url":"https://news.ycombinator.com"}' && \
act playwright_browser_snapshot '{}' | \
  reason --prompt "Extract top 5 post titles and URLs from this page:" \
     --prompt - \
     --structure '{"posts": [{"title": "", "url": ""}]}' | \
  jq -r '.posts[] | "\(.title): \(.url)"'
```

### 7. File Processing with AI

```bash
# Process multiple files in a loop
for file in *.log; do
  cat "$file" | \
    reason --prompt "Summarize errors in log:" \
       --prompt - \
       --structure '{"error_count": 0, "severity": ""}' | \
    jq -r '"\($file): \(.error_count) errors (\(.severity))"'
done
```

### 8. Web Search Pipeline

```bash
# Search first, then fetch a concrete page for details
act websearch '{"query":"TypeScript AbortSignal timeout best practices","type":"fast"}'
```

## Best Practices

### Bash AER Best For:

- ✅ Linear pipelines
- ✅ Unix tool composition (grep, awk, jq, etc.)
- ✅ Quick one-liners
- ✅ File processing streams
- ✅ DevOps automation

### Tips:

1. **Use `jq` for JSON manipulation** - Extract fields, filter, transform
2. **Pipe JSON args with `--args -`** - Pass data between commands naturally
3. **Persist intermediate data** - Save to files for debugging
4. **Check return values** - Use `$?` to check command success
5. **Chain with `&&`** - Stop pipeline on first failure
