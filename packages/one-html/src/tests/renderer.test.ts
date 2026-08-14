/**
 * Tests for StreamingHtmlRenderer
 *
 * Strategy: strip ANSI escape codes before asserting text content,
 * then separately check that bold/colour codes are present where expected.
 */
import { describe, it, expect } from "vitest";
import { StreamingHtmlRenderer } from "../renderer.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Render a complete HTML string and return the collected output lines. */
function render(html: string, columns = 80): string[] {
  const lines: string[] = [];
  const r = new StreamingHtmlRenderer({
    columns,
    onFlush: (t) => lines.push(t),
  });
  r.write(html);
  r.end();
  return lines;
}

/** Render and join all lines, stripping ANSI. */
function renderPlain(html: string, columns = 80): string {
  return render(html, columns).map(stripAnsi).join("\n");
}

// ── paragraph / block ─────────────────────────────────────────────────────────

describe("block elements", () => {
  it("renders a simple <p>", () => {
    expect(renderPlain("<p>Hello world</p>")).toBe("Hello world");
  });

  // ── bare text (no wrapping tags) ──────────────────────────────────────────────

  describe("bare text nodes", () => {
    it("renders top-level text with no tags", () => {
      expect(renderPlain("Hello world")).toBe("Hello world");
    });

    it("renders multiple bare text nodes separated by tags", () => {
      // Text before and after a tag
      const plain = renderPlain("Before<br>After");
      expect(plain).toContain("Before");
      expect(plain).toContain("After");
    });

    it("normalises whitespace in bare text", () => {
      expect(renderPlain("  lots   of   spaces  ")).toBe("lots of spaces");
    });

    it("bare text streamed in chunks still flushes on end()", () => {
      const flushed: string[] = [];
      const r = new StreamingHtmlRenderer({ onFlush: (t) => flushed.push(t) });
      r.write("Hel");
      r.write("lo");
      // top-level text nodes are flushed immediately as they arrive
      // (no block to buffer them into)
      r.end();
      const all = flushed.map(stripAnsi).join("");
      expect(all).toContain("Hello");
    });

    it("bare text mixed with block tags flushes in order", () => {
      const flushed: string[] = [];
      const r = new StreamingHtmlRenderer({ onFlush: (t) => flushed.push(t) });
      r.write("Intro text");
      r.write("<p>Block content</p>");
      r.end();
      const all = flushed.map(stripAnsi).join("\n");
      expect(all).toContain("Intro text");
      expect(all).toContain("Block content");
    });
  });

  it("renders multiple <p> as separate flushes", () => {
    const lines = render("<p>First</p><p>Second</p>");
    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[0]!)).toBe("First");
    expect(stripAnsi(lines[1]!)).toBe("Second");
  });

  it("word-wraps long paragraphs at column limit", () => {
    const word = "word ";
    const html = `<p>${word.repeat(20)}</p>`;
    const plain = renderPlain(html, 40);
    const lines = plain.split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  it("renders <div> like a paragraph", () => {
    expect(renderPlain("<div>content</div>")).toBe("content");
  });
});

// ── headings ─────────────────────────────────────────────────────────────────

