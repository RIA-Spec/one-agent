import type { AiyoPlugin } from "@mcpc-tech/aiyo";
import {
  launchClaudeCode,
  launchOpenCode,
  resolveLaunchConfig,
  type LaunchConfig,
  type LaunchOverrides,
  type RunningProxyServer,
} from "@mcpc-tech/aiyo-cli";
import { createReInActPlugin, type ReInActPluginConfig } from "./re-in-act-plugin.js";
import { startRiaProxyServerInternal } from "./proxy-server.js";

export type SupportedIntegration = "opencode" | "claude" | "claude-code";

export interface RiaProxyPluginOptions extends Omit<ReInActPluginConfig, "toolNames"> {
  toolNames?: string[];
  plugins?: AiyoPlugin[];
}

export interface RiaProxyServerOptions extends RiaProxyPluginOptions {}

export interface LaunchWithRiaProxyOptions extends LaunchOverrides, RiaProxyPluginOptions {
  extraArgs?: string[];
}

function normalizeIntegration(integration: SupportedIntegration): "opencode" | "claude" {
  return integration === "claude-code" ? "claude" : integration;
}

export function createRiaProxyPlugins(options: RiaProxyPluginOptions = {}): AiyoPlugin[] {
  const { plugins = [], toolNames = ["*"], ...pluginOptions } = options;

  return [
    createReInActPlugin({
      name: "re-in-act",
      toolNames,
      ...pluginOptions,
    }),
    ...plugins,
  ];
}

export async function startRiaProxyServer(
  config: LaunchConfig,
  options: RiaProxyServerOptions = {},
): Promise<RunningProxyServer> {
  return startRiaProxyServerInternal(config, {
    plugins: createRiaProxyPlugins(options),
  });
}

export async function launchWithRiaProxy(
  integration: SupportedIntegration,
  options: LaunchWithRiaProxyOptions = {},
): Promise<void> {
  const normalized = normalizeIntegration(integration);
  const config = resolveLaunchConfig(options);
  const server = await startRiaProxyServer(config, options);
  const extraArgs = options.extraArgs ?? [];

  try {
    if (normalized === "opencode") {
      await launchOpenCode({
        baseURL: server.baseURL,
        model: config.model,
        cwd: config.cwd,
        extraArgs,
      });
      return;
    }

    await launchClaudeCode({
      baseURL: server.baseURL,
      model: config.model,
      cwd: config.cwd,
      extraArgs,
    });
  } finally {
    await server.close();
  }
}
