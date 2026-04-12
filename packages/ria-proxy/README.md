# @one-agent/ria-proxy

Non-invasive Re in Act plugin for OpenAI-compatible tool runtimes.

This package provides a PTC-style adapter for servers built on `@mcpc-tech/aiyo`.
It rewrites ordinary function tools into a single Re in Act wrapper tool, executes
TypeScript/JavaScript inside a bounded runtime with built-in `reason()`, `act()`,
and optional `agent()`, and preserves execution state across multiple request / response turns.

It also provides a fast proxy launcher on top of `@mcpc-tech/aiyo-cli`, so you can
launch tools like OpenCode or Claude through a Re in Act-enabled proxy.

## Install

```bash
pnpm add @one-agent/ria-proxy
```

## Quick start

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { createAiyo } from "@mcpc-tech/aiyo";
import { createReInActPlugin } from "@one-agent/ria-proxy";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const adapter = createAiyo({
  defaultModel: "gpt-4.1",
  runtimeFactory: ({ modelId }) => ({
    model: openai.chat(modelId || "gpt-4.1"),
    modelName: modelId || "gpt-4.1",
  }),
  plugins: [
    createReInActPlugin({
      toolNames: ["read_file", "write_file", "list_dir"],
    }),
  ],
});
```

## Fast proxy launch

```bash
npx @one-agent/ria-proxy launch opencode
```

Or use the launcher helpers directly:

```ts
import { launchWithRiaProxy } from "@one-agent/ria-proxy";

await launchWithRiaProxy("opencode", {
  model: "gpt-4.1",
});
```

## What it does

1. Rewrites matching function tools into one top-level wrapper tool.
2. Teaches the model to write code in Re in Act style.
3. Injects `reason(prompt, example)`, `act(name, args)`, and `agent(prompt, config?)` into the runtime.
4. Suspends execution only when `act()` needs a real external tool result.
5. Resumes the same execution session when the next tool result arrives.

## Main export

- `createReInActPlugin`
- `createRiaProxyPlugins`
- `startRiaProxyServer`
- `launchWithRiaProxy`
- `runCli`

## CLI commands

- `ria-proxy serve`
- `ria-proxy launch opencode`
- `ria-proxy launch claude`
