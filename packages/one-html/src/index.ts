/**
 * @one-agent/html — public API
 *
 * Streaming HTML → ANSI terminal renderer.
 *
 * @example
 * ```ts
 * import { StreamingHtmlRenderer } from '@one-agent/html';
 *
 * const renderer = new StreamingHtmlRenderer({
 *   columns: process.stdout.columns ?? 80,
 *   onFlush: (text) => process.stdout.write(text + '\n'),
 *   onPartial: (partial) => process.stdout.write('\r\x1b[K' + partial),
 * });
 *
 * // Feed chunks as they arrive from the LLM stream
 * for await (const chunk of htmlStream) {
 *   renderer.write(chunk);
 * }
 * renderer.end();
 * ```
 */

export { StreamingHtmlRenderer } from "./renderer.js";
export type { HtmlRendererOptions } from "./renderer.js";
export { initSyntaxHighlighting, highlightCode } from "./syntax.js";
