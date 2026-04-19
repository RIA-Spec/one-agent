import { resolveLaunchConfig, type LaunchConfig, type LaunchOverrides } from "@mcpc-tech/aiyo-cli";

export type RiaProxyProvider = "openai-compatible" | "openai" | "anthropic";

export interface RiaProxyLaunchOverrides extends Omit<
  LaunchOverrides,
  "provider" | "upstreamBaseURL" | "upstreamApiKey"
> {
  provider?: RiaProxyProvider;
  upstreamBaseURL?: string;
  upstreamApiKey?: string;
  anthropicBaseURL?: string;
  anthropicApiKey?: string;
}

export interface RiaProxyLaunchConfig extends Omit<LaunchConfig, "provider"> {
  provider: RiaProxyProvider;
  anthropicBaseURL?: string;
  anthropicApiKey?: string;
}

function normalizeProvider(provider: string | undefined): RiaProxyProvider {
  const normalized = provider?.trim().toLowerCase();

  if (!normalized) return "openai-compatible";
  if (normalized === "openai-compatible") return normalized;
  if (normalized === "openai") return normalized;
  if (normalized === "anthropic") return normalized;
  if (normalized === "acp") {
    throw new Error(
      "ACP provider is not supported by ria-proxy. Use openai-compatible, openai, or anthropic.",
    );
  }

  throw new Error(`Unsupported provider for ria-proxy: ${provider}`);
}

export function resolveRiaProxyLaunchConfig(
  overrides: RiaProxyLaunchOverrides = {},
): RiaProxyLaunchConfig {
  const base = resolveLaunchConfig(overrides as LaunchOverrides);
  const provider = normalizeProvider(overrides.provider ?? process.env.AIYO_PROVIDER);

  return {
    ...base,
    provider,
    upstreamBaseURL:
      overrides.upstreamBaseURL ?? process.env.OPENAI_BASE_URL ?? base.upstreamBaseURL,
    upstreamApiKey: overrides.upstreamApiKey ?? process.env.OPENAI_API_KEY ?? base.upstreamApiKey,
    anthropicBaseURL: overrides.anthropicBaseURL ?? process.env.ANTHROPIC_BASE_URL,
    anthropicApiKey: overrides.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY,
  };
}
