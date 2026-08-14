# 15. Reason in Action: Local Control Nodes

> **Synthesis of** [03](./03-closed-loop-control.md) · [10](./10-context-engineering.md) · [12](./12-tool-observation.md) · [14](./14-subagents.md) · [re-in-act.org](https://re-in-act.org)

## Core Thesis

**Judgment belongs inside the action loop, not in the outer loop.** A Reason-able Action Space (RAS) coordinates multiple `act()` and `reason()` steps and returns only a denoised result. `reason()` sits at control nodes — targeting, branching, retry-vs-escalate, synthesis — where noisy local evidence must become one bounded decision. Everything between nodes is deterministic code or shell: loops, retries, validation.

Division of labor:

- `act()` gathers local evidence without pushing raw output to top-level reasoning
- `reason()` compresses that evidence into a small structured decision at control nodes
- Deterministic runtime executes between nodes and enforces stop conditions

## From ReAct to Re in Act

ReAct returns to the outer loop after every step; Re in Act keeps the work moving inside one action phase.

| Dimension | ReAct | Re in Act |
| --- | --- | --- |
| Loop | reason-act-observe at the top level | one orchestrated action phase |
| Intermediate data | raw payloads in main context | stays inside the RAS |
| Micro-control | probabilistic LLM-stepped | deterministic runtime control |
| Round trips | one per step (tax) | one denoised result per phase |

Closed-loop reading ([03](./03-closed-loop-control.md)): Re in Act makes Sensor and Feedback local. Reference is fixed; Actuator steps run in code; Feedback (`reason()` at control nodes) is computed inside the RAS, and only the final denoised state crosses back to the outer loop. This shrinks context noise ([10](./10-context-engineering.md)) and observation pollution ([12](./12-tool-observation.md)).

## Control Nodes

`reason()` is for decisions that cannot be computed deterministically:

| Control node | Question it answers |
| --- | --- |
| Targeting | which target or subject next? |
| Branching | which path do the observations support? |
| Retry vs. escalate | retry the same step, or escalate? |
| Synthesis | what is the denoised outcome? |

Rule of thumb: if the exact next step is already clear, skip `reason()` — deterministic code is cheaper, faster, and testable. `reason()` is justified only when evidence is noisy and a bounded judgment changes the next action.

### Batched Acts Converge at a Judgment Point

The natural shape is **many acts, one judgment**: several deterministic evidence streams (`act()` results) converge at a single point where combining them and choosing the next step is inherently uncertain. That convergence is a control node — the typical home of `reason()`. Batching is also the practical advantage over ReAct: the reason-act-observe round-trip tax collapses into one orchestrated action phase, with only the denoised result crossing back.

## Two Forms

The same pattern runs as code or as shell pipelines:

- **Code (Python/TS)**: branches, loops, and retries in the script; `await reason(...)` at decision nodes; `await act(...)` for tools.
- **Shell (bash)**: `reason --prompt ... --structure ...` and `act` composed with pipes; shell provides deterministic control.

In both forms, deterministic Turing-complete control is stronger than probabilistic LLM-stepped micro-control: the model decides only where judgment is required.

## Practice Checklist (condensed)

- [ ] `reason()` placed only at decision nodes, not after every `act()`?
- [ ] Observations passed from runtime data (variables/pipes), never retyped?
- [ ] No raw intermediate output pushed to the outer loop before the phase settles?
- [ ] Deterministic control (code/shell) handles loops, retries, and stop conditions?
- [ ] Only the denoised result crosses back to top-level reasoning?
