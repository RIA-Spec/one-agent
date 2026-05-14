/**
 * HTML-mode prompt extension.
 *
 * Wraps AGENT_SYSTEM_PROMPT with an extra instruction that makes the agent
 * format its *natural-language* response text as HTML so the REPL can parse
 * it with StreamingHtmlRenderer for rich terminal output.
 *
 * Tool-use / code blocks are kept as-is — only the narrative reply needs HTML.
 */
import { AGENT_SYSTEM_PROMPT } from "./prompts.js";

const HTML_OUTPUT_RULE = `
<response_format>
Format ALL natural-language response text as HTML. Rules:
- Paragraphs: wrap in <p>...</p>
- Section headings: use <h2> or <h3> (not h1)
- Bullet lists: <ul><li>...</li></ul>
- Numbered lists: <ol><li>...</li></ol>
- Code spans inline: <code>...</code>
- Code blocks: <pre><code class="language-LANG">...</code></pre>
- Bold emphasis: <strong>...</strong>
- Italic emphasis: <em>...</em>
- Blockquotes / key notes: <blockquote>...</blockquote>
- Horizontal dividers: <hr>
- Do NOT wrap the entire response in a root tag.
- Do NOT output raw Markdown (no **, no __, no # headings, no \`\`\`fences\`\`\`).
</response_format>`;

export const AGENT_HTML_SYSTEM_PROMPT = `${AGENT_SYSTEM_PROMPT}${HTML_OUTPUT_RULE}`;
