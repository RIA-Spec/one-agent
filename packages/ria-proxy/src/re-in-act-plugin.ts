import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox, type SandboxConfig } from "@mcpc-tech/handle-sandbox";
import type {
  AiyoFinalResult,
  AiyoMiddleware,
  AiyoPlugin,
  OpenAIChatCompletionRequest,
} from "@mcpc-tech/aiyo";
import { reason as defaultReason } from "@one-agent/reason";
import { agent as defaultAgent } from "@one-agent/agent-extension";
import type { AgentResult } from "@one-agent/agent-extension";
import type { ChatCompletionToolChoiceOption } from "openai/resources/chat/completions";
import ts from "typescript";

export interface ReInActReasonResult {
  data?: unknown;
  error?: string | null;
}

export interface ReInActActCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  output: unknown;
}

export interface ReInActReasonCallRecord {
  prompt: string;
  example: unknown;
  output: unknown;
}

export interface ReInActAgentCallRecord {
  prompt: string;
  config: unknown;
  output: unknown;
}

export interface ReInActExecutionResult {
  source: string;
  value: unknown;
  logs: string[];
  actHistory: ReInActActCallRecord[];
  reasonHistory: ReInActReasonCallRecord[];
  agentHistory: ReInActAgentCallRecord[];
}

export interface ReInActPluginConfig {
  name?: string;
  toolNames: string[];
  wrapperToolName?: string;
  wrapperToolDescription?: string;
  rewriteRequest?: boolean;
  timeoutMs?: number;
  maxLogs?: number;
  match?: (toolCall: ProgrammaticToolCall, context: ReInActMatchContext) => boolean;
  getCode?: (toolCall: ProgrammaticToolCall) => string | undefined;
  reason?: (prompt: string, example: unknown) => Promise<ReInActReasonResult>;
  agent?: (prompt: string, config?: unknown) => Promise<AgentResult>;
  mapExecutionResult?: (result: ReInActExecutionResult) => Promise<unknown> | unknown;
  sandbox?: () => Record<string, unknown> | undefined;
  denoSandbox?: SandboxConfig;
}

interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    output_schema?: Record<string, unknown>;
  };
}

interface ProgrammaticToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface PendingActCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

type ReInActSessionState = "running" | "waiting_for_tool_result" | "completed" | "error";

interface ReInActSession {
  executionId: string;
  handle: ReInActRuntimeHandle;
  modelRequest?: OpenAIChatCompletionRequest;
  executionToolCallId?: string;
  modelRequestMessages?: OpenAIChatCompletionRequest["messages"];
  assistantToolCallMessage?: OpenAIChatCompletionRequest["messages"][number];
}

interface ReInActMatchContext {
  request: OpenAIChatCompletionRequest;
  result: AiyoFinalResult;
}

interface ReInActRuntimeHandle {
  readonly executionId: string;
  readonly state: ReInActSessionState;
  readonly pendingToolCall?: PendingActCall;
  readonly logs: string[];
  readonly actHistory: ReInActActCallRecord[];
  readonly reasonHistory: ReInActReasonCallRecord[];
  readonly agentHistory: ReInActAgentCallRecord[];
  readonly result?: ReInActExecutionResult;
  readonly error?: Error;
  waitForSuspendOrComplete(): Promise<void>;
  resumeToolResult(toolCallId: string, value: unknown): void;
  dispose(): void;
}

const RESUME_SESSION_ID_FIELD = "__one_ria_resume_session_id";

