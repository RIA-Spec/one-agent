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

## TypeSafe Jev providers

Jev is for **control-node judgments** (route / retry / boolean / score). It returns
noul/choice/score probabilities only — it **cannot** generate free-form summaries or
arbitrary structured prose.

Summary / synthesis `reason()` calls (e.g. `{ summary, findings, next }`) stay on the
LLM `streamText` + `submit_result` path. When `ONE_REASON_PROVIDER` is `typesafe` or
`gateway`, `reason()` **auto-falls back** to an LLM for free-text examples (see
`mode` below).

Config still feels OpenAI-compatible for Jev: base URL + API key + model.

### TypeSafe official API

```bash
export ONE_REASON_PROVIDER=typesafe
export ONE_REASON_OPENAI_API_KEY=ts_...          # or ONE_REASON_TYPESAFE_API_KEY / TYPESAFE_API_KEY / TYPESAFE_AI_API_KEY
export ONE_REASON_OPENAI_BASE_URL=https://api.typesafe.ai/v1   # optional
export ONE_REASON_MODEL=jev-latest              # optional
```

Calls `POST {baseURL}/systemone` with Bearer auth. Question types on the wire are
`noul` | `choice` | `score`.

### Vercel AI Gateway

```bash
export ONE_REASON_PROVIDER=gateway
export ONE_REASON_OPENAI_API_KEY=...            # or ONE_REASON_GATEWAY_API_KEY / AI_GATEWAY_API_KEY
export ONE_REASON_OPENAI_BASE_URL=https://ai-gateway.vercel.sh/v4/ai   # optional
export ONE_REASON_MODEL=typesafe-ai/jev         # optional
```

Gateway evaluation is **not** on OpenAI-compatible chat endpoints. This package
calls the Gateway evaluation HTTP surface discovered from `@ai-sdk/gateway`:

`POST {baseURL}/evaluation-model`

with headers:

- `ai-evaluation-model-specification-version: 4`
- `ai-model-id: <model>`
- `ai-gateway-protocol-version: 0.0.1`
- `Authorization: Bearer <key>`

Question types on the wire are `boolean` | `choice` | `score` (Gateway uses
`boolean` instead of TypeSafe's `noul`). No `ai@7` dependency is required.

### LLM fallback for summary / synthesis

When the primary provider is Jev and the example needs free text, configure a
fallback LLM (used automatically in `mode: "auto"`, or whenever `mode: "llm"`):

```bash
export ONE_REASON_FALLBACK_PROVIDER=openai-compatible
export ONE_REASON_FALLBACK_OPENAI_API_KEY=...
export ONE_REASON_FALLBACK_OPENAI_BASE_URL=https://api.openai.com/v1
export ONE_REASON_FALLBACK_MODEL=gpt-4.1-mini
```

If `FALLBACK_*` is unset, `reason()` tries the main agent model from `one auth`
(`~/.config/one/one.json`). Set `ONE_REASON_VERBOSE=1` to log when fallback runs.

### `reason(prompt, example, options?)`

The third argument is optional and backward compatible:

```ts
import { reason } from "@one-agent/reason";

// Decision / control node → Jev (when PROVIDER=typesafe|gateway)
await reason("goal: should we retry?", { retry: false, route: "a|b|c" });

// Summary / synthesis → LLM (auto-fallback under Jev provider)
await reason("goal: summarize the log", {
  summary: "",
  findings: "",
  next: "",
});

// Force LLM even if PROVIDER is typesafe
await reason(prompt, example, { mode: "llm" });

// Force Jev (errors if example has free-text and no questions)
await reason(prompt, { retry: false }, { mode: "jev" });

// Explicit Jev questions + optional state / threshold
await reason(prompt, { ok: false }, {
  mode: "jev",
  questions: {
    ok: { type: "noul", instructions: "Did the step succeed?" },
  },
  state: { goal: "...", observation: "..." },
  booleanThreshold: 0.6,
});
```

| `mode` | Behavior |
| --- | --- |
| `auto` (default) | Jev when provider is typesafe\|gateway **and** example is decision-shaped (or `questions` set); else LLM |
| `jev` | Always Jev; clear error if free-text cannot map and `questions` is omitted |
| `llm` | Always LLM streamText path (needs FALLBACK_* or `one auth` when PROVIDER is Jev) |

### Example → question mapping (decision-shaped)

For Jev, `prompt` (or `options.state`) becomes evaluation `state`, and questions
are derived from `example` unless `options.questions` is set:

| Example field | Jev question |
| --- | --- |
| `boolean` | noul / boolean |
| `number` | score (auto `level 0` .. `level N` criteria) |
| `string` with `a\|b\|c` | choice |
| `string[]` | choice |
| plain `string` | **not Jev** → LLM synthesis / auto-fallback |
| `{ "$jev": "noul"\|"choice"\|"score", ... }` | explicit question |

Nested objects are flattened to dotted question ids and rebuilt into the example
shape when answers are applied.

Errors `401` / `422` / `429` / `529` return clear messages; `429` and `529` are
retried lightly with backoff.
