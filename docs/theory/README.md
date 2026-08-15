# Theory

This page discusses theory only — no product-specific solutions, file organization, implementation layering, or naming conventions. The unifying lens: how an agent faces, understands, intervenes in, and regulates an internal system environment.

## Contents

| # | Document | Topic |
| --- | --- | --- |
| 01 | [Internal System as Environment](./01-environment.md) | Environment, state, observation, intervention |
| 02 | [Grounding, Priors, and Posteriors](./02-grounding.md) | Facts / inferences / unknowns |
| 03 | [Closed-Loop Control Systems](./03-closed-loop-control.md) | Reference / Sensor / Actuator / Feedback |
| 04 | [Requisite Variety and the Good Regulator](./04-requisite-variety.md) | Control variety and the environment model |
| 05 | [Observability and Operability](./05-observability-operability.md) | Observation signals and intervention means |
| 06 | [Abstraction Levels](./06-abstraction-levels.md) | Semantic abstraction vs. operational abstraction |
| 07 | [Evidence and Evaluation](./07-evidence-evaluation.md) | Re-checkable, comparable, diagnosable |
| 08 | [Distortion and Recalibration](./08-recalibration.md) | Inference distortion and fallback correction |
| 09 | [The Essence of an Agent's Work](./09-agent-essence.md) | Knower, controller, self-corrector |
| 10 | [Context Engineering](./10-context-engineering.md) | constraints → judgment · progressive disclosure · unhobbling |
| 11 | [Agent Skills](./11-agent-skills.md) | knowledge delta · nine-type taxonomy · progressive disclosure |
| 12 | [Tool Observation](./12-tool-observation.md) | Sensor layer · observation budget · compression strategies |
| 13 | [Skill Quality Evaluation](./13-skill-quality-evaluation.md) | E/A/R · eight-dimension rubric · nine failure modes |
| 14 | [Delegation and Orchestration](./14-subagents.md) | observation pollution · long-loop instability · side-loop isolation · externalized orchestration |
| 15 | [Reason in Action](./15-reason-in-action.md) | local control nodes · Reason-able Action Space · ReAct → Re in Act |

## External Source Material (`sources/`)

| Directory | Description |
| --- | --- |
| [`sources/anthropic-claude5-context-engineering/`](./sources/anthropic-claude5-context-engineering/) | Claude 5 context engineering · [original post 2026-07](https://x.com/trq212/status/2080710971228918066) |
| [`sources/anthropic-effective-context-engineering/`](./sources/anthropic-effective-context-engineering/) | Effective context engineering · [Engineering 2025-09](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) |
| [`sources/anthropic-claude-code-skills/`](./sources/anthropic-claude-code-skills/) | Claude Code Skills guide · [original post 2026-03](https://x.com/trq212/status/2033949937936085378) |
| [`sources/anthropic-skill-creator/`](./sources/anthropic-skill-creator/) | skill-creator upstream index · [GitHub](https://github.com/anthropics/skills/tree/main/skills/skill-creator) |
| [`sources/softaworks-skill-judge/`](./sources/softaworks-skill-judge/) | skill-judge upstream index · [GitHub](https://github.com/softaworks/agent-toolkit/tree/main/skills/skill-judge) · not official Anthropic |
| [`sources/anthropic-claude-code-subagents/`](./sources/anthropic-claude-code-subagents/) | Claude Code Subagents · [docs](https://code.claude.com/docs/en/sub-agents) |
| [`sources/anthropic-dynamic-workflows/`](./sources/anthropic-dynamic-workflows/) | Dynamic workflows · [original post 2026-02](https://x.com/trq212/status/2061907337154367865) |
| [`sources/re-in-act/`](./sources/re-in-act/) | Re in Act open specification · [re-in-act.org](https://re-in-act.org) |

## Suggested Reading Order

- **01 → 09**: the pure theory skeleton (independent of any specific product)
- **10 → 11**: practical digests of Anthropic's 2026 guidance · 10 covers context slimming · 11 covers skill form and organization (same author · best read together)
- **12**: builds on 03/05/06/07 · dedicated to tool-return signal-to-noise ratio · complements 10
- **13**: builds on 11 · softaworks skill-judge's evaluation rubric · complements 11's "how to write" with "how to evaluate and how to lean"
- **14**: builds on 10/11 · side-loop observation isolation · externalized orchestration for long-loop instability · complements 03's Feedback bandwidth
- **15**: builds on 03/10/12 · where judgment lives (control nodes inside the action space) · localizes Feedback · complements 14's delegation containment