function isDebugEnabled(): boolean {
  const value =
    process.env.RIA_PROXY_DEBUG?.trim().toLowerCase() ??
    process.env.ONE_AGENT_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function getDebugLogFilePath(): string {
  const explicit =
    process.env.RIA_PROXY_DEBUG_FILE?.trim() ?? process.env.ONE_AGENT_DEBUG_FILE?.trim();
  if (explicit) {
    return explicit;
  }

  return join(tmpdir(), "ria-proxy-debug.log");
}

function debugLog(message: string, payload?: Record<string, unknown>) {
  if (!isDebugEnabled()) {
    return;
  }

  const line = JSON.stringify({
    time: new Date().toISOString(),
    message,
    ...(payload ? { payload } : {}),
  });

  try {
    appendFileSync(getDebugLogFilePath(), `${line}\n`, "utf8");
  } catch {
    // Ignore debug logging failures.
  }
}

function debugLogCode(message: string, source: string, payload?: Record<string, unknown>) {
  debugLog(message, {
    ...(payload ?? {}),
    sourceLength: source.length,
    source,
  });
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneValueIfPossible<T>(value: T): T {
  try {
    return cloneValue(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function defaultSerializeToolResult(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output ?? null);
}

function parseToolResultContent(content: unknown): unknown {
  if (typeof content !== "string") {
    return content;
  }

  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function generateId(): string {
  return `ria_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getDefaultCode(toolCall: ProgrammaticToolCall): string | undefined {
  const candidates = [toolCall.input.code, toolCall.input.javascript, toolCall.input.js];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return undefined;
}

function normalizeToolCall(toolCall: any): ProgrammaticToolCall | undefined {
  if (!isRecord(toolCall)) return undefined;

  const toolCallId =
    typeof toolCall.toolCallId === "string" && toolCall.toolCallId
      ? toolCall.toolCallId
      : undefined;
  const toolName =
    typeof toolCall.toolName === "string" && toolCall.toolName ? toolCall.toolName : undefined;

  if (!toolCallId || !toolName) return undefined;

  const input = isRecord(toolCall.input)
    ? toolCall.input
    : isRecord(toolCall.args)
      ? toolCall.args
      : {};

  return { toolCallId, toolName, input };
}

function toAssistantToolCallMessage(
  result: AiyoFinalResult,
): OpenAIChatCompletionRequest["messages"][number] | undefined {
  const normalizedToolCalls = (result.toolCalls ?? [])
    .map((toolCall) => normalizeToolCall(toolCall))
    .filter((toolCall): toolCall is ProgrammaticToolCall => Boolean(toolCall));

  if (normalizedToolCalls.length === 0) {
    return undefined;
  }

  return {
    role: "assistant",
    content: typeof result.text === "string" ? result.text : null,
    tool_calls: normalizedToolCalls.map((toolCall) => ({
      id: toolCall.toolCallId,
      type: "function" as const,
      function: {
        name: toolCall.toolName,
        arguments: JSON.stringify(toolCall.input ?? {}),
      },
    })),
  };
}

function setResumeSessionId(request: OpenAIChatCompletionRequest, executionId: string): void {
  (request as OpenAIChatCompletionRequest & Record<string, unknown>)[RESUME_SESSION_ID_FIELD] =
    executionId;
}

function getResumeSessionId(request: OpenAIChatCompletionRequest): string | undefined {
  const value = (request as OpenAIChatCompletionRequest & Record<string, unknown>)[
    RESUME_SESSION_ID_FIELD
  ];
  return typeof value === "string" && value ? value : undefined;
}

function stripResumeSessionId(request: OpenAIChatCompletionRequest): OpenAIChatCompletionRequest {
  const cloned = {
    ...request,
  } as OpenAIChatCompletionRequest & Record<string, unknown>;
  delete cloned[RESUME_SESSION_ID_FIELD];
  return cloned;
}

function stringifyLogValue(value: unknown): string {
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pushLog(logs: string[], maxLogs: number, values: unknown[]): void {
  if (logs.length >= maxLogs) return;
  logs.push(values.map((value) => stringifyLogValue(value)).join(" "));
}

function summarizeSchemaProperties(schema: Record<string, unknown> | undefined): string[] {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const props = isRecord(schema?.properties) ? schema.properties : {};

  return Object.entries(props).map(([key, propertySchema]) => {
    const s = isRecord(propertySchema) ? propertySchema : {};
    const req = required.includes(key) ? " (required)" : " (optional)";
    const desc = typeof s.description === "string" ? ` — ${s.description}` : "";
    return `  - ${key}: ${s.type ?? "any"}${req}${desc}`;
  });
}

function truncateText(value: string | undefined, maxLength = 220): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function getToolOutputSchema(tool: OpenAIToolDefinition): Record<string, unknown> | undefined {
  if (isRecord(tool.function.outputSchema)) {
    return tool.function.outputSchema;
  }

  if (isRecord(tool.function.output_schema)) {
    return tool.function.output_schema;
  }

  return undefined;
}

function buildToolSchemaBlock(tool: OpenAIToolDefinition): string {
  const fn = tool.function;
  const outputSchema = getToolOutputSchema(tool);
  const paramLines = summarizeSchemaProperties(fn.parameters);
  const outputLines = summarizeSchemaProperties(outputSchema);
  const description = truncateText(fn.description);

  return [
    `<tool name="${fn.name}">`,
    description ? `<description>${description}</description>` : "",
    paramLines.length > 0 ? `<args>\n${paramLines.join("\n")}\n</args>` : `<args>none</args>`,
    outputLines.length > 0 ? `<returns>\n${outputLines.join("\n")}\n</returns>` : "",
    `</tool>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildReInActSystemPrompt(
  tools: OpenAIToolDefinition[],
  wrapperToolName = "re_in_act",
  inheritedSystemPrompt?: string,
): string {
  const toolSchemas = tools
    .filter((tool) => tool.type === "function" && tool.function?.name)
    .map((tool) => buildToolSchemaBlock(tool))
    .join("\n\n");

  const inheritedPrompt = truncateText(inheritedSystemPrompt, 16_000);

  return `<re_in_act>
<overview>
You have exactly one top-level tool: \`${wrapperToolName}\`.
\`${wrapperToolName}\` runs TypeScript/JavaScript with built-in async \`reason()\`, \`act()\`, and optional \`agent()\`.

Use this rule:
- Use \`reason()\` when local runtime evidence needs extraction, summarization, or a next-step decision.
- If the user wants raw command or tool output, return the raw output.
- Never hand-type tool output into \`reason()\`.
- Always pass tool output to \`reason()\` from runtime data such as variables, slices, parser output, or prior \`act()\` results.
</overview>

<code_rules>
- The only top-level tool you may call is \`${wrapperToolName}\`.
- Never emit a top-level call to any runtime tool name such as \`bash\`, \`read\`, or \`edit\`.
- Any real tool usage must happen inside runtime code via \`await act(name, args)\`.
- Use only tool names listed below.
- Use code to execute the workflow. Keep loops, branches, validation, retries, and batching inside one wrapper call.
- Batch related work in one wrapper call instead of many tiny ones.
- Use \`reason()\` only when local runtime evidence must be turned into a judgment, structured result, or next-step decision.
- Do not use \`reason()\` when the exact output or exact next edit is already clear.
- \`reason()\` and \`act()\` are async and effectively stateless. Each call must include the full current goal, observation, relevant context, and constraints.
- Build the observation passed to \`reason()\` from current runtime data. Do not rely on memory or manually retype tool output.
- \`reason()\` cannot call tools or cause side effects.
- Tool args must be plain JSON-serializable objects.
- Use \`return <value>\` to produce the final structured result.
- Prefer sequential awaits over \`Promise.all\`.
- If downstream system instructions conflict with these Re in Act rules, follow Re in Act.
</code_rules>

<interfaces>
reason(prompt, example) -> { data, error }
act(name, args) -> tool result
agent(prompt, config?) -> { data: { text, trajectory } } | { error }
</interfaces>

<runtime_tools>
These are runtime-only tool names for \`act(name, args)\`.
They are not top-level callable tools.

${toolSchemas}
</runtime_tools>
${
  inheritedPrompt
    ? `
<downstream_system_prompt>
The following original system prompt is preserved for task framing, product behavior, tone, and safety guidance.
Apply it only where it does not conflict with the Re in Act rules above.

${inheritedPrompt}
</downstream_system_prompt>`
    : ""
}
</re_in_act>`;
}

function buildWrapperToolDefinition(
  wrapperToolName: string,
  description?: string,
): OpenAIToolDefinition {
  return {
    type: "function",
    function: {
      name: wrapperToolName,
      description:
        description ??
        "Universal top-level wrapper tool. Use this first for any task that needs tools or side effects. Inside its code, use await act(name, args) for runtime tools and await reason(prompt, example) only when runtime evidence needs synthesis or a bounded decision. Do not call runtime tools directly at top level.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "TypeScript/JavaScript code to execute. Use await act(name, args) for runtime tools, optional await reason(prompt, example), optional await agent(prompt, config), and return a final value. Always feed reason() from runtime data instead of manually retyping tool output.",
          },
        },
        required: ["code"],
      },
    },
  };
}

function transpileTypeScript(source: string): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: false,
      sourceMap: false,
      inlineSourceMap: false,
      removeComments: false,
    },
    reportDiagnostics: true,
  });

  const fatal = result.diagnostics?.find((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal?.messageText) {
    throw new Error(ts.flattenDiagnosticMessageText(fatal.messageText, "\n"));
  }

  return result.outputText;
}

