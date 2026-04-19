import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createAnthropic } from "@ai-sdk/anthropic";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAiyo, type AiyoPlugin } from "@mcpc-tech/aiyo";
import { type RunningProxyServer } from "@mcpc-tech/aiyo-cli";
import { type LanguageModel, wrapLanguageModel } from "ai";
import type { RiaProxyLaunchConfig } from "./config.js";
import { logger } from "./logger.js";

type WrappedModelConfig = Parameters<typeof wrapLanguageModel>[0];
export type ProxyAdapter = ReturnType<typeof createAiyo>;

export interface ProxyServerOptions {
  plugins?: AiyoPlugin[];
}

function isInspectorEnabled(): boolean {
  const value =
    process.env.RIA_PROXY_DEBUG?.trim().toLowerCase() ??
    process.env.ONE_AGENT_DEBUG?.trim().toLowerCase() ??
    process.env.DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function wrapWithInspector(model: LanguageModel): LanguageModel {
  if (!isInspectorEnabled()) {
    return model;
  }

  return wrapLanguageModel({
    model: model as WrappedModelConfig["model"],
    middleware: devToolsMiddleware() as WrappedModelConfig["middleware"],
  }) as LanguageModel;
}

function jsonResponse(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf-8") : undefined;
}

function logIncomingBody(url: string | undefined, body: string): void {
  logger.info({ url, body }, "incoming request body");

  try {
    logger.info({ url, json: JSON.parse(body) }, "incoming request json");
  } catch {
    logger.info({ url }, "incoming request body is not valid json");
  }
}

function logSSELine(line: string, state: { textLen: number; chunkCount: number }): void {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!normalized) return;

  logger.info({ line: normalized }, "SSE raw");

  if (normalized === "data: [DONE]") {
    logger.info({ textLen: state.textLen, chunks: state.chunkCount }, "SSE out: done");
    return;
  }

  if (!normalized.startsWith("data: ")) {
    return;
  }

  try {
    const parsed = JSON.parse(normalized.slice(6));
    const delta = parsed.choices?.[0]?.delta;
    const finish = parsed.choices?.[0]?.finish_reason;

    if (delta?.content) {
      state.textLen += delta.content.length;
      logger.info({ content: delta.content }, "SSE out: content");
    }
    if (delta?.tool_calls) {
      logger.info({ tool_calls: delta.tool_calls }, "SSE out: tool_calls");
    }
    if (finish) {
      logger.info(
        { finish_reason: finish, textLen: state.textLen, chunks: state.chunkCount },
        "SSE out: finish",
      );
    }
    state.chunkCount += 1;
  } catch {
    logger.info({ data: normalized.slice(6) }, "SSE out: non-json data");
  }
}

async function pipeResponse(res: ServerResponse, response: Response, isSSE = false): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  if (!response.body) {
    res.end();
    return;
  }
  const readable = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  if (isSSE) {
    const state = { textLen: 0, chunkCount: 0 };
    let buffered = "";
    const logStream = new Transform({
      transform(chunk, _enc, cb) {
        const text = buffered + chunk.toString("utf-8");
        const lines = text.split("\n");
        buffered = lines.pop() ?? "";

        for (const line of lines) {
          logSSELine(line, state);
        }

        cb(null, chunk);
      },
      flush(cb) {
        if (buffered) {
          logSSELine(buffered, state);
        }
        cb();
      },
    });
    await pipeline(readable, logStream, res);
  } else {
    await pipeline(readable, res);
  }
}

function getPlugins(options: ProxyServerOptions): AiyoPlugin[] {
  return options.plugins ? [...options.plugins] : [];
}

function getPluginNames(plugins: AiyoPlugin[]): string[] {
  return plugins.map((plugin, index) => plugin.name || `plugin-${index + 1}`);
}

