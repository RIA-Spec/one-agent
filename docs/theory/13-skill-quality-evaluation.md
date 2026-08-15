# 13. Skill Quality Evaluation

> **Source**: [softaworks skill-judge](https://github.com/softaworks/agent-toolkit/tree/main/skills/skill-judge) · original in [`sources/`](./sources/) · complements [11](./11-agent-skills.md)

## Core Thesis

A Skill is **knowledge externalization**, not a tutorial: it changes agent behavior on the next call by editing markdown — no weight changes, no retraining. Its value is measured by **knowledge delta**, not how professional it looks.

> Good Skill = knowledge only experts know − what the model already knows

The context window is shared public resource; explaining "what is a PDF" or "how to write a for loop" is compressing the model's existing knowledge = token waste.

## Three Kinds of Knowledge (E / A / R)

| Type | Definition | Disposition |
| --- | --- | --- |
| **Expert [E]** | the model genuinely doesn't know | **keep** — the Skill's value |
| **Activation [A]** | knows it but may not recall | short reminder is fine |
| **Redundant [R]** | definitely knows it | **delete** — token waste |

Target ratio (rough): E >70% · A <20% · R <10%.

**Meta-question**: would a domain expert say "yes, this took me years of mistakes to learn"? If yes, it has real value; if no, it's just compressing Claude's existing knowledge.

## Eight-Dimension Rubric (120 pts)

| Dimension | Pts | What it tests |
| --- | --- | --- |
| D1 Knowledge Delta | 20 | expert-only knowledge, no tutorial redundancy |
| D2 Mindset + Procedures | 15 | thinking frameworks + domain-specific flows |
| D3 Anti-Pattern Quality | 15 | concrete NEVERs with non-obvious reasons |
| D4 Specification Compliance | 15 | valid frontmatter · description as trigger spec |
| D5 Progressive Disclosure | 15 | L1/L2/L3 layering · embedded load triggers |
| D6 Freedom Calibration | 15 | constraint strength matches task fragility |
| D7 Pattern Recognition | 10 | follows one of five official design patterns |
| D8 Practical Usability | 15 | decision trees, runnable examples, fallbacks, edge cases |

**D4 is structural**: the agent sees only descriptions when deciding what to load — if trigger info is in the body but not the description, the Skill will never be loaded.

**D6**: creative tasks → high freedom; binary/format operations → low freedom (fixed scripts).

## Five Design Patterns

| Pattern | ~Lines | Character | Best for |
| --- | --- | --- | --- |
| Mindset | 50 | thinking > technique · strong NEVERs | creative tasks needing taste |
| Navigation | 30 | minimal SKILL.md routing to sub-files | multi-scenario dispatch |
| Philosophy | 150 | philosophy → expression · craft | original creation |
| Process | 200 | staged · checkpoints · medium freedom | complex multi-step projects |
| Tool | 300 | decision trees · code examples · low freedom | precise format operations |

## Common Failure Modes

| # | Name | Fix |
| --- | --- | --- |
| 1 | The Tutorial | delete basics; keep decisions/trade-offs/anti-patterns |
| 2 | The Dump | progressive disclosure (L2 <300 lines) |
| 3 | Orphan References | embed MANDATORY / Do NOT Load triggers in workflow |
| 4 | Checkbox Procedure | add "Before X, ask…" + domain flows |
| 5 | Vague Warning | concrete NEVER + non-obvious reason |
| 6 | Invisible Skill | rewrite description with WHAT/WHEN/KEYWORDS |
| 7 | Wrong Location | trigger info all into description |
| 8 | Over-Engineered | keep only what the agent needs to run the task |
| 9 | Freedom Mismatch | creative = high freedom · fragile = low freedom |

## Review Protocol

1. **Knowledge delta scan** — mark E/A/R per section, compute ratio
2. **Structural analysis** — frontmatter, lines, references, pattern, load triggers
3. **Dimension scoring** — cite evidence, one-line reasons
4. **Aggregate grade** — A (108+) → F (<60)
5. **Report** — Summary · Critical Issues · Top 3 Improvements

## Theory

Evaluation is the Feedback that closes the Skill loop: read the Skill (Sensor) → apply the rubric (Reference) → produce an improvement list (Feedback) — see [03](./03-closed-loop-control.md) · [07](./07-evidence-evaluation.md).
