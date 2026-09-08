# @one-agent/reason

Structured reasoning interface and CLI for ONE.

Within this repository's Re in Act implementation, `@one-agent/reason` implements the required `reason()` interface: a bounded local judgment step that turns prompt text plus a required JSON shape into structured output.

Relevant public reference:

- [Working Draft Specification](https://re-in-act.org/specification/draft/index)

In the public spec, `reason()` is the only required interface. `@one-agent/reason` is this repository's reference implementation of that core contract.

## Model Configuration

`reason auth` configures the model used by the `reason` CLI and by `reason()` calls inside the Reason-able Action Space.

This is separate from `one auth`:

- `one auth` configures the main `one` agent model
- `reason auth` configures the model used by `reason()`

By default, `reason auth` writes `~/.config/one/reason.json`.

Environment variables still override file config. Common overrides include:

- `ONE_REASON_PROVIDER`
- `ONE_REASON_MODEL`
- `ONE_REASON_OPENAI_API_KEY`
- `ONE_REASON_OPENAI_BASE_URL`
- `ONE_REASON_REASONING_EFFORT`

`REASONING_EFFORT` controls how much reasoning/thinking the model does. Valid
values are `off`, `low`, `medium`, and `high`; when unset the provider's
default is used. one-reason forwards it the way each provider expects:

- OpenAI-compatible chat-completions endpoints receive the standard
  `reasoning_effort` field: `low`/`medium`/`high` pass through, and `off` sends
  `"none"`, OpenAI's documented "no reasoning" value. Models that honor it
  include OpenAI `gpt-5.1+` and Kimi K2.x; always-reasoning models (for example
  MiniMax M2) may ignore it or reject the parameter.
- OpenAI receives `reasoningEffort: "minimal"` for `off` (the lowest effort the
  current AI SDK accepts) and `low`/`medium`/`high` otherwise. `minimal` is not
  accepted by every OpenAI model, so treat `off` as best-effort there too.
- Anthropic enables thinking per model generation. Claude 4.6 and later plus
  the Claude 5 family (Sonnet 4.6/5, Opus 4.6/4.7/4.8/5, Fable 5) receive
  adaptive thinking (`thinking: { type: "adaptive" }`) together with the
  `effort` parameter, which is the only accepted form on Opus 4.7+/Claude 5.
  Older Claude models (4/4.1/4.5, Haiku 4.5, 3.x) receive the legacy
  `thinking: { type: "enabled", budgetTokens }` form with a fixed thinking
  budget per level (2048/8192/16384 tokens for `low`/`medium`/`high`).
  `off` sends `thinking: { type: "disabled" }`, so models that default to
  thinking on (for example Sonnet 5) stop; this requires `@ai-sdk/anthropic`
  >= 3.0.93 because older SDK versions silently dropped the field.

The fields above are not universal: some providers gate thinking with their own
body fields instead (for example Zhipu GLM uses
`thinking: { type: "enabled" | "disabled" }` and ignores `reasoning_effort`),
and some APIs reject values they do not recognize. Use a non-thinking model when
you need thinking guaranteed off. The scoped fallback is `ONE_REASONING_EFFORT`,
and it can also be set as `REASONING_EFFORT` in `reason.json`.

Example:

```bash
# Configure the model/provider used by reason()
reason auth

# Or use the namespaced binary
one-reason auth
```

## Usage

```bash
cat build.log | reason --prompt "goal: detect failures" - '{"failed":false,"reason":""}'
```

The structure argument is required and must be valid JSON.
