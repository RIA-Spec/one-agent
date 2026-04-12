import { existsSync } from "node:fs";
import { config as dotenvConfig } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cac, { type Command } from "cac";
import { resolveLaunchConfig, type ProviderType } from "@mcpc-tech/aiyo-cli";
import { launchWithRiaProxy, startRiaProxyServer, type SupportedIntegration } from "./launcher.js";
import packageJson from "../package.json";

const CLI_VERSION = packageJson.version;
const packageDir = dirname(fileURLToPath(import.meta.url));

interface SharedOptions {
  model?: string;
  host?: string;
  port?: number;
  provider?: ProviderType;
  upstreamUrl?: string;
  upstreamKey?: string;
  acpCommand?: string;
  acpArgs?: string;
  cwd?: string;
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
  return resolveLaunchConfig({
    host: opts.host,
    port: opts.port,
    model: opts.model,
    provider: opts.provider,
    upstreamBaseURL: opts.upstreamUrl,
    upstreamApiKey: opts.upstreamKey,
    acpCommand: opts.acpCommand,
    acpArgs: opts.acpArgs?.trim().split(/\s+/).filter(Boolean),
    cwd: opts.cwd,
  });
}

function addSharedOptions(cmd: Command): Command {
  return cmd
    .option("--provider <type>", "Provider: openai (default) | acp  [env: AIYO_PROVIDER]")
    .option("--model <name>", "Model name  [env: OPENAI_MODEL]")
    .option("--host <host>", "Bind host  [default: 127.0.0.1]")
    .option("--port <port>", "Bind port  [default: 3456]")
    .option("--upstream-url <url>", "OpenAI upstream base URL  [env: OPENAI_BASE_URL]")
    .option("--upstream-key <key>", "OpenAI upstream API key  [env: OPENAI_API_KEY]")
    .option("--acp-command <cmd>", "ACP command  [env: ACP_COMMAND, default: opencode]")
    .option("--acp-args <args>", "ACP args space-separated  [env: ACP_ARGS, default: 'acp']");
}

function createCli() {
  const cli = cac("ria-proxy");

  addSharedOptions(
    cli.command("serve", "Start an OpenAI-compatible proxy server in Re in Act mode"),
  ).action(async (opts: SharedOptions) => {
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
  });

  addSharedOptions(
    cli
      .command("launch <integration>", "Start Re in Act proxy + launch an IDE integration")
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
