import { Chalk } from "chalk";

const chalk = new Chalk({ level: 3 });
type ChalkInstance = InstanceType<typeof Chalk>;

// FontStyle bit flags from shiki
const FS_ITALIC = 1;
const FS_BOLD = 2;
const FS_UNDERLINE = 4;

type ShikiToken = {
  content: string;
  color?: string;
  fontStyle?: number;
};

type ShikiHighlighter = {
  codeToTokens(code: string, opts: { lang: string; theme: string }): { tokens: ShikiToken[][] };
  getLoadedLanguages(): string[];
  loadLanguage(...langs: unknown[]): Promise<void>;
};

/**
 * Common languages pre-loaded at init — small set for fast startup.
 * Unknown languages fall back to plain rendering at highlight time.
 */
const PRELOAD_LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "bash",
  "sh",
  "json",
  "yaml",
  "html",
  "css",
  "markdown",
  "rust",
  "go",
  "sql",
  "toml",
  "diff",
  "text",
];

const THEME = "github-light";

let highlighter: ShikiHighlighter | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Call this once at REPL startup to warm up the highlighter asynchronously.
 * `highlightCode` will block briefly on first call if this hasn't resolved yet.
 */
export async function initSyntaxHighlighting(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      // Dynamic import so the module can still be loaded even if shiki is absent
      const { createHighlighter, bundledLanguages } = await import("shiki");
      const langs = PRELOAD_LANGS.filter(
        (l) => (bundledLanguages as Record<string, unknown>)[l] != null,
      );
      highlighter = (await createHighlighter({
        themes: [THEME],
        langs,
      })) as unknown as ShikiHighlighter;
    } catch {
      // shiki not available — fall back to plain rendering
      highlighter = null;
    }
  })();
  return initPromise;
}

/** Map a hex color string (#rrggbb) to a chalk hex color function. */
function applyColor(c: ChalkInstance, hex: string | undefined): ChalkInstance {
  if (!hex) return c;
  return c.hex(hex) as unknown as ChalkInstance;
}

/**
 * Highlight `code` for the given `lang` and return an ANSI-colored string.
 * Lines are NOT wrapped or indented — the caller handles that.
 * Falls back to plain text if shiki is unavailable or lang is unknown.
 */
export function highlightCode(code: string, lang?: string): string {
  if (!highlighter || !lang) return code;

  const loaded = highlighter.getLoadedLanguages();
  const effectiveLang = loaded.includes(lang) ? lang : loaded.includes("text") ? "text" : null;

  if (!effectiveLang) return code;

  try {
    const result = highlighter.codeToTokens(code, {
      lang: effectiveLang,
      theme: THEME,
    });
    return result.tokens
      .map((row) =>
        row
          .map((token) => {
            let c = applyColor(chalk as unknown as ChalkInstance, token.color);
            const fs = token.fontStyle ?? 0;
            if (fs & FS_ITALIC) c = c.italic as unknown as ChalkInstance;
            if (fs & FS_BOLD) c = c.bold as unknown as ChalkInstance;
            if (fs & FS_UNDERLINE) c = c.underline as unknown as ChalkInstance;
            return (c as unknown as (s: string) => string)(token.content);
          })
          .join(""),
      )
      .join("\n");
  } catch {
    return code;
  }
}
