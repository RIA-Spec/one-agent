# 14. Delegation and Orchestration: Layering the Control Loop

> **Sources**: [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents) · [Dynamic workflows](https://x.com/trq212/status/2061907337154367865) · originals in [`sources/`](./sources/)

## The Problem

An agent plays planner, executor, and observer at once inside a **finite attention budget**. Two structural failures follow:

| Problem | Mechanism | Symptom |
| --- | --- | --- |
| **Observation pollution** | a side task floods the Sensor with low-reuse readings (search hits, logs, test output) | context full of noise · main-goal reasoning degrades |
| **Long-loop instability** | planning, execution, and intermediate results share one context; compaction is lossy | partial work passed off as done · self-serving verification · goal drift |

## Two Mechanisms

**Subagent** solves the first: **side-loop isolation** — the subtask runs in its own control loop; the main loop receives only the decision-relevant summary.

**Dynamic workflow** solves the second: **externalized orchestration** — when "who to delegate next, when to barrier, when to stop" exceeds single-loop capacity, move the plan and intermediate state out of the LLM context into deterministic structure (scripts / state machines); the main loop sees only the final artifact.

```text
one context doing planning + swallowing all observations
        ↓
Subagent: multiple loops · independent Sensors · main loop merges summaries
        ↓ (bigger scale / stronger constraint structure)
Workflow: orchestration outside the loop · the loop only does single-step reasoning
```

## Subagent vs Workflow

| | Subagent | Workflow |
| --- | --- | --- |
| Cuts | the **observation volume** of one subtask | the **orchestration complexity** of the whole task |
| Orchestrator | main session (turn-by-turn delegation) | external script (loops / branches / barriers) |
| Intermediate state | sub-loop context (summary returns) | script variables (main loop never sees) |
| Scale | few parallel, self-contained side tasks | many homogeneous steps, forced adversarial checks |

## Theory

The three long-loop failure modes — partial completion, self-preferential verification, goal drift after compaction — are essentially the [03](./03-closed-loop-control.md) Feedback channel being **low-bandwidth and lossily compressed** in a single loop. Subagents reduce noise; workflows make Feedback **deterministic**. Division of labor with [11](./11-agent-skills.md): Skill = on-demand Reference/Actuator in the main loop; Subagent = side loop when observation needs isolation; Workflow = multi-loop factory when orchestration needs externalization.

## Selection (one line each)

- Main loop iterating with shared context → don't delegate
- Subtask output large, details useless to the main loop → Subagent
- Many steps, parallelism, forced re-checking → Workflow mindset (explicit fan-out + barrier)
