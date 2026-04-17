---
name: one-runner
mode: agentic
deps:
  mcpServers: {}
refs: []
---

# Bash Reason-able Action Space (RAS)

Run a Bash RAS using unix pipes (|) and redirection (>). Deterministic control flow stays in a just-bash sandbox while intermediate data is persisted on the mounted workspace file system.

## How to Use

Write bash commands directly. Use `reason` and `act` as commands in your pipelines.

Direct shell commands run inside just-bash. Use `act bash ...` when you explicitly need the real host bash tool.

Prefer `act` in Unix-shaped forms so it behaves like other shell commands you already know:

```bash
act bash '{"command":"ls -la"}'
jq -c '{command: .action}' result.json | act bash -
act --manual bash
```

Critical output rule: `act` already prints plain stdout-style text in bash mode.

```bash
# Wrong: act is not returning an MCP wrapper here
act bash '{"command":"date +%Y-%m-%d"}' | jq -r '.content[0].text'

# Right
act bash '{"command":"date +%Y-%m-%d"}'
```

Only use `jq` after `act` when the tool's text output is itself JSON that you intentionally want to parse.

Use discovery first when the tool name or schema is unclear:

```bash
act --manual
act --manual webfetch
act --help
```

**Example:**

```bash
cat file.txt | reason --prompt "Analyze:" --prompt - | jq -r '.summary'
```

## Built-in Commands

### reason - Local Judgment Command

Use `reason` only when local evidence inside the RAS must be denoised into a judgment, a smaller structured result, or the next-step decision.

Do not manually rewrite or hand-type `act` output into a new `reason` prompt. Pipe current command/tool output to `reason` directly (for example with `--prompt -` and stdin), or pass it through variables/parsers first.

**Syntax:**

```bash
reason --prompt "text" --prompt - --structure '{"key": ""}'
```

**Options:**

- `--prompt "text"`: Add a prompt (can be used multiple times)
- `--prompt -`: Read prompt from stdin
- `--structure '{"json": ""}'`: Expected output structure (optional)

**Output:** JSON data to stdout matching the requested structure

**Examples:**

```bash
# Simple local judgment
echo "Python is awesome" | reason --prompt "Summarize:" --prompt - --structure '{"summary": ""}'

# Extract structured data
cat api_docs.md | reason --prompt "Extract API endpoints" --structure '{"endpoints": []}'
```

Do not use `reason` when the exact output or exact next edit is already clear.

When batching multiple `act` calls in one shell session, place `reason` at the decision nodes inside that batch. After a command/tool call, use `reason` only if you need to denoise the output into a smaller structured result or the next control decision for the next step or for the user. Keep the observation flow machine-to-machine (pipe/variable), not hand-written.

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

**Output:** Plain text rendered to stdout. In bash mode, use shell exit codes for failure handling instead of parsing wrapper fields like `.isError` or `.content[0].text`.

**Examples:**

```bash
# Execute with direct args
act bash '{"command":"ls -la"}'

# Use stdin JSON
echo '{"url":"https://google.com","format":"text"}' | act webfetch -
```

### riff - Reusable Workflow Command

Use the `riff` tool for recurring, stable workflows that should be saved and reused.

Examples:

```bash
act riff '{"action":"list"}'
act riff '{"action":"read","name":"10-life-hacks","includeScript":true}'
act riff '{"action":"run","name":"10-life-hacks"}'
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
act webfetch '{"url":"https://api.example.com/data","format":"text"}' | \
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

### 6. Web Fetch + Analysis Pipeline

```bash
# Fetch page content → AI analysis → Extract data
act webfetch '{"url":"https://news.ycombinator.com","format":"markdown"}' | \
  head -c 12000 | \
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

### 8. Web Search + Fetch Pipeline

```bash
# Search first, then fetch a concrete page for details
act websearch '{"query":"TypeScript AbortSignal timeout best practices","type":"fast"}'
```

## Best Practices

### Bash RAS Best For:

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
6. **Remember the runtime split** - direct shell runs in just-bash; `act bash` runs on the real host bash tool
