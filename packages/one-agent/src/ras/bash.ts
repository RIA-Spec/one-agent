/**
 * Bash RAS - just-bash powered Reason-able Action Space runtime.
 *
 * Shell execution happens inside just-bash with a real workspace mount.
 * The injected reason, act, and agent commands stay host-backed.
 */

import { jsonSchema } from "ai";
import {
  Bash,
  MountableFs,
  ReadWriteFs,
  type Command,
  type CommandContext,
  type ExecResult,
} from "just-bash";
import { emitProgress } from "../progress.js";
import { codeToAST } from "./code-to-ast.js";

type ActTextContent = { type?: string; text?: unknown };
type ActAttachment = {
  url?: unknown;
  mime?: unknown;
  type?: unknown;
  name?: unknown;
};
type ActContentLike =
  | (ActTextContent & {
      data?: unknown;
      mimeType?: unknown;
      uri?: unknown;
      resource?: unknown;
    })
  | {
      type?: string;
      uri?: unknown;
      resource?: unknown;
      data?: unknown;
      mimeType?: unknown;
    };
type ActResultLike = {
  content?: ActContentLike[];
  attachments?: ActAttachment[];
  structuredContent?: unknown;
  isError?: boolean;
};

type BashReasonResult = {
  data?: unknown;
  error?: string;
};

type BashAgentResult = {
  data?: { text?: string; trajectory?: unknown };
  error?: string;
};

type ParsedReasonArgs = { prompt: string; example: unknown };
type ParsedActArgs =
  | { kind: "help" }
  | { kind: "manual"; toolName?: string }
  | { kind: "call"; toolName: string; toolArgs: unknown };
type ParsedAgentArgs = { prompt: string; config: unknown };

const HOST_BASH_TOOL_NAME = "__host_bash__";

export interface BashRASConfig {
  cwd: string;
  reasonHandler: (prompt: string, example: unknown) => Promise<BashReasonResult>;
  actHandler: (server: unknown) => (name: string, args: unknown) => Promise<ActResultLike>;
  agentHandler: (server: unknown) => (prompt: string, config?: unknown) => Promise<BashAgentResult>;
}

function ok(stdout = "", stderr = ""): ExecResult {
  return { stdout, stderr, exitCode: 0 };
}

function fail(message: string): ExecResult {
  return { stdout: "", stderr: `${message}\n`, exitCode: 1 };
}

function isExecResult(
  value: ParsedReasonArgs | ParsedActArgs | ParsedAgentArgs | ExecResult,
): value is ExecResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "stdout" in value &&
    "stderr" in value &&
    "exitCode" in value
  );
}

function formatActResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray((result as ActResultLike).content)
  ) {
    const actResult = result as ActResultLike;
    const renderedContent = (actResult.content ?? [])
      .map((entry, index, items) => formatActContentItem(entry, index + 1, items.length))
      .filter(Boolean);
    const renderedAttachments = (actResult.attachments ?? [])
      .map((entry, index, items) => formatActAttachment(entry, index + 1, items.length))
      .filter(Boolean);
    const rendered = [...renderedContent, ...renderedAttachments];

    if (rendered.length > 0) {
      const textOnly = (actResult.content ?? []).every((entry) => entry?.type === "text");
      return rendered.join(textOnly && renderedAttachments.length === 0 ? "\n" : "\n\n");
    }

    if (actResult.structuredContent !== undefined) {
      return JSON.stringify(actResult.structuredContent, null, 2);
    }

    return "";
  }
  return JSON.stringify(result, null, 2);
}

