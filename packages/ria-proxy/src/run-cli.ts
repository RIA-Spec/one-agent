import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config as dotenvConfig } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cac, { type Command } from "cac";
import { cancel, intro, isCancel, outro, password, select, text } from "@clack/prompts";
import { getOneConfigPath } from "@one-agent/reason";
import {
  resolveRiaProxyLaunchConfig,
  type RiaProxyLaunchConfig,
  type RiaProxyLaunchOverrides,
  type RiaProxyProvider,
} from "./config.js";
import { launchWithRiaProxy, startRiaProxyServer, type SupportedIntegration } from "./launcher.js";
import packageJson from "../package.json";

const CLI_VERSION = packageJson.version;
const packageDir = dirname(fileURLToPath(import.meta.url));
const RIA_PROXY_CONFIG_PATH = getOneConfigPath("ria-proxy.json");

interface SharedOptions {
  model?: string;
  host?: string;
  port?: number;
  provider?: RiaProxyProvider;
  upstreamUrl?: string;
  upstreamKey?: string;
  anthropicUrl?: string;
  anthropicKey?: string;
  cwd?: string;
}

type RiaProxyConfig = Record<string, unknown>;

function readProxyConfig(): RiaProxyConfig {
  if (!existsSync(RIA_PROXY_CONFIG_PATH)) return {};

  try {
    const parsed = JSON.parse(readFileSync(RIA_PROXY_CONFIG_PATH, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as RiaProxyConfig) : {};
  } catch {
    return {};
  }
}

function writeProxyConfig(config: RiaProxyConfig) {
  mkdirSync(dirname(RIA_PROXY_CONFIG_PATH), { recursive: true });
  writeFileSync(RIA_PROXY_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function readConfigString(config: RiaProxyConfig, key: string): string | undefined {
  const value = config[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function resolveSharedOptions(opts: SharedOptions): SharedOptions {
  const config = readProxyConfig();

  return {
    ...opts,
    provider:
      opts.provider ??
      (process.env.AIYO_PROVIDER?.trim() as RiaProxyProvider | undefined) ??
      (readConfigString(config, "PROVIDER") as RiaProxyProvider | undefined),
    model: opts.model ?? process.env.OPENAI_MODEL?.trim() ?? readConfigString(config, "MODEL"),
    upstreamUrl:
      opts.upstreamUrl ??
      process.env.OPENAI_BASE_URL?.trim() ??
      readConfigString(config, "OPENAI_BASE_URL"),
    upstreamKey:
      opts.upstreamKey ??
      process.env.OPENAI_API_KEY?.trim() ??
      readConfigString(config, "OPENAI_API_KEY"),
    anthropicUrl:
      opts.anthropicUrl ??
      process.env.ANTHROPIC_BASE_URL?.trim() ??
      readConfigString(config, "ANTHROPIC_BASE_URL"),
    anthropicKey:
      opts.anthropicKey ??
      process.env.ANTHROPIC_API_KEY?.trim() ??
      readConfigString(config, "ANTHROPIC_API_KEY"),
  };
}

async function runAuthCli() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("ria-proxy auth requires an interactive terminal (TTY)");
  }

  const existing = readProxyConfig();

  const readOptionalText = async (message: string, initialValue?: string) => {
    const value = await text({ message, defaultValue: initialValue });
    if (isCancel(value)) return null;
    return value.trim();
  };

  const readRequiredText = async (message: string, initialValue?: string) => {
    const value = await text({
      message,
      defaultValue: initialValue,
      validate(input) {
        return input?.trim() ? undefined : `${message} is required`;
      },
    });
    if (isCancel(value)) return null;
    return value.trim();
  };

  const readRequiredSecret = async (message: string) => {
    const value = await password({
      message,
      validate(input) {
        return input?.trim() ? undefined : `${message} is required`;
      },
    });
    if (isCancel(value)) return null;
    return value.trim();
  };

  const provider = await select<RiaProxyProvider>({
    message: "Select provider (openai-compatible/openai/anthropic)",
    initialValue:
      (readConfigString(existing, "PROVIDER") as RiaProxyProvider | undefined) ??
      "openai-compatible",
    options: [
      { label: "openai-compatible", value: "openai-compatible" },
      { label: "openai", value: "openai" },
      { label: "anthropic", value: "anthropic" },
    ],
  });

  if (isCancel(provider)) {
    cancel("Operation cancelled.");
    return;
  }

  intro("Configure ria-proxy auth");

  const nextConfig: RiaProxyConfig = { ...existing, PROVIDER: provider };

  if (provider === "openai-compatible") {
    const upstreamUrl = await readRequiredText(
      "OPENAI_BASE_URL",
      readConfigString(existing, "OPENAI_BASE_URL"),
    );
    if (upstreamUrl == null) {
      cancel("Operation cancelled.");
      return;
    }

    const apiKey = await readRequiredSecret("OPENAI_API_KEY");
    if (apiKey == null) {
      cancel("Operation cancelled.");
      return;
    }

    nextConfig.OPENAI_BASE_URL = upstreamUrl;
    nextConfig.OPENAI_API_KEY = apiKey;
    delete nextConfig.ANTHROPIC_BASE_URL;
    delete nextConfig.ANTHROPIC_API_KEY;
  }

  if (provider === "openai") {
    const upstreamUrl = await readOptionalText(
      "OPENAI_BASE_URL (optional)",
      readConfigString(existing, "OPENAI_BASE_URL"),
    );
    if (upstreamUrl == null) {
      cancel("Operation cancelled.");
      return;
    }

    const apiKey = await readRequiredSecret("OPENAI_API_KEY");
    if (apiKey == null) {
      cancel("Operation cancelled.");
      return;
    }

    nextConfig.OPENAI_API_KEY = apiKey;
    if (upstreamUrl) {
      nextConfig.OPENAI_BASE_URL = upstreamUrl;
    } else {
      delete nextConfig.OPENAI_BASE_URL;
    }
    delete nextConfig.ANTHROPIC_BASE_URL;
    delete nextConfig.ANTHROPIC_API_KEY;
  }

  if (provider === "anthropic") {
    const anthropicUrl = await readOptionalText(
      "ANTHROPIC_BASE_URL (optional)",
      readConfigString(existing, "ANTHROPIC_BASE_URL"),
    );
    if (anthropicUrl == null) {
      cancel("Operation cancelled.");
      return;
    }

    const anthropicKey = await readRequiredSecret("ANTHROPIC_API_KEY");
    if (anthropicKey == null) {
      cancel("Operation cancelled.");
      return;
    }

    nextConfig.ANTHROPIC_API_KEY = anthropicKey;
    if (anthropicUrl) {
      nextConfig.ANTHROPIC_BASE_URL = anthropicUrl;
    } else {
      delete nextConfig.ANTHROPIC_BASE_URL;
    }
    delete nextConfig.OPENAI_BASE_URL;
    delete nextConfig.OPENAI_API_KEY;
  }

  const model = await readOptionalText("MODEL (optional)", readConfigString(existing, "MODEL"));
  if (model == null) {
    cancel("Operation cancelled.");
    return;
  }
  if (model) {
    nextConfig.MODEL = model;
  } else {
    delete nextConfig.MODEL;
  }

  writeProxyConfig(nextConfig);
  outro(`Saved config to ${RIA_PROXY_CONFIG_PATH}`);
}

function loadEnv(): void {
  const envPaths = new Set<string>();

  const addCandidates = (startDir: string | undefined, maxDepth: number) => {
    if (!startDir) return;

    let currentDir = startDir;
    for (let depth = 0; depth <= maxDepth; depth += 1) {
      envPaths.add(resolve(currentDir, ".env"));
      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  };

  addCandidates(process.env.INIT_CWD, 4);
  addCandidates(process.cwd(), 4);
  addCandidates(packageDir, 4);

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) {
      continue;
    }

    const { error } = dotenvConfig({ path: envPath, override: false, quiet: true });
    if (!error) {
      break;
    }
  }
}

function buildConfig(opts: SharedOptions) {
  const resolved = resolveSharedOptions(opts);

  return resolveRiaProxyLaunchConfig({
    host: resolved.host,
    port: resolved.port,
    model: resolved.model,
    provider: resolved.provider,
    upstreamBaseURL: resolved.upstreamUrl,
    upstreamApiKey: resolved.upstreamKey,
    anthropicBaseURL: resolved.anthropicUrl,
    anthropicApiKey: resolved.anthropicKey,
    cwd: resolved.cwd,
  });
}

function addSharedOptions(cmd: Command): Command {
  return cmd
    .option(
      "--provider <type>",
      "Provider: openai-compatible (default) | openai | anthropic  [env: AIYO_PROVIDER]",
    )
    .option("--model <name>", "Model name  [env: OPENAI_MODEL]")
    .option("--host <host>", "Bind host  [default: 127.0.0.1]")
    .option("--port <port>", "Bind port  [default: 3456]")
    .option("--upstream-url <url>", "OpenAI-compatible or OpenAI base URL  [env: OPENAI_BASE_URL]")
    .option("--upstream-key <key>", "OpenAI-compatible or OpenAI API key  [env: OPENAI_API_KEY]")
    .option("--anthropic-url <url>", "Anthropic base URL  [env: ANTHROPIC_BASE_URL]")
    .option("--anthropic-key <key>", "Anthropic API key  [env: ANTHROPIC_API_KEY]");
}

function createCli() {
  const cli = cac("ria-proxy");

  cli.command("auth", "Configure ria-proxy model/auth settings").action(async () => {
    await runAuthCli();
  });

  addSharedOptions(cli.command("serve", "Start a Re in Act proxy server")).action(
    async (opts: SharedOptions) => {
      const config = buildConfig(opts);
      const server = await startRiaProxyServer(config);

      console.log(`Listening at ${server.baseURL}`);
      console.log(`model=${config.model} provider=${config.provider} plugin=re-in-act`);
      console.log("endpoints: /health /v1/models /v1/chat/completions /v1/responses /v1/messages");

      await new Promise<void>((resolveSignal) => {
        process.once("SIGINT", resolveSignal);
        process.once("SIGTERM", resolveSignal);
      });

      await server.close();
    },
  );

  addSharedOptions(
    cli
      .command("launch <integration>", "Start a Re in Act proxy and launch an IDE integration")
      .example("ria-proxy launch opencode")
      .example("ria-proxy launch claude"),
  ).action(async (integration: string, opts: SharedOptions) => {
    if (integration !== "opencode" && integration !== "claude" && integration !== "claude-code") {
      throw new Error(
        `Unknown integration: ${integration}. Supported: opencode, claude (alias: claude-code)`,
      );
    }

    await launchWithRiaProxy(integration as SupportedIntegration, {
      ...buildConfig(opts),
    });
  });

  cli.help();
  cli.version(CLI_VERSION);
  return cli;
}

export async function runCli(argv = process.argv): Promise<void> {
  loadEnv();
  const cli = createCli();
  cli.parse(argv, { run: false });
  await cli.runMatchedCommand();
}
