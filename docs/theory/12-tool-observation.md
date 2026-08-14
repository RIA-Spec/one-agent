# 12. Tool Observation: High Signal-to-Noise Returns

> **Synthesis of** [03](./03-closed-loop-control.md) · [05](./05-observability-operability.md) · [06](./06-abstraction-levels.md) · [07](./07-evidence-evaluation.md) · [10](./10-context-engineering.md)

## Core Thesis

**Tool-call returns are the Sensor's primary input.** Low signal-to-noise returns (raw dumps, full pages, verbose stderr) cause attention dilution, Sensor misjudgment, and closed-loop lag — extra reasoning just to find the state in the noise.

The goal is **decision-relevant signal**: every field should be able to change the next judgment; removed detail stays re-fetchable through a handle. Anthropic's principle: *the smallest possible set of high-signal tokens that maximize the likelihood of the desired outcome*.

## Observation Layer

```
Actuator executes tool → raw payload → observation layer (deterministic middleware)
→ Sensor → next round of Reference/reasoning
```

Compression belongs in deterministic middleware, **not** an extra LLM summarization turn (cost, drift, untestable).

## Four Compression Strategies

| Strategy | Approach | Must-keep metadata |
| --- | --- | --- |
| **Projection** | keep only decision fields | error code · id · status |
| **Aggregation** | logs/lists → count · top-N | `total_rows` · sampling rationale |
| **Truncation** | per-tool observation budget | `truncated: true` · how to get more |
| **Handles** | externalize large payloads | path · query id · continuation tool |

## Structured Observation

```text
result        — business conclusion (ok / key entities)
observation   — environment snapshot (not full-page dump)
verification  — machine-readable checks (checks[] · ok)
```

Errors are high signal-to-noise too: structured `kind · message · recoverable` beats a raw stack trace. Returns lean toward semantic abstraction ([06](./06-abstraction-levels.md)); a handle is just-in-time loading ([10](./10-context-engineering.md)); feedback distills decisions and discards redundant raw results ([07](./07-evidence-evaluation.md)).

## Practice Checklist (condensed)

- [ ] Every returned field can change the next decision?
- [ ] Large payloads externalized + handle?
- [ ] Truncation/aggregation carry metadata?
- [ ] Errors structured, not stderr walls?
- [ ] Compression deterministic, not LLM self-summarization?
