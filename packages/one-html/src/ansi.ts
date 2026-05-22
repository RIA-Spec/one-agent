/**
 * ANSI style helpers — maps HTML tags to chalk modifiers.
 * Kept separate so renderer.ts stays focused on parsing logic.
 */
import { Chalk } from "chalk";
import { highlightCode } from "./syntax.js";
// Force colors regardless of TTY detection
const chalk = new Chalk({ level: 3 });

export type ChalkChain = typeof chalk;

/** Block-level tags that flush output as their own paragraph. */
export const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "aside",
  "nav",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "table",
  "thead",
  "tbody",
  "tr",
  "hr",
  "br",
]);

/** Inline tags that only modify chalk styling. */
export const INLINE_STYLE_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "strike",
  "code",
  "mark",
  "small",
  "sup",
  "sub",
  "span",
  "a",
  "abbr",
]);

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Apply chalk styling for an opening inline tag. Returns new chalk chain. */
export function applyInlineOpen(tag: string, c: ChalkChain): ChalkChain {
  switch (tag) {
    case "b":
    case "strong":
      return c.bold as unknown as ChalkChain;
    case "i":
    case "em":
      return c.italic as unknown as ChalkChain;
    case "u":
      return c.underline as unknown as ChalkChain;
    case "s":
    case "del":
    case "strike":
      return c.strikethrough as unknown as ChalkChain;
    case "code":
      // No background — dark bg looks terrible on light themes.
      // cyan is a semantic ANSI color; terminals remap it per their palette.
      return c.cyan as unknown as ChalkChain;
    case "mark":
      return c.bgYellow.black as unknown as ChalkChain;
    case "a":
      return c.blue.underline as unknown as ChalkChain;
    default:
      return c;
  }
}

/** Style a full heading line. */
export function styleHeading(level: HeadingLevel, text: string): string {
  const colors: Record<HeadingLevel, (s: string) => string> = {
    1: (s) => chalk.bold.red(s),
    2: (s) => chalk.bold.cyan(s),
    3: (s) => chalk.bold.yellow(s),
    4: (s) => chalk.bold.yellow(s),
    5: (s) => chalk.bold.cyan(s),
    6: (s) => chalk.bold.gray(s),
  };
  return colors[level](text);
}

/** Style a blockquote line. */
export function styleBlockquote(text: string): string {
  return chalk.gray("│ ") + chalk.italic.gray(text);
}

/** Style an <hr>. */
export function styleHr(cols = 60): string {
  return chalk.gray("─".repeat(cols));
}

/** Style a <pre><code> block. */
export function styleCodeBlock(text: string, lang?: string): string {
  const highlighted = highlightCode(text, lang);
  const rawLines = text.split("\n");
  const width = Math.max(...rawLines.map((l) => l.length), lang ? lang.length + 2 : 0);
  const bar = "─".repeat(width + 2);
  const top = chalk.gray("┌" + bar + "┐");
  const bottom = chalk.gray("└" + bar + "┘");
  const body = highlighted
    .split("\n")
    .map((line) => chalk.gray("│ ") + line)
    .join("\n");
  const header = lang ? chalk.gray("│ ") + chalk.gray(lang) + "\n" : "";
  return top + "\n" + header + body + "\n" + bottom;
}