function formatActContentItem(
  item: ActContentLike | undefined,
  _index: number,
  total: number,
): string {
  if (!item) return "";

  if (item.type === "text") {
    return String((item as ActTextContent).text ?? "");
  }

  if (item.type === "resource_link") {
    return typeof item.uri === "string"
      ? total === 1
        ? item.uri
        : `[resource link ${item.uri}]`
      : JSON.stringify(item, null, 2);
  }

  if (item.type === "resource") {
    const resource = item.resource;
    if (resource && typeof resource === "object") {
      const text = (resource as { text?: unknown }).text;
      const uri = (resource as { uri?: unknown }).uri;
      if (typeof text === "string") {
        if (total === 1 || typeof uri !== "string" || !uri) return text;
        return `[resource ${uri}]\n${text}`;
      }
      if (typeof uri === "string") {
        return total === 1 ? uri : `[resource ${uri}]`;
      }
    }
    return JSON.stringify(item, null, 2);
  }

  if (item.type === "image" || item.type === "audio") {
    const uri = typeof item.uri === "string" ? item.uri : undefined;
    if (uri) {
      return total === 1 ? uri : `[${item.type} ${uri}]`;
    }
  }

  return JSON.stringify(item, null, 2);
}

function formatActAttachment(
  item: ActAttachment | undefined,
  index: number,
  total: number,
): string {
  if (!item) return "";

  if (typeof item.url === "string") {
    return total === 1 ? item.url : `[attachment ${item.url}]`;
  }

  const label = typeof item.name === "string" ? item.name : `attachment-${index}`;
  const mime = typeof item.mime === "string" ? ` (${item.mime})` : "";
  return `[${label}${mime}]`;
}

function parseJson(text: string, label: string): { value?: unknown; error?: ExecResult } {
  try {
    return { value: JSON.parse(text) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: fail(`Invalid ${label}: ${message}`) };
  }
}

function parseReasonArgs(args: string[], stdin: string): ParsedReasonArgs | ExecResult {
  const prompts: string[] = [];
  const positionals: string[] = [];
  let structure = "";

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--prompt") {
      const value = args[++index];
      if (value == null) return fail("--prompt requires a value");
      prompts.push(value === "-" ? stdin : value);
      continue;
    }
    if (arg.startsWith("--prompt=")) {
      const value = arg.slice("--prompt=".length);
      prompts.push(value === "-" ? stdin : value);
      continue;
    }
    if (arg === "--structure") {
      const value = args[++index];
      if (value == null) return fail("--structure requires a value");
      structure = value;
      continue;
    }
    if (arg.startsWith("--structure=")) {
      structure = arg.slice("--structure=".length);
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    return fail(`Unknown argument: ${arg}`);
  }

  if (positionals.length > 2) return fail("Too many positional arguments");

  const promptArg = positionals[0] || "";
  const structureRaw = structure || positionals[1] || "";
  if (promptArg) prompts.push(promptArg === "-" ? stdin : promptArg);
  if (!structureRaw) return fail("--structure is required");
  if (prompts.length === 0) return fail("prompt is required");

  const parsed = parseJson(structureRaw, "structure JSON");
  if (parsed.error) return parsed.error;

  return {
    prompt: prompts.join("\n"),
    example: parsed.value,
  };
}

function parseActArgs(args: string[], stdin: string): ParsedActArgs | ExecResult {
  let toolName = "";
  let argsText = "";
  let needsJsonStdin = false;
  let showManual = false;
  let showHelp = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--name") {
      toolName = args[++index] || "";
      continue;
    }
    if (arg === "--args") {
      const value = args[++index];
      if (value === "-") needsJsonStdin = true;
      else argsText = value || "";
      continue;
    }
    if (arg === "--manual") {
      showManual = true;
      const next = args[index + 1];
      if (next && !next.startsWith("-")) {
        toolName = next;
        index++;
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      if (!toolName && !showManual) {
        toolName = arg;
      } else if (!argsText && !needsJsonStdin && !showManual) {
        if (arg === "-") needsJsonStdin = true;
        else argsText = arg;
      } else {
        return fail(`Unknown argument: ${arg}`);
      }
      continue;
    }
    return fail(`Unknown argument: ${arg}`);
  }

  if (showHelp) return { kind: "help" };
  if (showManual) return { kind: "manual", toolName: toolName || undefined };
  if (!toolName || (!argsText && !needsJsonStdin)) return fail("tool name and JSON args required");

  const parsed = parseJson(needsJsonStdin ? stdin : argsText, "JSON args");
  if (parsed.error) return parsed.error;

  return { kind: "call", toolName, toolArgs: parsed.value };
}

