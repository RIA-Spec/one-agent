import { createACPProvider } from "@mcpc-tech/acp-ai-provider";
import { stepCountIs, streamText } from "ai";

type AcpProviderConfig = Parameters<typeof createACPProvider>[0];
type AcpSessionConfig = NonNullable<AcpProviderConfig["session"]>;

export type AgentOnErrorPolicy = "fail" | "return_error" | "retry_within_budget";

export interface AgentBudget {
  maxSteps?: number;
  maxMinutes?: number;
  maxOutputTokens?: number;
  maxRetries?: number;
}

export interface AgentExtensionToggleConfig {
  enabled?: boolean;
  injectSystemPrompt?: string | false;
  injectTools?: AcpSessionConfig["mcpServers"] | false;
}

export interface AgentTrajectoryUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface AgentTrajectoryStep {
  step_id: string;
  response_id?: string;
  finish_reason?: string;
  usage?: AgentTrajectoryUsage;
  tool_results?: unknown[];
}

// ATIF reference: https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md
export interface AgentTrajectory {
  format: "ATIF";
  schema_version: string;
  session_id: string;
  steps: AgentTrajectoryStep[];
  final_metrics?: {
    model?: string;
    finish_reason?: string;
    usage?: AgentTrajectoryUsage;
    budget?: {
      max_steps?: number;
      max_minutes?: number;
      max_output_tokens?: number;
      max_retries?: number;
    };
  };
}

export interface AgentSuccessResult {
  data: {
    text: string;
    trajectory: AgentTrajectory;
  };
}

export interface AgentConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  model?: string;
  mode?: string;
  system?: string;
  budget?: AgentBudget;
  on_error?: AgentOnErrorPolicy;
  session?: {
    cwd?: string;
    mcpServers?: AcpSessionConfig["mcpServers"];
  };
  persistSession?: boolean;
  extension?: AgentExtensionToggleConfig;
}

export type AgentErrorResult = { error: string };
export type AgentResult = AgentSuccessResult | AgentErrorResult;

const DEFAULT_MODEL_ID = "default";
const DEFAULT_MAX_STEPS = 40;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_ACP_COMMAND = "claude-agent-acp";

function parseArgsString(raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];

  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // Fall back to shell-like parsing below.
    }
  }

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function resolveACPArgs(configArgs?: string[]): string[] {
  if (Array.isArray(configArgs)) return configArgs;
  const envArgs = process.env.ONE_AGENT_EXTENSION_ACP_ARGS;
  return envArgs ? parseArgsString(envArgs) : [];
}

function normalizeMcpServers(value: unknown): AcpSessionConfig["mcpServers"] {
  return Array.isArray(value) ? (value as AcpSessionConfig["mcpServers"]) : [];
}

