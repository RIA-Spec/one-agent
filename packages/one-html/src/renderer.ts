import { Parser } from "htmlparser2";
import { Chalk } from "chalk";
import wrapAnsi from "wrap-ansi";
import stringWidth from "string-width";
import {
  BLOCK_TAGS,
  INLINE_STYLE_TAGS,
  type HeadingLevel,
  applyInlineOpen,
  styleHeading,
  styleBlockquote,
  styleHr,
  styleCodeBlock,
  type ChalkChain,
} from "./ansi.js";

/** All tags the renderer knows how to style, used for bare-fragment repair. */
const KNOWN_TAGS = new Set<string>([...BLOCK_TAGS, ...INLINE_STYLE_TAGS]);

/**
 * Matches a bare "name>" fragment: a known tag name immediately followed by
 * ">" and not preceded by "<", "/", or an ASCII word char, so real tags
 * ("<li>", "</li>"), prose ("a > b") and merged tags ("<pstrong>") are left
 * alone.
 */
const BARE_TAG_FRAGMENT = /(?<!<)(?<![a-zA-Z0-9_/])([a-zA-Z][a-zA-Z0-9]*)>/g;

// Force color output regardless of TTY detection (useful in tests / piped output)
const chalk = new Chalk({ level: 3 });

export interface HtmlRendererOptions {
  /**
   * Terminal column width for word-wrapping. Default: 80.
   */
  columns?: number;
  /**
   * Callback fired when a complete, stable line (or block) is ready.
   * In streaming mode the host calls this to write to stdout.
   * If omitted, output is collected and returned by `flush()`.
   */
  onFlush?: (text: string) => void;
  /**
   * Callback fired after each chunk with the current "in-progress" partial line
   * that hasn't been finalised yet. Host can use this to rewrite the last line
   * with `process.stdout.write('\r\x1b[K' + partial)`.
   */
  onPartial?: (partial: string) => void;
}

/** Tag context stacked when we enter a block element. */
interface BlockFrame {
  tag: string;
  /** Text accumulated inside this block (already styled for inline content). */
  text: string;
  /** For <pre>: the code language extracted from <code class="language-xxx"> */
  codeLang?: string;
  /** For headings: 1-6 */
  headingLevel?: HeadingLevel;
  /** For list items: the bullet prefix already resolved */
  listBullet?: string;
}

/** Ordered/unordered list context for nested lists. */
interface ListFrame {
  tag: "ul" | "ol";
  counter: number; // only meaningful for ol
  indent: number; // spaces before bullet
}

export class StreamingHtmlRenderer {
  private readonly opts: Required<Omit<HtmlRendererOptions, "onFlush" | "onPartial">> & {
    onFlush?: (t: string) => void;
    onPartial?: (t: string) => void;
  };

  private parser: Parser;

  /** Output collected when no onFlush provided. */
  private collected: string[] = [];

  /** Stack of open block contexts. Innermost block = last element. */
  private blockStack: BlockFrame[] = [];

  /** Stack of list contexts for bullet/number generation. */
  private listStack: ListFrame[] = [];

  /** Stack of open inline tag names (kept in sync with inlineStack). */
  private inlineTagStack: string[] = [];

  /** Current inline chalk chain (accumulated from open inline tags). */
  private inlineChain: ChalkChain = chalk as unknown as ChalkChain;
  /** Stack of chalk chains — restored on close tag. */
  private inlineStack: ChalkChain[] = [];

  /** Inside <pre>: true — disables word-wrap, preserves whitespace. */
  private inPre = false;

  /** Table cell buffer: row → cells. */
  private tableRows: string[][] = [];
  private currentRow: string[] = [];
  private currentCell = "";
  private inTableCell = false;

  /** Whether we're inside a <blockquote> (may be nested). */
  private blockquoteDepth = 0;

  /**
   * Buffer for top-level text nodes (text that arrives outside any block tag).
   * Instead of flushing each streaming chunk immediately (which creates one
   * line per word/character), we accumulate here and flush at the next block
   * boundary or on end().
   */
  private topLevelBuffer = "";

