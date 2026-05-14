# @one-agent/html

Streaming HTML → ANSI terminal renderer for ONE agent output.

Parses an HTML stream chunk-by-chunk and emits styled, word-wrapped ANSI text suitable for direct terminal output. Used internally by the `one repl` HTML REPL and available as a standalone library.

## Install

```bash
npm install @one-agent/html
# or
pnpm add @one-agent/html
```

## Quick start

```typescript
import { StreamingHtmlRenderer, initSyntaxHighlighting } from "@one-agent/html";

// Optional: pre-warm the syntax highlighter (avoids first-call latency)
await initSyntaxHighlighting();

const renderer = new StreamingHtmlRenderer({
  columns: process.stdout.columns ?? 80,
  onFlush: (text) => {
    process.stdout.write(text + "\n");
  },
});

// Feed chunks as they arrive from the LLM stream
for await (const chunk of htmlStream) {
  renderer.write(chunk);
}
renderer.end();
```

## API

### `new StreamingHtmlRenderer(options)`

Creates a new renderer instance.

```typescript
interface HtmlRendererOptions {
  /** Terminal column width for word-wrapping. Default: 80. */
  columns?: number;

  /**
   * Called when a complete block (paragraph, heading, code block, …) is ready.
   * If omitted, collect output with flush() instead.
   */
  onFlush?: (text: string) => void;

  /**
   * Called after each chunk with the current in-progress partial line.
   * Use to rewrite the last line: process.stdout.write('\r\x1b[K' + partial)
   */
  onPartial?: (partial: string) => void;
}
```

#### `renderer.write(chunk: string)`

Feed a new chunk of HTML. Safe to call with partial tags across chunk boundaries.

#### `renderer.end()`

Signal end-of-stream. Flushes any buffered content.

#### `renderer.flush(): string`

Returns all buffered output as a single string (when no `onFlush` callback is set).

### `initSyntaxHighlighting(): Promise<void>`

Pre-warms the [Shiki](https://shiki.style/) syntax highlighter. Call once at startup to avoid latency on the first code block. Safe to call multiple times (no-op after first load).

### `highlightCode(code: string, lang: string): string`

Highlight a code string synchronously and return ANSI-colored text. Returns the original string if the highlighter is not yet initialised or the language is unsupported.

## Supported HTML elements

| Element | Rendering |
|---------|-----------|
| `<p>` | Word-wrapped paragraph |
| `<h1>`–`<h6>` | Bold + colored headings with `#` prefix |
| `<pre><code>` | Syntax-highlighted code block with line numbers |
| `<code>` (inline) | Dimmed monospace |
| `<strong>`, `<b>` | Bold |
| `<em>`, `<i>` | Italic |
| `<s>`, `<del>` | Strikethrough |
| `<blockquote>` | Indented with `▌` gutter |
| `<ul>`, `<ol>` | Nested lists with `•` / numbered bullets |
| `<li>` | List item |
| `<hr>` | Horizontal rule |
| `<br>` | Line break |
| `<a>` | Underlined text (href shown if different from text) |

## License

Apache-2.0 — see `LICENSE` and `NOTICE` at the repository root.
