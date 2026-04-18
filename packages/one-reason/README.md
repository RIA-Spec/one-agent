# @one-agent/reason

Structured reasoning interface and CLI for ONE.

Within this repository's Re in Act implementation, `@one-agent/reason` is the bounded local judgment layer: it turns prompt text plus a required JSON shape into structured output.

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