  constructor(opts: HtmlRendererOptions = {}) {
    this.opts = {
      columns: opts.columns ?? 80,
      onFlush: opts.onFlush,
      onPartial: opts.onPartial,
    };

    this.parser = new Parser(
      {
        onopentag: (name, attrs) => this.handleOpen(name, attrs),
        ontext: (text) => this.handleText(text),
        onclosetag: (name) => this.handleClose(name),
      },
      { decodeEntities: true },
    );
  }

  /** Feed a chunk of HTML (may be partial/incomplete). */
  write(chunk: string): void {
    this.parser.write(chunk);
    this.emitPartial();
  }

  /** Finalise: flush any remaining partial content and reset state. */
  end(): void {
    this.parser.end();
    this.flushTopLevelBuffer();
    this.emitPartial();
  }

  /** Return all collected output (only useful when no onFlush provided). */
  flush(): string {
    return this.collected.join("\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SAX handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleOpen(tag: string, attrs: Record<string, string | null>): void {
    // Inline tags: push chalk chain modification
    if (INLINE_STYLE_TAGS.has(tag)) {
      // Special case: <code class="language-xxx"> inside <pre>
      // Extract language and store on the enclosing pre frame.
      // Do NOT apply cyan styling — text inside <pre><code> will be fully
      // replaced by syntax highlighting at flush time.
      if (tag === "code" && this.inPre) {
        const cls = attrs["class"] ?? "";
        const m = cls.match(/language-(\w+)/);
        if (m) {
          // Find the pre frame and attach codeLang
          const preFrame = [...this.blockStack].reverse().find((f) => f.tag === "pre");
          if (preFrame) preFrame.codeLang = m[1];
        }
        // Push identity chain — no color change inside pre/code
        this.inlineStack.push(this.inlineChain);
        this.inlineTagStack.push(tag);
        return;
      }

      this.inlineStack.push(this.inlineChain);
      this.inlineTagStack.push(tag);
      this.inlineChain = applyInlineOpen(tag, this.inlineChain) as ChalkChain;

      // <a href>: note we will append href later on close if different from text
      if (tag === "a" && attrs["href"]) {
        // store href for close handler to optionally append
        this._pendingHref = attrs["href"] ?? undefined;
      }
      return;
    }

    // Table cell open — start buffering
    if (tag === "td" || tag === "th") {
      this.inTableCell = true;
      this.currentCell = "";
      if (tag === "th") {
        this.inlineStack.push(this.inlineChain);
        this.inlineChain = chalk.bold as unknown as ChalkChain;
      }
      return;
    }

    // Block tags
    if (BLOCK_TAGS.has(tag)) {
      // Flush any buffered top-level text before entering a new block.
      this.flushTopLevelBuffer();
      if (tag === "pre") this.inPre = true;
      if (tag === "table") {
        this.tableRows = [];
      }
      if (tag === "tr") {
        this.currentRow = [];
      }
      if (tag === "ul" || tag === "ol") {
        const indent = this.listStack.length * 2;
        this.listStack.push({ tag, counter: 0, indent });
      }
      if (tag === "blockquote") this.blockquoteDepth++;

      let headingLevel: HeadingLevel | undefined;
      let listBullet: string | undefined;

      if (/^h[1-6]$/.test(tag)) {
        headingLevel = parseInt(tag[1]!) as HeadingLevel;
      }
      if (tag === "li") {
        const list = this.listStack[this.listStack.length - 1];
        if (list) {
          if (list.tag === "ol") {
            list.counter++;
            listBullet = " ".repeat(list.indent) + chalk.bold(`${list.counter}.`) + " ";
          } else {
            listBullet = " ".repeat(list.indent) + chalk.bold("•") + " ";
          }
        }
      }

      this.blockStack.push({ tag, text: "", headingLevel, listBullet });
      return;
    }

    if (tag === "br") {
      this.appendToCurrentBlock("\n");
    }
  }

  private _pendingHref: string | undefined;

  private handleText(text: string): void {
    if (!this.inPre) {
      // Normalise whitespace outside pre
      text = text.replace(/\s+/g, " ");
    }
    if (!text) return;

    if (this.inPre) {
      // Inside <pre> the text is code — never repair bare tag fragments.
      const styled = (this.inlineChain as unknown as { (s: string): string })(text);
      this.appendCurrentText(styled);
      return;
    }

    this.emitTextWithRepair(text);
  }

  /**
   * LLMs emitting HTML sometimes drop the angle bracket on a tag, leaving a
   * bare fragment like "li>" or "strong>" in the text stream. Repair those
   * fragments using the current open-tag state: a fragment matching an open
   * element is a mangled closing tag; an inline fragment matching nothing is
   * treated as a mangled opening tag.
   */
  private emitTextWithRepair(text: string): void {
    let index = 0;
    BARE_TAG_FRAGMENT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BARE_TAG_FRAGMENT.exec(text))) {
      const name = match[1]!.toLowerCase();
      this.appendCurrentText(text.slice(index, match.index));
      if (KNOWN_TAGS.has(name)) {
        this.applyBareTag(name);
      } else {
        this.appendCurrentText(match[0]);
      }
      index = match.index + match[0].length;
    }
    this.appendCurrentText(text.slice(index));
  }

  private appendCurrentText(text: string): void {
    if (!text) return;
    const styled = (this.inlineChain as unknown as { (s: string): string })(text);
    if (this.inTableCell) {
      this.currentCell += styled;
      return;
    }
    this.appendToCurrentBlock(styled);
  }

  /** Interpret a bare "name>" fragment as an open or close tag. */
  private applyBareTag(name: string): void {
    if (BLOCK_TAGS.has(name)) {
      // A bare block fragment is always a mangled closing tag; drop it if
      // the element isn't open (it can't start a block without "<").
      if (this.blockStack.some((frame) => frame.tag === name)) {
        this.handleClose(name);
      }
      return;
    }

    // Inline fragments: close if the element is open, otherwise treat the
    // fragment as a mangled opening tag (multi-letter names only, to avoid
    // false positives on single-letter words like "a>" or "b>").
    if (this.inlineTagStack.includes(name)) {
      this.handleClose(name);
    } else if (name.length > 1) {
      this.handleOpen(name, {});
    } else {
      this.appendCurrentText(name + ">");
    }
  }

  private handleClose(tag: string): void {
    // Inline close
    if (INLINE_STYLE_TAGS.has(tag)) {
      if (tag === "a" && this._pendingHref) {
        // Append href if not the same as link text content
        const frame = this.blockStack[this.blockStack.length - 1];
        if (frame && this._pendingHref) {
          // The text was already appended; append a dim URL hint
          const hrefStyled = chalk.dim(` <${this._pendingHref}>`);
          frame.text += hrefStyled;
        }
        this._pendingHref = undefined;
      }
      const prev = this.inlineStack.pop();
      if (prev !== undefined) this.inlineChain = prev;
      this.inlineTagStack.pop();
      return;
    }

    // Table cell close
    if (tag === "td" || tag === "th") {
      this.currentRow.push(this.currentCell.trim());
      this.currentCell = "";
      this.inTableCell = false;
      if (tag === "th") {
        const prev = this.inlineStack.pop();
        if (prev !== undefined) this.inlineChain = prev;
      }
      return;
    }

    // <tr> close — push row to table buffer
    if (tag === "tr") {
      this.tableRows.push([...this.currentRow]);
      this.currentRow = [];
      return;
    }

    // <table> close — render full table and flush
    if (tag === "table") {
      const tableText = renderTable(this.tableRows);
      this.tableRows = [];
      this.flushLine(tableText);
      // Remove the block frame if pushed
      const top = this.blockStack[this.blockStack.length - 1];
      if (top?.tag === "table") this.blockStack.pop();
      return;
    }

    // List container close
    if (tag === "ul" || tag === "ol") {
      this.listStack.pop();
    }

    if (tag === "blockquote") {
      this.blockquoteDepth = Math.max(0, this.blockquoteDepth - 1);
    }

    if (!BLOCK_TAGS.has(tag)) return;

    // Block close — pop and flush
    const frame = this.blockStack.pop();
    if (!frame) return;

    if (frame.tag === "pre") {
      this.inPre = false;
      const code = frame.text.trimEnd();
      this.flushLine(styleCodeBlock(code, frame.codeLang));
      return;
    }

    if (frame.tag === "hr") {
      this.flushLine(styleHr(this.opts.columns));
      return;
    }

    const text = frame.text.trim();
    if (!text && frame.tag !== "br") return;

    if (frame.headingLevel) {
      const wrapped = wrapAnsi(text, this.opts.columns - frame.headingLevel - 1, {
        hard: false,
        trim: false,
      });
      this.flushLine(styleHeading(frame.headingLevel, wrapped));
      return;
    }

    if (frame.tag === "li" && frame.listBullet) {
      const indent = " ".repeat((frame.listBullet.match(/^ +/)?.[0].length ?? 0) + 2);
      const wrapped = wrapAnsi(text, this.opts.columns - indent.length, {
        hard: false,
        trim: false,
      })
        .split("\n")
        .map((line, i) => (i === 0 ? frame.listBullet + line : indent + line))
        .join("\n");
      if (this.blockquoteDepth > 0) {
        this.flushLine(styleBlockquote(wrapped));
      } else {
        this.flushLine(wrapped);
      }
      return;
    }

    if (frame.tag === "blockquote") {
      const wrapped = wrapAnsi(text, this.opts.columns - 2, {
        hard: false,
        trim: false,
      });
      this.flushLine(styleBlockquote(wrapped));
      return;
    }

    if (["p", "div", "section", "article"].includes(frame.tag)) {
      const wrapped = wrapAnsi(text, this.opts.columns, {
        hard: false,
        trim: false,
      });
      if (this.blockquoteDepth > 0) {
        this.flushLine(styleBlockquote(wrapped));
      } else {
        this.flushLine(wrapped);
      }
      return;
    }

    // h1-h6 handled above; remaining block types: just emit
    if (text) {
      const wrapped = wrapAnsi(text, this.opts.columns, {
        hard: false,
        trim: false,
      });
      this.flushLine(wrapped);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private appendToCurrentBlock(text: string): void {
    if (this.blockStack.length > 0) {
      this.blockStack[this.blockStack.length - 1]!.text += text;
    } else {
      // Top-level text node — buffer until a block boundary or end().
      // Previously this flushed each chunk immediately, which produced one
      // line per streaming token (e.g. every word on its own line).
      this.topLevelBuffer += text;
    }
  }

  /** Flush accumulated top-level text as a single wrapped line. */
  private flushTopLevelBuffer(): void {
    const raw = this.topLevelBuffer.trim();
    this.topLevelBuffer = "";
    if (!raw) return;
    const wrapped = wrapAnsi(raw, this.opts.columns, { hard: false, trim: false });
    if (wrapped) this.flushLine(wrapped);
  }

  private flushLine(text: string): void {
    if (!text) return;
    if (this.opts.onFlush) {
      this.opts.onFlush(text);
    } else {
      this.collected.push(text);
    }
  }

  /** Emit current partial block content (the "live" incomplete block). */
  private emitPartial(): void {
    if (!this.opts.onPartial) return;
    const top = this.blockStack[this.blockStack.length - 1];
    if (!top) return;
    const text = top.text.trim();
    if (!text) return;
    this.opts.onPartial(text);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Table renderer — align columns with fixed-width padding
// ─────────────────────────────────────────────────────────────────────────────

function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";

  const colCount = Math.max(...rows.map((r) => r.length));
  const colWidths: number[] = Array(colCount).fill(0);

  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      colWidths[c] = Math.max(colWidths[c]!, stringWidth(row[c] ?? ""));
    }
  }

  const lines: string[] = [];
  const sep = chalk.gray("┼" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┼");

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const cells = colWidths.map((w, c) => {
      const cell = row[c] ?? "";
      const pad = w - stringWidth(cell);
      return " " + cell + " ".repeat(Math.max(0, pad)) + " ";
    });
    lines.push(chalk.gray("│") + cells.join(chalk.gray("│")) + chalk.gray("│"));
    // Insert separator after header row (row 0)
    if (r === 0) lines.push(sep);
  }

  const top =
    chalk.gray("┌") +
    colWidths.map((w) => chalk.gray("─".repeat(w + 2))).join(chalk.gray("┬")) +
    chalk.gray("┐");
  const bottom =
    chalk.gray("└") +
    colWidths.map((w) => chalk.gray("─".repeat(w + 2))).join(chalk.gray("┴")) +
    chalk.gray("┘");

  return [top, ...lines, bottom].join("\n");
}