export function createRiaProxyAdapter(
  config: RiaProxyLaunchConfig,
  options: ProxyServerOptions = {},
): ProxyAdapter {
  const plugins = getPlugins(options);
  const coreLog = (details: Record<string, unknown>, msg: string) => {
    logger.info(details, `core: ${msg}`);
  };

  const runtimeFactory = ({ modelId }: { modelId?: string }) => {
    const resolvedModelId = modelId || config.model;

    if (config.provider === "anthropic") {
      if (!config.anthropicApiKey) {
        throw new Error("anthropic provider selected but ANTHROPIC_API_KEY is not set");
      }

      const anthropicProvider = createAnthropic({
        name: "anthropic",
        apiKey: config.anthropicApiKey,
        ...(config.anthropicBaseURL ? { baseURL: config.anthropicBaseURL } : {}),
      });

      return {
        model: wrapWithInspector(anthropicProvider(resolvedModelId)),
        modelName: resolvedModelId,
      };
    }

    if (config.provider === "openai") {
      if (!config.upstreamApiKey) {
        throw new Error("openai provider selected but OPENAI_API_KEY is not set");
      }

      const openaiProvider = createOpenAI({
        apiKey: config.upstreamApiKey,
        ...(config.upstreamBaseURL ? { baseURL: config.upstreamBaseURL } : {}),
      });

      return {
        model: wrapWithInspector(openaiProvider(resolvedModelId)),
        modelName: resolvedModelId,
      };
    }

    if (!config.upstreamApiKey) {
      throw new Error("openai-compatible provider selected but OPENAI_API_KEY is not set");
    }
    if (!config.upstreamBaseURL) {
      throw new Error("openai-compatible provider selected but OPENAI_BASE_URL is not set");
    }

    const openaiCompatible = createOpenAICompatible({
      name: "openai-compatible",
      baseURL: config.upstreamBaseURL,
      apiKey: config.upstreamApiKey,
    });

    return {
      model: wrapWithInspector(openaiCompatible(resolvedModelId)),
      modelName: resolvedModelId,
    };
  };

  return createAiyo({
    defaultModel: config.model,
    runtimeFactory,
    plugins,
    log: coreLog,
  });
}

export async function startRiaProxyServerInternal(
  config: RiaProxyLaunchConfig,
  options: ProxyServerOptions = {},
): Promise<RunningProxyServer> {
  const adapter = createRiaProxyAdapter(config, options);
  const pluginNames = getPluginNames(getPlugins(options));

  const server = createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        jsonResponse(res, 400, { error: "Invalid request" });
        return;
      }

      if (req.method === "GET" && req.url === "/") {
        jsonResponse(res, 200, {
          name: "ria-proxy",
          model: config.model,
          provider: config.provider,
          plugins: pluginNames,
          inspector: isInspectorEnabled(),
          endpoints: [
            "/health",
            "/v1/models",
            "/v1/chat/completions",
            "/v1/responses",
            "/v1/messages",
          ],
        });
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        jsonResponse(res, 200, {
          status: "ok",
          model: config.model,
          provider: config.provider,
          plugins: pluginNames,
          inspector: isInspectorEnabled(),
        });
        return;
      }

      const body = await readBody(req);
      if (body && req.url?.includes("/chat/completions")) {
        try {
          const parsed = JSON.parse(body);
          const msgs = parsed.messages ?? [];
          const summary = msgs.slice(-4).map((m: any) => {
            const entry: any = { role: m.role };
            if (m.tool_calls) entry.tc = m.tool_calls.length;
            if (m.tool_call_id) entry.tcid = m.tool_call_id;
            return entry;
          });
          logger.info(
            { msgCount: msgs.length, toolCount: (parsed.tools ?? []).length, tail: summary },
            "incoming request",
          );
        } catch {}
        logIncomingBody(req.url, body);
      }

      const headers = new Headers(
        Object.entries(req.headers).flatMap(([k, v]) =>
          typeof v === "string"
            ? [[k, v] as [string, string]]
            : Array.isArray(v)
              ? [[k, v.join(", ")] as [string, string]]
              : [],
        ),
      );

      const startMs = Date.now();
      const response = await adapter.handleRequest(
        new Request(`http://${config.host}:${config.port}${req.url}`, {
          method: req.method,
          headers,
          body,
        }),
      );
      logger.info({ status: response.status, elapsed: Date.now() - startMs }, "upstream response");

      const isStream = body
        ? (() => {
            try {
              return JSON.parse(body).stream === true;
            } catch {
              return false;
            }
          })()
        : false;
      await pipeResponse(res, response, isStream);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "request error");
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  return {
    baseURL: `http://${config.host}:${config.port}`,
    close: () =>
      new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      ),
  };
}