function parseAgentArgs(args: string[], stdin: string): ParsedAgentArgs | ExecResult {
  const prompts: string[] = [];
  const positionals: string[] = [];
  let configRaw = "";

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--prompt") {
      const value = args[++index];
      if (value == null) return fail("--prompt requires a value");
      prompts.push(value === "-" ? stdin : value);
      continue;
    }
    if (arg.startsWith("--prompt=")) {
      const value = arg.slice("--prompt=".length);
      prompts.push(value === "-" ? stdin : value);
      continue;
    }
    if (arg === "--config") {
      const value = args[++index];
      if (value == null) return fail("--config requires a value");
      configRaw = value;
      continue;
    }
    if (arg.startsWith("--config=")) {
      configRaw = arg.slice("--config=".length);
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    return fail(`Unknown argument: ${arg}`);
  }

  if (positionals.length > 2) return fail("Too many positional arguments");

  const promptArg = positionals[0] || "";
  if (promptArg) prompts.push(promptArg === "-" ? stdin : promptArg);
  if (positionals[1] && !configRaw) configRaw = positionals[1];
  if (prompts.length === 0) return fail("prompt is required");

  if (!configRaw) {
    return { prompt: prompts.join("\n"), config: {} };
  }

  const parsed = parseJson(configRaw, "config JSON");
  if (parsed.error) return parsed.error;

  return { prompt: prompts.join("\n"), config: parsed.value ?? {} };
}

function mapActToolName(name: string): string {
  return name === "bash" ? HOST_BASH_TOOL_NAME : name;
}

function replaceHostBashAlias(text: string): string {
  return text.replaceAll(HOST_BASH_TOOL_NAME, "bash");
}

function buildSandboxFs(cwd: string): MountableFs {
  return new MountableFs({
    mounts: [{ mountPoint: cwd, filesystem: new ReadWriteFs({ root: cwd }) }],
  });
}

function createReasonCommand(reasonHandler: BashRASConfig["reasonHandler"]): Command {
  return {
    name: "reason",
    trusted: true,
    async execute(args: string[], ctx: CommandContext) {
      const parsed = parseReasonArgs(args, ctx.stdin);
      if (isExecResult(parsed)) return parsed;

      try {
        const result = await reasonHandler(parsed.prompt, parsed.example);
        if (result.error) {
          return {
            stdout: JSON.stringify({ data: result.data, error: result.error }, null, 2),
            stderr: "",
            exitCode: 1,
          };
        }

        const payload = result.data ?? result;
        const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
        return ok(text);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          stdout: JSON.stringify({ data: undefined, error: message }, null, 2),
          stderr: "",
          exitCode: 1,
        };
      }
    },
  };
}