function buildWrappedSource(
  source: string,
  toolCallInput: Record<string, unknown>,
  sandboxGlobals: Record<string, unknown> | undefined,
): string {
  const globals: string[] = [];
  for (const [name, value] of Object.entries(sandboxGlobals ?? {})) {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      globals.push(`const ${name} = ${serialized};`);
    }
  }

  return [
    `const input = ${JSON.stringify(toolCallInput)};`,
    ...globals,
    `const act = async (name, args = {}) => await __ria_act(String(name), args ?? {});`,
    `const reason = async (prompt, example) => await __ria_reason(String(prompt), example);`,
    `const agent = async (prompt, config = {}) => await __ria_agent(String(prompt), config ?? {});`,
    source,
  ].join("\n\n");
}

class DenoReInActExecutionHandle implements ReInActRuntimeHandle {
  public readonly executionId: string;
  public state: ReInActSessionState = "running";
  public pendingToolCall?: PendingActCall;
  public readonly logs: string[] = [];
  public readonly actHistory: ReInActActCallRecord[] = [];
  public readonly reasonHistory: ReInActReasonCallRecord[] = [];
  public readonly agentHistory: ReInActAgentCallRecord[] = [];
  public result?: ReInActExecutionResult;
  public error?: Error;

  private readonly sandbox: Sandbox;
  private readonly timeoutMs: number;
  private completionPromise: Promise<ReInActExecutionResult>;
  private resolvePendingToolResult?: (value: unknown) => void;
  private stateChangeNotify?: () => void;
  private stateChangePromise?: Promise<void>;
  private disposed = false;
  private readonly pendingQueue: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    resolve: (value: unknown) => void;
  }> = [];

  constructor(
    executionId: string,
    source: string,
    toolCallInput: Record<string, unknown>,
    config: {
      timeoutMs: number;
      maxLogs: number;
      sandboxGlobals?: () => Record<string, unknown> | undefined;
      denoSandbox?: SandboxConfig;
      reason: (prompt: string, example: unknown) => Promise<ReInActReasonResult>;
      agent: (prompt: string, config?: unknown) => Promise<AgentResult>;
    },
  ) {
    this.executionId = executionId;
    this.timeoutMs = Math.max(1, config.timeoutMs);

    this.sandbox = new Sandbox({
      timeout: this.timeoutMs,
      ...config.denoSandbox,
      onLog: (text, level) => {
        pushLog(this.logs, config.maxLogs, [text]);
        config.denoSandbox?.onLog?.(text, level);
      },
    });

    this.sandbox.registerHandler("__ria_act", async (toolName: unknown, args: unknown) => {
      const normalizedToolName =
        typeof toolName === "string" && toolName.length > 0 ? toolName : String(toolName);
      const normalizedArgs = cloneValue(normalizeObject(args));
      const toolCallId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      return await new Promise<unknown>((resolve) => {
        this.pendingQueue.push({
          toolCallId,
          toolName: normalizedToolName,
          args: normalizedArgs,
          resolve,
        });
        this.drainNextPending();
      });
    });

    this.sandbox.registerHandler("__ria_reason", async (prompt: unknown, example: unknown) => {
      const result = await config.reason(String(prompt ?? ""), cloneValueIfPossible(example));
      this.reasonHistory.push({
        prompt: String(prompt ?? ""),
        example: cloneValueIfPossible(example),
        output: cloneValueIfPossible(result),
      });
      return result;
    });

    this.sandbox.registerHandler("__ria_agent", async (prompt: unknown, runtimeConfig: unknown) => {
      const result = await config.agent(String(prompt ?? ""), cloneValueIfPossible(runtimeConfig));
      this.agentHistory.push({
        prompt: String(prompt ?? ""),
        config: cloneValueIfPossible(runtimeConfig),
        output: cloneValueIfPossible(result),
      });
      return result;
    });

    const compiledSource = transpileTypeScript(source);
    const wrappedSource = buildWrappedSource(
      compiledSource,
      toolCallInput,
      config.sandboxGlobals?.(),
    );

    this.sandbox.start();
    this.completionPromise = this.sandbox
      .execute(wrappedSource)
      .then((executionResult) => {
        if (this.logs.length === 0 && Array.isArray(executionResult.logs)) {
          for (const line of executionResult.logs.slice(0, config.maxLogs)) {
            pushLog(this.logs, config.maxLogs, [line]);
          }
        }

        if (executionResult.error) {
          throw new Error(executionResult.error);
        }

        const result = {
          source,
          value: executionResult.result,
          logs: cloneValue(this.logs),
          actHistory: cloneValueIfPossible(this.actHistory),
          reasonHistory: cloneValueIfPossible(this.reasonHistory),
          agentHistory: cloneValueIfPossible(this.agentHistory),
        } satisfies ReInActExecutionResult;

        this.state = "completed";
        this.result = result;
        this.notifyStateChanged();
        return result;
      })
      .catch((error) => {
        this.state = "error";
        this.error = error instanceof Error ? error : new Error(String(error));
        this.notifyStateChanged();
        throw this.error;
      })
      .finally(() => {
        this.sandbox.stop();
      });
  }

  async waitForSuspendOrComplete(): Promise<void> {
    if (this.state !== "running") return;

    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), this.timeoutMs),
    );

    const winner = await Promise.race([
      this.completionPromise.then(
        () => "completed" as const,
        () => "errored" as const,
      ),
      this.stateChangePromise ??
        new Promise<"suspended">((resolve) => {
          this.stateChangeNotify = () => resolve("suspended");
          this.stateChangePromise = undefined;
        }),
      timeoutPromise,
    ]);

    if (winner === "timeout" && this.state === "running") {
      this.state = "error";
      this.error = new Error(`Re in Act execution timed out after ${this.timeoutMs}ms`);
      this.notifyStateChanged();
      throw this.error;
    }
  }

  resumeToolResult(toolCallId: string, value: unknown): void {
    if (
      this.state !== "waiting_for_tool_result" ||
      !this.pendingToolCall ||
      this.pendingToolCall.toolCallId !== toolCallId ||
      !this.resolvePendingToolResult
    ) {
      throw new Error(`No pending act() call found for ${toolCallId}`);
    }

    this.resolvePendingToolResult(value);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sandbox.stop();
  }

  private drainNextPending(): void {
    if (this.pendingToolCall || this.pendingQueue.length === 0) return;

    const next = this.pendingQueue.shift()!;
    this.state = "waiting_for_tool_result";
    this.pendingToolCall = {
      toolCallId: next.toolCallId,
      toolName: next.toolName,
      args: next.args,
    };
    this.resolvePendingToolResult = (value: unknown) => {
      this.actHistory.push({
        toolName: next.toolName,
        args: cloneValue(next.args),
        output: cloneValueIfPossible(value),
      });
      this.pendingToolCall = undefined;
      this.resolvePendingToolResult = undefined;
      this.state = "running";
      next.resolve(value);
      this.drainNextPending();
    };

    this.notifyStateChanged();
  }

  private notifyStateChanged(): void {
    if (this.stateChangeNotify) {
      this.stateChangeNotify();
      this.stateChangeNotify = undefined;
      return;
    }

    this.stateChangePromise = Promise.resolve();
  }
}