describe("headings", () => {
  for (const level of [1, 2, 3, 4, 5, 6] as const) {
    it(`renders h${level} with plain text preserved`, () => {
      const plain = renderPlain(`<h${level}>Title ${level}</h${level}>`);
      expect(plain).toBe(`Title ${level}`);
    });

    it(`h${level} output contains ANSI bold codes`, () => {
      const raw = render(`<h${level}>T</h${level}>`)[0]!;
      // chalk bold = \x1b[1m or \x1b[1;... — check raw contains escape
      expect(raw).toMatch(/\x1b\[/);
    });
  }
});

// ── inline styles ─────────────────────────────────────────────────────────────

describe("inline styles", () => {
  it("<strong> applies bold", () => {
    const raw = render("<p><strong>bold</strong></p>")[0]!;
    expect(stripAnsi(raw)).toContain("bold");
    expect(raw).toMatch(/\x1b\[/); // has ANSI
  });

  it("<em> text is preserved", () => {
    expect(renderPlain("<p><em>italic</em></p>")).toContain("italic");
  });

  it("<code> text is preserved", () => {
    expect(renderPlain("<p><code>console.log()</code></p>")).toContain("console.log()");
  });

  it("<a href> appends href hint", () => {
    const plain = renderPlain('<p><a href="https://example.com">link</a></p>');
    expect(plain).toContain("link");
    expect(plain).toContain("https://example.com");
  });

  it("nested inline styles", () => {
    const plain = renderPlain("<p><strong><em>bold-italic</em></strong></p>");
    expect(plain).toContain("bold-italic");
  });
});

// ── lists ─────────────────────────────────────────────────────────────────────

describe("lists", () => {
  it("renders <ul> items with bullet prefix", () => {
    const html = "<ul><li>Alpha</li><li>Beta</li></ul>";
    const plain = renderPlain(html);
    const lines = plain.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Alpha");
    expect(lines[1]).toContain("Beta");
  });

  it("renders <ol> items with numbers", () => {
    const html = "<ol><li>One</li><li>Two</li><li>Three</li></ol>";
    const plain = renderPlain(html);
    expect(plain).toContain("One");
    expect(plain).toContain("Two");
    expect(plain).toContain("Three");
    // Numbers should appear
    expect(plain).toMatch(/1\./);
    expect(plain).toMatch(/2\./);
  });

  it("renders nested <ul>", () => {
    const html = "<ul><li>Parent<ul><li>Child</li></ul></li></ul>";
    const plain = renderPlain(html);
    expect(plain).toContain("Child");
    // Child should be indented more than parent
    const lines = plain.split("\n");
    const parentLine = lines.find((l) => l.includes("Parent"))!;
    const childLine = lines.find((l) => l.includes("Child"))!;
    const parentIndent = parentLine.match(/^( *)/)?.[1].length ?? 0;
    const childIndent = childLine.match(/^( *)/)?.[1].length ?? 0;
    expect(childIndent).toBeGreaterThan(parentIndent);
  });
});

// ── blockquote ───────────────────────────────────────────────────────────────

describe("blockquote", () => {
  it("renders <blockquote> with a leading pipe prefix", () => {
    const raw = render("<blockquote>Quote text</blockquote>")[0]!;
    expect(stripAnsi(raw)).toMatch(/│/);
    expect(stripAnsi(raw)).toContain("Quote text");
  });
});

// ── code block ───────────────────────────────────────────────────────────────

describe("pre / code block", () => {
  it("renders <pre><code> as a fenced block", () => {
    const plain = renderPlain("<pre><code>const x = 1;\nconsole.log(x);</code></pre>");
    expect(plain).toContain("const x = 1;");
    expect(plain).toContain("console.log(x);");
    // Should have border characters
    expect(plain).toMatch(/[┌└]/);
  });

  it("extracts language from class", () => {
    const raw = render(`<pre><code class="language-typescript">type X = string;</code></pre>`)[0]!;
    expect(stripAnsi(raw)).toContain("typescript");
    expect(stripAnsi(raw)).toContain("type X = string;");
  });

  it("preserves whitespace inside <pre>", () => {
    const code = "line1\n  line2\n    line3";
    const plain = renderPlain(`<pre><code>${code}</code></pre>`);
    expect(plain).toContain("  line2");
    expect(plain).toContain("    line3");
  });
});

// ── table ─────────────────────────────────────────────────────────────────────

describe("table", () => {
  const tableHtml = `
    <table>
      <thead><tr><th>Name</th><th>Score</th></tr></thead>
      <tbody>
        <tr><td>Alice</td><td>95</td></tr>
        <tr><td>Bob</td><td>87</td></tr>
      </tbody>
    </table>`;

  it("renders all rows and headers", () => {
    const plain = renderPlain(tableHtml);
    expect(plain).toContain("Name");
    expect(plain).toContain("Score");
    expect(plain).toContain("Alice");
    expect(plain).toContain("95");
    expect(plain).toContain("Bob");
    expect(plain).toContain("87");
  });

  it("has table border characters", () => {
    const plain = renderPlain(tableHtml);
    expect(plain).toMatch(/[┌┬┐]/); // top border
    expect(plain).toMatch(/[└┴┘]/); // bottom border
    expect(plain).toMatch(/[│]/); // cell separators
  });
});

// ── <hr> ─────────────────────────────────────────────────────────────────────

describe("hr", () => {
  it("renders a horizontal rule", () => {
    const plain = renderPlain("<hr>");
    expect(plain).toMatch(/─+/);
  });
});

// ── streaming (partial HTML — block not yet closed) ───────────────────────────
//
// This is the core contract of the renderer:
//   • onFlush MUST NOT fire until a block-closing tag arrives
//   • onPartial MUST grow monotonically as text arrives inside an open block
//   • final output MUST be identical regardless of how the HTML was chunked

describe("streaming — block boundary contract", () => {
  it("does NOT flush while <p> is still open", () => {
    const flushed: string[] = [];
    const r = new StreamingHtmlRenderer({ onFlush: (t) => flushed.push(t) });

    r.write("<p>Word1");
    expect(flushed).toHaveLength(0); // block open — nothing flushed yet

    r.write(" Word2");
    expect(flushed).toHaveLength(0); // still open

    r.write(" Word3");
    expect(flushed).toHaveLength(0); // still open

    r.write("</p>");
    expect(flushed).toHaveLength(1); // close tag → flush exactly once
    expect(stripAnsi(flushed[0]!)).toBe("Word1 Word2 Word3");
  });

  it("does NOT flush while <h2> is still open", () => {
    const flushed: string[] = [];
    const r = new StreamingHtmlRenderer({ onFlush: (t) => flushed.push(t) });

    r.write("<h2>Part");
    expect(flushed).toHaveLength(0);
    r.write("ial head");
    expect(flushed).toHaveLength(0);
    r.write("ing</h2>");
    expect(flushed).toHaveLength(1);
    expect(stripAnsi(flushed[0]!)).toContain("Partial heading");
  });

  it("does NOT flush while <li> is still open", () => {
    const flushed: string[] = [];
    const r = new StreamingHtmlRenderer({ onFlush: (t) => flushed.push(t) });

    r.write("<ul><li>Item");
    expect(flushed).toHaveLength(0);
    r.write(" content</li></ul>");
    expect(flushed).toHaveLength(1);
    expect(stripAnsi(flushed[0]!)).toContain("Item content");
  });

  it("flushes blocks in arrival order, not all at end", () => {
    const flushed: string[] = [];
    const r = new StreamingHtmlRenderer({ onFlush: (t) => flushed.push(t) });

    r.write("<p>First</p>");
    expect(flushed).toHaveLength(1); // first block closed immediately

    r.write("<p>Second part");
    expect(flushed).toHaveLength(1); // second block still open

    r.write(" more</p>");
    expect(flushed).toHaveLength(2); // second block now closed

    r.write("<p>Third</p>");
    expect(flushed).toHaveLength(3);

    expect(flushed.map(stripAnsi)).toEqual(["First", "Second part more", "Third"]);
  });

  it("table: does NOT flush rows until </table>", () => {
    const flushed: string[] = [];
    const r = new StreamingHtmlRenderer({ onFlush: (t) => flushed.push(t) });

    r.write("<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>");
    expect(flushed).toHaveLength(0); // rows accumulate, no flush yet

    r.write("<tr><td>1</td><td>2</td></tr>");
    expect(flushed).toHaveLength(0);

    r.write("</tbody></table>");
    expect(flushed).toHaveLength(1); // entire table flushed at once
    const plain = stripAnsi(flushed[0]!);
    expect(plain).toContain("A");
    expect(plain).toContain("B");
    expect(plain).toContain("1");
    expect(plain).toContain("2");
  });
});

describe("streaming — onPartial grows monotonically", () => {
  it("partial text grows word by word inside an open <p>", () => {
    const partials: string[] = [];
    const r = new StreamingHtmlRenderer({
      onPartial: (p) => partials.push(stripAnsi(p)),
    });

    r.write("<p>Alpha");
    r.write(" Beta");
    r.write(" Gamma");
    // Block not closed — should have 3 partials
    expect(partials.length).toBe(3);
    // Each partial must contain at least what the previous one did
    expect(partials[0]).toContain("Alpha");
    expect(partials[1]).toContain("Alpha");
    expect(partials[1]).toContain("Beta");
    expect(partials[2]).toContain("Alpha");
    expect(partials[2]).toContain("Beta");
    expect(partials[2]).toContain("Gamma");
  });

  it("no partial emitted for an empty open block", () => {
    const partials: string[] = [];
    const r = new StreamingHtmlRenderer({
      onPartial: (p) => partials.push(p),
    });
    r.write("<p>");
    expect(partials).toHaveLength(0); // no text yet — nothing to show
  });

  it("partial is cleared (not emitted) after block closes", () => {
    const partials: string[] = [];
    const flushed: string[] = [];
    const r = new StreamingHtmlRenderer({
      onFlush: (t) => flushed.push(t),
      onPartial: (p) => partials.push(stripAnsi(p)),
    });

    r.write("<p>Text</p>");
    // After close the block is gone — next write starts fresh
    const countAfterClose = partials.length;

    r.write("<p>Next");
    // partial for new block should be emitted
    expect(partials.length).toBeGreaterThan(countAfterClose);
    expect(partials[partials.length - 1]).toContain("Next");
  });
});

describe("streaming — output idempotent across chunk sizes", () => {
  const fullHtml =
    "<h1>Title</h1>" +
    "<p>Paragraph with <strong>bold</strong> and <em>italic</em> words.</p>" +
    "<ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>" +
    "<blockquote>A quoted sentence.</blockquote>" +
    "<pre><code>const x = 1;</code></pre>";

  /** Render with a given chunk size, return plain-text output. */
  function renderChunked(chunkSize: number): string {
    const lines: string[] = [];
    const r = new StreamingHtmlRenderer({
      columns: 80,
      onFlush: (t) => lines.push(t),
    });
    for (let i = 0; i < fullHtml.length; i += chunkSize) {
      r.write(fullHtml.slice(i, i + chunkSize));
    }
    r.end();
    return lines.map(stripAnsi).join("\n");
  }

  const reference = renderChunked(fullHtml.length); // one shot

  for (const size of [1, 3, 7, 13, 50]) {
    it(`chunk size ${size} produces identical output`, () => {
      expect(renderChunked(size)).toBe(reference);
    });
  }

  it("output contains all expected content sections", () => {
    expect(reference).toContain("Title");
    expect(reference).toContain("bold");
    expect(reference).toContain("italic");
    expect(reference).toContain("Alpha");
    expect(reference).toContain("A quoted sentence");
    expect(reference).toContain("const x = 1;");
  });
});

// ── original chunked-input tests (parser robustness) ─────────────────────────

describe("streaming — partial chunks (parser robustness)", () => {
  it("handles chunks split mid-tag", () => {
    const lines: string[] = [];
    const r = new StreamingHtmlRenderer({ onFlush: (t) => lines.push(t) });
    r.write("<p>Hello");
    r.write(" world</p>");
    r.end();
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toBe("Hello world");
  });

  it("handles chunks split inside an HTML entity", () => {
    const lines: string[] = [];
    const r = new StreamingHtmlRenderer({ onFlush: (t) => lines.push(t) });
    r.write("<p>A &amp");
    r.write("; B</p>");
    r.end();
    expect(stripAnsi(lines[0]!)).toBe("A & B");
  });

  it("handles extremely small chunks (1 char at a time)", () => {
    const html = "<p>Streaming</p>";
    const lines: string[] = [];
    const r = new StreamingHtmlRenderer({ onFlush: (t) => lines.push(t) });
    for (const char of html) r.write(char);
    r.end();
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toBe("Streaming");
  });

  it("multiple blocks streamed incrementally", () => {
    const html = "<h1>Title</h1><p>Para one</p><ul><li>Item A</li><li>Item B</li></ul>";
    const chunks = [];
    for (let i = 0; i < html.length; i += 5) chunks.push(html.slice(i, i + 5));

    const lines: string[] = [];
    const r = new StreamingHtmlRenderer({ onFlush: (t) => lines.push(t) });
    for (const c of chunks) r.write(c);
    r.end();

    const all = lines.map(stripAnsi).join("\n");
    expect(all).toContain("Title");
    expect(all).toContain("Para one");
    expect(all).toContain("Item A");
    expect(all).toContain("Item B");
  });
});

// ── bare tag fragment repair (LLMs sometimes drop "<" / "</" on a tag) ───────

describe("bare tag fragment repair", () => {
  it("repairs a bare 'li>' as the closing tag of an open item", () => {
    const plain = renderPlain("<ul>\n<li>第一项：传入li>\n<li>第二项</li>\n</ul>");
    expect(plain).toContain("第一项：传入");
    expect(plain).not.toContain("li>");
    expect(plain).toContain("第二项");
  });

  it("repairs a bare 'p>' as the closing tag of an open paragraph", () => {
    const plain = renderPlain("<p>这个信息来自系统提示词，而不是工具定义p>");
    expect(plain).toContain("这个信息来自系统提示词，而不是工具定义");
    expect(plain).not.toContain("p>");
  });

  it("closes an open inline tag on a bare 'strong>' fragment", () => {
    const plain = renderPlain("<p>这是<strong>重点</strong>strong>内容</p>");
    expect(plain).toBe("这是重点内容");
    expect(plain).not.toContain("strong>");
  });

  it("opens an inline tag on a bare multi-letter fragment when nothing is open", () => {
    const plain = renderPlain("<p>这是strong>重点</strong>内容</p>");
    expect(plain).toBe("这是重点内容");
    expect(plain).not.toContain("strong>");
  });

  it("does not repair 'a > b' style prose", () => {
    const plain = renderPlain("<p>use a > b and i > 0</p>");
    expect(plain).toContain("a > b");
    expect(plain).toContain("i > 0");
  });

  it("does not repair fragments inside <pre> code", () => {
    const plain = renderPlain("<pre><code>echo li>;</code></pre>");
    expect(plain).toContain("echo li>;");
  });

  it("repairs a space-separated bare 'code>' fragment", () => {
    const plain = renderPlain("<p>注意 code>用法</p>");
    expect(plain).toContain("注意 用法");
    expect(plain).not.toContain("code>");
  });

  it("keeps correct block order after repairing a split fragment", () => {
    const flushed: string[] = [];
    const r = new StreamingHtmlRenderer({ onFlush: (t) => flushed.push(t) });
    r.write("<p>intro</p><p>第一项：传入li>\n<li>第二项</li></p>");
    r.end();
    const out = flushed.map(stripAnsi).join("\n");
    expect(out.indexOf("intro")).toBeLessThan(out.indexOf("第一项"));
    expect(out).not.toContain("li>");
  });
});

// ── flush() collection mode ───────────────────────────────────────────────────

describe("flush() collection mode", () => {
  it("collects output when no onFlush provided", () => {
    const r = new StreamingHtmlRenderer();
    r.write("<p>Collected</p>");
    r.end();
    expect(stripAnsi(r.flush())).toBe("Collected");
  });

  it("multiple flushes are joined with newline", () => {
    const r = new StreamingHtmlRenderer();
    r.write("<p>Line 1</p><p>Line 2</p>");
    r.end();
    const out = stripAnsi(r.flush());
    expect(out).toContain("Line 1");
    expect(out).toContain("Line 2");
  });
});

// ── intentional failures — demonstrates reason's diagnostic value ─────────────

describe("INTENTIONAL FAILURES — reason demo", () => {
  it.fails("wrong expected text (actual: 'Hello', expected: 'Goodbye')", () => {
    const flushed: string[] = [];
    const r = new StreamingHtmlRenderer({ onFlush: (t) => flushed.push(t) });
    r.write("<p>Hello</p>");
    expect(stripAnsi(flushed[0]!)).toBe("Goodbye");
  });

  it.fails("wrong flush count (actual: 2 flushes, expected: 5)", () => {
    const flushed: string[] = [];
    const r = new StreamingHtmlRenderer({ onFlush: (t) => flushed.push(t) });
    r.write("<p>A</p><p>B</p>");
    r.end();
    expect(flushed).toHaveLength(5);
  });

  it.fails("wrong partial growth (asserts partial does NOT contain streamed text)", () => {
    const partials: string[] = [];
    const r = new StreamingHtmlRenderer({
      onPartial: (p) => partials.push(stripAnsi(p)),
    });
    r.write("<p>Streaming");
    r.write(" content");
    expect(partials[partials.length - 1]).not.toContain("content");
  });
});
