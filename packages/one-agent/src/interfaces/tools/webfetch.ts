import { jsonSchema } from "ai";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("URL is required");
  }

  const upgraded = trimmed.startsWith("http://") ? `https://${trimmed.slice(7)}` : trimmed;

  if (!upgraded.startsWith("http://") && !upgraded.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }

  let parsed: URL;
  try {
    parsed = new URL(upgraded);
  } catch {
    throw new Error("Invalid URL");
  }

  return parsed.toString();
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToMarkdown(html: string): string {
  const withLinks = html.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, text) => {
      const content = stripHtmlToText(String(text)).replace(/\n+/g, " ").trim() || href;
      return `[${content}](${href})`;
    },
  );

  const normalized = withLinks
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, text) => `# ${stripHtmlToText(String(text))}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, text) => `## ${stripHtmlToText(String(text))}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, text) => `### ${stripHtmlToText(String(text))}\n\n`)
    .replace(
      /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
      (_, text) => `\n\`\`\`\n${stripHtmlToText(String(text))}\n\`\`\`\n`,
    )
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, text) => `\`${stripHtmlToText(String(text))}\``)
    .replace(
      /<strong[^>]*>([\s\S]*?)<\/strong>/gi,
      (_, text) => `**${stripHtmlToText(String(text))}**`,
    )
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_, text) => `*${stripHtmlToText(String(text))}*`);

  return stripHtmlToText(normalized);
}

function createAbortContext(timeoutMs: number, parentSignal?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onParentAbort = () => controller.abort();

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      if (parentSignal) {
        parentSignal.removeEventListener("abort", onParentAbort);
      }
    },
  };
}

export function createWebFetchTool() {
  return {
    description:
      "Fetch content from a URL and return it as markdown (default), plain text, or raw HTML. Supports images and request timeout.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        format: {
          type: "string",
          enum: ["markdown", "text", "html"],
          description: "Response format (default: markdown)",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (max: 120)",
        },
      },
      required: ["url"],
    }),
    execute: async (
      {
        url,
        format,
        timeout,
      }: {
        url: string;
        format?: "markdown" | "text" | "html";
        timeout?: number;
      },
      extra?: any,
    ) => {
      const normalizedUrl = normalizeUrl(url);
      const targetFormat = format ?? "markdown";
      const timeoutMs = Math.min(
        Math.max(1, timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000,
        MAX_TIMEOUT_MS,
      );
      const abortCtx = createAbortContext(timeoutMs, extra?.signal);

      try {
        let accept = "*/*";
        if (targetFormat === "markdown") {
          accept = "text/markdown;q=1.0, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1";
        } else if (targetFormat === "text") {
          accept = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
        } else if (targetFormat === "html") {
          accept = "text/html;q=1.0, application/xhtml+xml;q=0.9, */*;q=0.1";
        }

        const headers: Record<string, string> = {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          accept,
          "accept-language": "en-US,en;q=0.9",
        };

        const initial = await fetch(normalizedUrl, {
          method: "GET",
          headers,
          signal: abortCtx.signal,
        });

        const response =
          initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
            ? await fetch(normalizedUrl, {
                method: "GET",
                headers: { ...headers, "user-agent": "one-agent" },
                signal: abortCtx.signal,
              })
            : initial;

        if (!response.ok) {
          throw new Error(`Request failed with status code: ${response.status}`);
        }

        const contentLengthHeader = response.headers.get("content-length");
        if (contentLengthHeader && Number(contentLengthHeader) > MAX_RESPONSE_SIZE) {
          throw new Error("Response too large (exceeds 5MB limit)");
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
          throw new Error("Response too large (exceeds 5MB limit)");
        }

        const contentType = response.headers.get("content-type") || "application/octet-stream";
        const mime = contentType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
        const title = `${normalizedUrl} (${contentType})`;

        const isImage = mime.startsWith("image/") && mime !== "image/svg+xml";
        if (isImage) {
          const base64 = Buffer.from(arrayBuffer).toString("base64");
          return {
            content: [
              {
                type: "text" as const,
                text: `Image fetched successfully: ${title}`,
              },
            ],
            attachments: [
              {
                type: "file" as const,
                mime,
                url: `data:${mime};base64,${base64}`,
              },
            ],
          };
        }

        const textContent = new TextDecoder().decode(arrayBuffer);
        let output = textContent;

        if (targetFormat === "markdown" && mime.includes("html")) {
          output = htmlToMarkdown(textContent);
        } else if (targetFormat === "text" && mime.includes("html")) {
          output = stripHtmlToText(textContent);
        }

        return {
          content: [{ type: "text" as const, text: output }],
          details: {
            url: normalizedUrl,
            format: targetFormat,
            contentType,
          },
        };
      } catch (error: any) {
        const message =
          error?.name === "AbortError"
            ? abortCtx.timedOut()
              ? `Web fetch timed out after ${Math.floor(timeoutMs / 1000)} seconds`
              : "Web fetch aborted"
            : (error?.message ?? String(error));

        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      } finally {
        abortCtx.cleanup();
      }
    },
  };
}