function mergeMcpServers(
  base: AcpSessionConfig["mcpServers"],
  injected: AcpSessionConfig["mcpServers"],
): AcpSessionConfig["mcpServers"] {
  if (base.length === 0) return injected;
  if (injected.length === 0) return base;
  return [...base, ...injected];
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function buildInjectedToolsHint(mcpServers: AcpSessionConfig["mcpServers"]): string {
  if (!Array.isArray(mcpServers) || mcpServers.length === 0) return "";

  const names = mcpServers
    .map((server) => {
      if (!server || typeof server !== "object") return "";
      const candidate = server as Record<string, unknown>;
      const name = candidate.name ?? candidate.id ?? candidate.serverId;
      return typeof name === "string" ? name : "";
    })
    .filter(Boolean);

  if (names.length === 0) return "";
  return `Injected MCP servers: ${names.join(", ")}`;
}

function buildSystemPrompt(config: AgentConfig, mergedMcpServers: AcpSessionConfig["mcpServers"]) {
  const extension = config.extension;
  const extensionEnabled = extension?.enabled === true;
  const parts: string[] = [];

  if (extensionEnabled) {
    const injectedSystem = extension.injectSystemPrompt;
    if (typeof injectedSystem === "string" && injectedSystem.trim()) {
      parts.push(injectedSystem.trim());
    }

    const toolsHint = buildInjectedToolsHint(mergedMcpServers);
    if (toolsHint) {
      parts.push(toolsHint);
    }
  }

  if (config.system?.trim()) {
    parts.push(config.system.trim());
  }

  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}

function normalizeUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): AgentTrajectoryUsage | undefined {
  const normalized: AgentTrajectoryUsage = {};

  if (typeof usage.inputTokens === "number") {
    normalized.input_tokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number") {
    normalized.output_tokens = usage.outputTokens;
  }
  if (typeof usage.totalTokens === "number") {
    normalized.total_tokens = usage.totalTokens;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

async function runAgentOnce(prompt: string, config: AgentConfig): Promise<AgentSuccessResult> {
  const command =
    config.command ?? process.env.ONE_AGENT_EXTENSION_ACP_COMMAND?.trim() ?? DEFAULT_ACP_COMMAND;

  const modelId =
    config.model?.trim() || process.env.ONE_AGENT_EXTENSION_ACP_MODEL?.trim() || DEFAULT_MODEL_ID;
  const baseMcpServers = normalizeMcpServers(config.session?.mcpServers);
  const injectedMcpServers =
    config.extension?.enabled === true && config.extension.injectTools !== false
      ? normalizeMcpServers(config.extension?.injectTools)
      : [];
  const mergedMcpServers = mergeMcpServers(baseMcpServers, injectedMcpServers);

  const acpProvider = createACPProvider({
    command,
    args: resolveACPArgs(config.args),
    env: config.env,
    session: {
      cwd: config.session?.cwd || process.cwd(),
      mcpServers: mergedMcpServers,
    },
    persistSession: config.persistSession,
  });

  const maxSteps = config.budget?.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxOutputTokens = config.budget?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const maxMinutes = config.budget?.maxMinutes;
  const system = buildSystemPrompt(config, mergedMcpServers);
  const model = acpProvider.languageModel(modelId, config.mode);

  const controller = new AbortController();
  const steps: AgentTrajectoryStep[] = [];
  const timeout =
    typeof maxMinutes === "number" && Number.isFinite(maxMinutes) && maxMinutes > 0
      ? setTimeout(() => controller.abort(), Math.floor(maxMinutes * 60_000))
      : undefined;

  try {
    const result = streamText({
      model,
      prompt,
      system,
      maxOutputTokens,
      abortSignal: controller.signal,
      stopWhen: stepCountIs(Math.max(1, Math.floor(maxSteps))),
      onStepFinish: ({ usage, finishReason, response, toolResults }) => {
        steps.push({
          step_id: `step_${steps.length + 1}`,
          response_id: response?.id,
          finish_reason: finishReason,
          usage: normalizeUsage(usage),
          tool_results:
            Array.isArray(toolResults) && toolResults.length > 0 ? toolResults : undefined,
        });
      },
    });

    const text = (await result.text).trim();
    const finishReason = await result.finishReason;
    const totalUsage = normalizeUsage(await result.totalUsage);

    if (!text) {
      throw new Error(`agent() produced empty output. finishReason=${finishReason}`);
    }

    const trajectory: AgentTrajectory = {
      format: "ATIF",
      schema_version: "atif-0.1",
      session_id: steps.find((step) => step.response_id)?.response_id ?? crypto.randomUUID(),
      steps,
      final_metrics: {
        model: modelId,
        finish_reason: finishReason,
        usage: totalUsage,
        budget: {
          max_steps: maxSteps,
          ...(typeof maxMinutes === "number" ? { max_minutes: maxMinutes } : {}),
          max_output_tokens: maxOutputTokens,
          max_retries: config.budget?.maxRetries,
        },
      },
    };

    return {
      data: {
        text,
        trajectory,
      },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    acpProvider.cleanup();
  }
}

export async function agent(prompt: string, config: AgentConfig = {}): Promise<AgentResult> {
  const onError: AgentOnErrorPolicy = config.on_error ?? "return_error";
  const maxRetries = Math.max(1, config.budget?.maxRetries ?? DEFAULT_MAX_RETRIES);
  const attempts = onError === "retry_within_budget" ? maxRetries : 1;

  let lastError = "";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await runAgentOnce(prompt, config);
    } catch (error) {
      lastError = stringifyError(error);
      if (attempt === attempts - 1) {
        break;
      }
    }
  }

  if (onError === "fail") {
    throw new Error(lastError || "agent() failed");
  }

  return { error: lastError || "agent() failed" };
}