function createActCommand(actHandler: BashRASConfig["actHandler"], server: unknown): Command {
  return {
    name: "act",
    trusted: true,
    async execute(args: string[], ctx: CommandContext) {
      const parsed = parseActArgs(args, ctx.stdin);
      if (isExecResult(parsed)) return parsed;

      try {
        let result: ActResultLike;
        if (parsed.kind === "help") {
          result = await actHandler(server)("__help__", {});
        } else if (parsed.kind === "manual") {
          result = await actHandler(server)(
            "__manual__",
            parsed.toolName ? { name: mapActToolName(parsed.toolName) } : {},
          );
        } else {
          result = await actHandler(server)(mapActToolName(parsed.toolName), parsed.toolArgs);
        }

        return {
          stdout: replaceHostBashAlias(formatActResultText(result)),
          stderr: "",
          exitCode: result.isError ? 1 : 0,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(message);
      }
    },
  };
}

function createAgentCommand(agentHandler: BashRASConfig["agentHandler"], server: unknown): Command {
  return {
    name: "agent",
    trusted: true,
    async execute(args: string[], ctx: CommandContext) {
      const parsed = parseAgentArgs(args, ctx.stdin);
      if (isExecResult(parsed)) return parsed;

      try {
        const result = await agentHandler(server)(parsed.prompt, parsed.config);
        if (result.error) {
          return { stdout: result.error, stderr: "", exitCode: 1 };
        }
        return ok(result.data?.text ?? "");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(message);
      }
    },
  };
}

export function createBashRAS(config: BashRASConfig) {
  return {
    name: "one",
    description: `Bash Reason-able Action Space runtime - Execute commands inside just-bash with built-in reason and act commands.

  reason [--prompt "text"] [prompt|-] [--structure '{"key":""}'|structure]  (prints requested JSON on success; {data,error} on failure)
	act --manual [tool]
	act <tool> '{"key":"value"}'
	act <tool> -
	agent [--prompt "text"] [prompt|-] [--config '{"budget":{"maxSteps":20}}'|config]
	act --name "name" --args '{"key":"value"}' [--args -]

File system: ${config.cwd} -> ${config.cwd}

Execution model:
	- Direct shell code runs inside just-bash sandbox.
	- reason/act/agent stay host-backed commands.
	- act bash routes to the real host bash tool outside the just-bash sandbox.

Usage:
  echo '{"url":"https://example.com","format":"text"}' | act webfetch - | \
  reason --prompt 'Goal: summarize the fetched content. Observation: stdin. Constraints: return {"summary":""}.' - '{"summary":""}' | \
  jq -r '.summary'

Execute Bash commands in the just-bash sandbox and return stdout/stderr.

## When to Use
- Unix pipeline composition and automation
- Tool orchestration via act
- Non-deterministic extraction/decision tasks via reason
- Text and JSON processing (jq/sed/awk)
- File ops at ${config.cwd} only

## Parameters

**command** (required): Bash command to execute.

**stdin** (optional): String piped to process stdin.

## File System
- ONLY ${config.cwd} is mounted read-write into the sandbox
- Use act bash when you need the real host shell

## Examples

**Basic:**
\`\`\`bash
echo 'hello world' | tr 'a-z' 'A-Z'
\`\`\`

**Reason + act with checks:**
\`\`\`bash
set -e && \
act --manual | \
reason --prompt 'Goal: extract likely tool names from stdin. Constraints: return a JSON array of tool names.' - '["bash"]' | \
jq -r '.[]'
\`\`\`

## Common Errors
| Error | Fix |
|-------|-----|
| (no output) | Add output commands like echo/cat/jq -r |
| Command failed | Check stderr and exit code; use set -e for fail-fast |
| No such file | Use paths under ${config.cwd} |
| command not found | just-bash only exposes built-ins; use act bash for host tools |`,
    parameters: jsonSchema({
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        stdin: { type: "string", description: "Optional stdin" },
      },
      required: ["command"],
    }),
    execute: async (
      { command, stdin }: { command: string; stdin?: string },
      _extra?: unknown,
      server?: unknown,
    ) => {
      const { cwd, reasonHandler, actHandler, agentHandler } = config;

      const steps = codeToAST(command, "bash");
      if (steps.length > 0) {
        emitProgress({ type: "plan", steps });
      }

      try {
        const shell = new Bash({
          fs: buildSandboxFs(cwd),
          cwd,
          python: true,
          javascript: true,
          customCommands: [
            createReasonCommand(reasonHandler),
            createActCommand(actHandler, server),
            createAgentCommand(agentHandler, server),
          ],
        });

        const result = await shell.exec(command, {
          ...(stdin ? { stdin } : {}),
          rawScript: true,
        });

        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return {
          content: [{ type: "text" as const, text: output || "(no output)" }],
          ...(result.exitCode !== 0 && { isError: true }),
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  };
}
