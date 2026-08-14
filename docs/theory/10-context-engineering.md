# 10. Context Engineering

> **Sources**: [Claude 5 context engineering](https://x.com/trq212/status/2080710971228918066) · [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · originals in [`sources/`](./sources/)

## Core Thesis

**A prompt is the input to one request; context is the environment shared across many requests.**

As models get stronger, stuffing every rule, example, and process into the system prompt / CLAUDE.md / Skill flips from "protecting against the worst case" to **over-constraining**: the model must digest large volumes of conflicting instructions before it can infer intent. Anthropic cut ~80% of Claude Code's system prompt with no measurable loss — the point is not removing capability but **unhobbling**: returning judgment to the model and moving details into on-demand modules.

## Then → Now

| Then | Now |
| --- | --- |
| Give the model rules | Let it use judgment |
| Give tool-use examples | Design expressive interfaces |
| Load everything upfront | Progressive disclosure |
| Repeat instructions | Concise tool descriptions |
| Static memory files | Feedback-derived memory |
| Plain-text specs | High-fidelity references (code, tests, artifacts) |

## Four Context Kinds

1. **System prompt** — product identity and boundaries
2. **CLAUDE.md** — lightweight: repo purpose + codebase gotchas; don't state the obvious
3. **Skills** — on-demand guides; long Skills split into file trees
4. **References (@ files)** — deep references for plans/specs; executable forms > prose

**Theory**: narrow the resident Reference layer, expand on-demand References and more expressive Actuator interfaces. See the closed-loop mapping in [03](./03-closed-loop-control.md) and [12](./12-tool-observation.md).

## Practice Checklist (condensed)

- [ ] No contradictory "do / don't" pairs in resident context
- [ ] Could 20%+ of rules be removed without losing safety?
- [ ] Long flows split into Skills / deferred tools?
- [ ] Tool returns high signal-to-noise, with truncation/handle metadata?