export function createReInActPlugin(config: ReInActPluginConfig): AiyoPlugin {
  const maxLogs = Math.max(1, config.maxLogs ?? 50);
  const timeoutMs = Math.max(1, config.timeoutMs ?? 30_000);
  const wrapperToolName = config.wrapperToolName ?? "re_in_act";
  const shouldRewrite = config.rewriteRequest !== false;
  const match =
    config.match ??
    (shouldRewrite
      ? (toolCall: ProgrammaticToolCall) => toolCall.toolName === wrapperToolName
      : () => true);
  const getCode = config.getCode ?? getDefaultCode;
  const reasonHandler = config.reason ?? defaultReason;
  const agentHandler =
    config.agent ??
    (async (prompt: string, runtimeConfig?: unknown) =>
      defaultAgent(prompt, runtimeConfig as Parameters<typeof defaultAgent>[1]));
  const sessions = new Map<string, ReInActSession>();

  const rewriteMiddleware: AiyoMiddleware = (ctx) => {
    if (ctx.phase !== "request" || !shouldRewrite) return;

    const originalTools = ctx.request.tools;
    if (!originalTools || originalTools.length === 0) return;

    const matchAll = config.toolNames.length === 1 && config.toolNames[0] === "*";
    const toolNamesSet = new Set(config.toolNames);
    const relevantTools = originalTools.filter(
      (tool): tool is OpenAIToolDefinition =>
        tool.type === "function" &&
        !!tool.function?.name &&
        (matchAll || toolNamesSet.has(tool.function.name)),
    );

    if (relevantTools.length === 0) {
      return;
    }

    debugLog("rewrite request", {
      wrapperToolName,
      originalToolCount: originalTools.length,
      relevantToolNames: relevantTools.map((tool) => tool.function.name),
      messageCount: ctx.request.messages.length,
    });

    const existingSystemContent =
      ctx.request.messages.length > 0 &&
      isRecord(ctx.request.messages[0]) &&
      ctx.request.messages[0].role === "system" &&
      typeof ctx.request.messages[0].content === "string"
        ? ctx.request.messages[0].content
        : undefined;

    const systemPrompt = buildReInActSystemPrompt(
      relevantTools,
      wrapperToolName,
      existingSystemContent,
    );
    const hasSystemMessage =
      ctx.request.messages.length > 0 &&
      isRecord(ctx.request.messages[0]) &&
      ctx.request.messages[0].role === "system";

    if (hasSystemMessage) {
      const existing = ctx.request.messages[0] as { role: "system"; content: string };
      existing.content = systemPrompt;
    } else {
      ctx.request.messages = [{ role: "system", content: systemPrompt }, ...ctx.request.messages];
    }

    ctx.request.tools = [
      buildWrapperToolDefinition(wrapperToolName, config.wrapperToolDescription),
    ];

    if (ctx.request.tool_choice && typeof ctx.request.tool_choice === "object") {
      const tc = ctx.request.tool_choice as ChatCompletionToolChoiceOption & {
        type: string;
        function?: { name: string };
      };
      if (tc.type === "function" && tc.function?.name && toolNamesSet.has(tc.function.name)) {
        ctx.request.tool_choice = {
          type: "function",
          function: { name: wrapperToolName },
        };
      }
    }
  };

  const findSessionByPendingToolCall = (toolCallId: string): ReInActSession | undefined => {
    for (const session of sessions.values()) {
      if (
        session.handle.state === "waiting_for_tool_result" &&
        session.handle.pendingToolCall?.toolCallId === toolCallId
      ) {
        return session;
      }
    }

    return undefined;
  };

  const resumeMiddleware: AiyoMiddleware = (ctx) => {
    if (ctx.phase !== "request") return;

    for (const msg of ctx.request.messages ?? []) {
      if (!isRecord(msg) || msg.role !== "tool") continue;

      const toolCallId = msg.tool_call_id;
      if (typeof toolCallId !== "string") continue;

      const session = findSessionByPendingToolCall(toolCallId);
      if (!session) continue;

      debugLog("resume tool result", {
        executionId: session.executionId,
        toolCallId,
        hasStringContent: typeof msg.content === "string",
      });

      session.handle.resumeToolResult(toolCallId, parseToolResultContent(msg.content));
      setResumeSessionId(ctx.request, session.executionId);
      ctx.request.messages = [{ role: "user", content: "__re_in_act_resume__" }];
      return;
    }
  };

  const startSession = async (
    executionId: string,
    source: string,
    toolCallInput: Record<string, unknown>,
  ): Promise<ReInActSession> => {
    const handle = new DenoReInActExecutionHandle(executionId, source, toolCallInput, {
      timeoutMs,
      maxLogs,
      sandboxGlobals: config.sandbox,
      denoSandbox: config.denoSandbox,
      reason: reasonHandler,
      agent: agentHandler,
    });

    const session: ReInActSession = {
      executionId,
      handle,
    };

    debugLog("session started", {
      executionId,
      sourceLength: source.length,
      inputKeys: Object.keys(toolCallInput),
    });
    debugLogCode("re in act source", source, {
      executionId,
      phase: "start",
    });

    sessions.set(executionId, session);
    return session;
  };

  return {
    name: config.name ?? "re-in-act",
    middleware: [rewriteMiddleware, resumeMiddleware],
    onResult: async (ctx) => {
      const resumeExecutionId = getResumeSessionId(ctx.request);
      if (resumeExecutionId) {
        const session = sessions.get(resumeExecutionId);
        if (!session) return;

        const handle = session.handle;
        await handle.waitForSuspendOrComplete();

        debugLog("resume wait finished", {
          executionId: session.executionId,
          state: handle.state,
          pendingToolName: handle.pendingToolCall?.toolName,
        });

        if (handle.state === "waiting_for_tool_result" && handle.pendingToolCall) {
          const pending = handle.pendingToolCall;
          ctx.overrideResult = {
            text: null,
            toolCalls: [
              {
                toolCallId: pending.toolCallId,
                toolName: pending.toolName,
                input: pending.args,
              },
            ],
            finishReason: "tool-calls",
            usage: ctx.result.usage,
          };
          return;
        }

        if (handle.state === "completed" && handle.result) {
          const finalValue = config.mapExecutionResult
            ? await config.mapExecutionResult(handle.result)
            : handle.result.value;
          const serialized = defaultSerializeToolResult(finalValue);

          sessions.delete(session.executionId);
          handle.dispose();

          const nextMessages = session.modelRequestMessages
            ? cloneValue(session.modelRequestMessages)
            : [];
          if (session.assistantToolCallMessage) {
            nextMessages.push(cloneValue(session.assistantToolCallMessage));
          }

          if (session.executionToolCallId) {
            nextMessages.push({
              role: "tool",
              tool_call_id: session.executionToolCallId,
              content: serialized,
            });
          }

          const nextRequest: OpenAIChatCompletionRequest = {
            ...(session.modelRequest
              ? cloneValue(session.modelRequest)
              : stripResumeSessionId(ctx.request)),
            messages: nextMessages,
          };

          debugLog("resume completed", {
            executionId: session.executionId,
            nextMessageCount: nextMessages.length,
            sourceLength: handle.result.source.length,
            actCalls: handle.result.actHistory.length,
            reasonCalls: handle.result.reasonHistory.length,
            agentCalls: handle.result.agentHistory.length,
          });
          debugLogCode("re in act completed source", handle.result.source, {
            executionId: session.executionId,
            phase: "resume-complete",
            actCalls: handle.result.actHistory.length,
            reasonCalls: handle.result.reasonHistory.length,
            agentCalls: handle.result.agentHistory.length,
          });

          ctx.overrideResult = await ctx.runModel(nextRequest, { skipPlugins: true });
          return;
        }

        if (handle.state === "error") {
          debugLog("resume error", {
            executionId: session.executionId,
            error: handle.error?.message,
          });
          sessions.delete(session.executionId);
          handle.dispose();
          throw handle.error ?? new Error("Re in Act execution failed");
        }

        return;
      }

      const result = ctx.result;
      const toolCalls = (result.toolCalls ?? [])
        .map((toolCall) => normalizeToolCall(toolCall))
        .filter((toolCall): toolCall is ProgrammaticToolCall => Boolean(toolCall));
      if (toolCalls.length === 0) {
        return;
      }

      const codeToolCall = toolCalls.find((toolCall) =>
        match(toolCall, { request: ctx.request, result }),
      );
      if (!codeToolCall) {
        return;
      }

      const source = getCode(codeToolCall);
      if (!source) {
        return;
      }

      const executionId = generateId();
      const session = await startSession(executionId, source, codeToolCall.input);
      session.modelRequest = cloneValue(ctx.request);
      session.executionToolCallId = codeToolCall.toolCallId;
      session.modelRequestMessages = cloneValue(ctx.request.messages);
      session.assistantToolCallMessage = toAssistantToolCallMessage(result);

      const handle = session.handle;
      await handle.waitForSuspendOrComplete();

      debugLog("initial wait finished", {
        executionId,
        state: handle.state,
        pendingToolName: handle.pendingToolCall?.toolName,
        wrapperToolName,
      });

      if (handle.state === "waiting_for_tool_result" && handle.pendingToolCall) {
        const pending = handle.pendingToolCall;
        ctx.overrideResult = {
          text: null,
          toolCalls: [
            {
              toolCallId: pending.toolCallId,
              toolName: pending.toolName,
              input: pending.args,
            },
          ],
          finishReason: "tool-calls",
          usage: result.usage,
          _executionId: executionId,
        };
        return;
      }

      if (handle.state === "completed" && handle.result) {
        const finalValue = config.mapExecutionResult
          ? await config.mapExecutionResult(handle.result)
          : handle.result.value;
        const serialized = defaultSerializeToolResult(finalValue);
        const assistantMsg = toAssistantToolCallMessage(result);
        if (!assistantMsg) {
          return;
        }

        const nextRequest: OpenAIChatCompletionRequest = {
          ...ctx.request,
          messages: [
            ...ctx.request.messages,
            assistantMsg,
            {
              role: "tool",
              tool_call_id: codeToolCall.toolCallId,
              content: serialized,
            },
          ],
        };

        debugLog("initial execution completed", {
          executionId,
          nextMessageCount: nextRequest.messages.length,
          sourceLength: handle.result.source.length,
          actCalls: handle.result.actHistory.length,
          reasonCalls: handle.result.reasonHistory.length,
          agentCalls: handle.result.agentHistory.length,
        });
        debugLogCode("re in act completed source", handle.result.source, {
          executionId,
          phase: "initial-complete",
          actCalls: handle.result.actHistory.length,
          reasonCalls: handle.result.reasonHistory.length,
          agentCalls: handle.result.agentHistory.length,
        });

        ctx.overrideResult = await ctx.runModel(nextRequest, { skipPlugins: true });
        sessions.delete(executionId);
        handle.dispose();
        return;
      }

      if (handle.state === "error") {
        debugLog("initial execution error", {
          executionId,
          error: handle.error?.message,
        });
        sessions.delete(executionId);
        handle.dispose();
        throw handle.error ?? new Error("Re in Act execution failed");
      }
    },
  };
}
