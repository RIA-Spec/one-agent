import { jsonSchema } from "ai";

const API_BASE_URL = "https://mcp.exa.ai";
const API_SEARCH_ENDPOINT = "/mcp";
const DEFAULT_NUM_RESULTS = 8;
const DEFAULT_TIMEOUT_MS = 25_000;

function buildSearchUrl(exaApiKey?: string): string {
  const url = new URL(`${API_BASE_URL}${API_SEARCH_ENDPOINT}`);
  const key = exaApiKey?.trim();
  if (key) {
    url.searchParams.set("exaApiKey", key);
  }
  return url.toString();
}

type SearchRequest = {
  jsonrpc: "2.0";
  id: number;
  method: "tools/call";
  params: {
    name: "web_search_exa";
    arguments: {
      query: string;
      numResults: number;
      livecrawl: "fallback" | "preferred";
      type: "auto" | "fast" | "deep";
      contextMaxCharacters?: number;
    };
  };
};

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

function parseSSEText(responseText: string): string | null {
  const lines = responseText.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("data: ")) {
      continue;
    }

    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(data) as {
        result?: {
          content?: Array<{ type?: string; text?: string }>;
        };
      };

      const text = parsed.result?.content?.[0]?.text;
      if (text && text.trim().length > 0) {
        return text;
      }
    } catch {
      // Ignore malformed event lines and continue scanning.
    }
  }

  return null;
}

export function createWebSearchTool() {
  return {
    description:
      "Search the web and return summarized result context. Supports auto/fast/deep modes and optional live crawl preference.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Web search query",
        },
        numResults: {
          type: "number",
          description: `Number of results to return (default: ${DEFAULT_NUM_RESULTS})`,
        },
        livecrawl: {
          type: "string",
          enum: ["fallback", "preferred"],
          description: "Live crawl mode (default: fallback)",
        },
        type: {
          type: "string",
          enum: ["auto", "fast", "deep"],
          description: "Search mode (default: auto)",
        },
        contextMaxCharacters: {
          type: "number",
          description: "Maximum returned context size in characters",
        },
        timeoutSeconds: {
          type: "number",
          description: "Timeout in seconds (default: 25)",
        },
        exaApiKey: {
          type: "string",
          description: "Exa API key (optional; defaults to ONE_EXA_API_KEY/EXA_API_KEY)",
        },
      },
      required: ["query"],
    }),
    execute: async (
      {
        query,
        numResults,
        livecrawl,
        type,
        contextMaxCharacters,
        timeoutSeconds,
        exaApiKey,
      }: {
        query: string;
        numResults?: number;
        livecrawl?: "fallback" | "preferred";
        type?: "auto" | "fast" | "deep";
        contextMaxCharacters?: number;
        timeoutSeconds?: number;
        exaApiKey?: string;
      },
      extra?: any,
    ) => {
      const timeoutMs = Math.max(1, timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
      const abortCtx = createAbortContext(timeoutMs, extra?.signal);

      try {
        const payload: SearchRequest = {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "web_search_exa",
            arguments: {
              query,
              numResults: numResults ?? DEFAULT_NUM_RESULTS,
              livecrawl: livecrawl ?? "fallback",
              type: type ?? "auto",
              ...(contextMaxCharacters ? { contextMaxCharacters } : {}),
            },
          },
        };

        const resolvedApiKey =
          exaApiKey?.trim() ||
          process.env.ONE_EXA_API_KEY?.trim() ||
          process.env.EXA_API_KEY?.trim();

        const response = await fetch(buildSearchUrl(resolvedApiKey), {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: abortCtx.signal,
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Web search failed (${response.status}): ${text}`);
        }

        const body = await response.text();
        const resultText = parseSSEText(body);

        return {
          content: [
            {
              type: "text" as const,
              text: resultText ?? "No search results found.",
            },
          ],
        };
      } catch (error: any) {
        const message =
          error?.name === "AbortError"
            ? abortCtx.timedOut()
              ? `Web search timed out after ${Math.floor(timeoutMs / 1000)} seconds`
              : "Web search aborted"
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
