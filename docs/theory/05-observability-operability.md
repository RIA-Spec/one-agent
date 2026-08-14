# 5. Observability and Operability

Control is only possible when the environment is sufficiently observable and sufficiently operable.

`Observability` asks: can the agent form a reliable judgment of the system's current state from limited signals?

The less observable an environment, the more easily an agent:

- Mistakes surface appearances for true state
- Mistakes local signals for global facts
- Force-fits explanations when evidence is missing
- Believes it is on the right path while already off course

`Operability` asks: does the agent have intervention means that are fine-grained enough, reliable enough, and composable enough to move the environment from its current state to the target state?

If an environment only allows coarse-grained intervention, the agent may understand the problem and still be unable to change it.

Operability therefore requires more than "can do things." It requires:

- Local intervention
- Stepwise progress
- Adjustment after failure
- Switching paths mid-course
- Continued probing under uncertainty

## 5.1 Sensor Design Principles (Tool Returns)

> Tool-call returns are the main carrier of the **Sensor** in [03 Closed-Loop Control](./03-closed-loop-control.md). Dedicated treatment in [12 Tool Observation](./12-tool-observation.md).

Observability becomes concrete here: **within a limited token budget, can the agent form a reliable state judgment from a tool result?**

Design principles:

1. **High signal-to-noise ratio** — keep only decision-relevant fields; irrelevant columns, repeated context, and full-page raw dumps don't enter the next turn
2. **Semantics over dumps** — return semantic layers such as `result` / `state` / `verification` ([06 Abstraction Levels](./06-abstraction-levels.md)), not raw API responses
3. **Deterministic compression** — projection / aggregation / truncation / handles happen in middleware, not by default LLM re-summarization
4. **Perceivable truncation** — must declare `truncated`, `total_rows`, or an equivalent handle, so the agent doesn't mistake the local for the global (the "local signal mistaken for global" failure mode at the top of this section)
5. **Lean errors too** — structured failure (`code` · `kind` · `recoverable`) plus an optional handle pointing to the full log, rather than a wall of stderr

The boundary with operability: if a tool only returns "success/failure" with no state detail, the agent cannot make local corrections — observation that is too coarse weakens operability as well.
