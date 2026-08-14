# 11. Agent Skills

> **Sources**: [Claude Code Skills guide](https://x.com/trq212/status/2033949937936085378) · [skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator) · originals in [`sources/`](./sources/)

## Core Thesis

A Skill is **not a markdown file but a folder** the agent can discover, explore, and operate on:

```text
skill-name/
├── SKILL.md          # frontmatter (name + description) + entry instructions
├── references/       # on-demand documentation
├── scripts/          # executable, composable deterministic logic
├── assets/           # templates, icons, output materials
└── evals/            # test cases, benchmarks, iteration history
```

Its value is pulling organization-specific knowledge / verification / processes out of the model's defaults and turning them into a distributable, iterable Actuator extension.

**Knowledge delta**:

> Good Skill = knowledge only experts know − what the model already knows

Generic coding knowledge the model already has is token waste; gotchas, footguns, and organization-specific decision trees are the high-signal content.

## Progressive Disclosure: Three Layers

| Layer | Content | When loaded |
| --- | --- | --- |
| **L1 Metadata** | `name` + `description` (~100 words) | always |
| **L2 SKILL.md body** | entry instructions, routing, gotchas | after trigger (ideally <500 lines) |
| **L3 Bundled** | `references/` · `scripts/` · `assets/` | on demand |

SKILL.md acts as resolver + pointer; large files get a TOC and split into hierarchies.

## Writing Principles

- **Knowledge delta** — only what the model wouldn't default to
- **Gotchas section** — accumulated from real failures; highest signal density
- **Description = trigger spec** — when to enable + what it does; slightly pushy is fine
- **Avoid railroading** — explain why; minimize all-caps MUST/NEVER
- **Scripts > prose** — helpers the agent keeps rewriting sink into `scripts/`
- **On-demand hooks** — destructive/global behavior only while the Skill is active
- **Stable memory dir** — don't lose user data on Skill upgrade

## Iteration Loop (skill-creator)

```text
Capture intent → research → draft SKILL.md + references/scripts
→ test cases (real user voice) → parallel runs (with_skill ∥ baseline)
→ assertions → grade → benchmark → feedback → improve → repeat
```

Improve by **generalizing** (don't overfit evals), **keeping lean**, **explaining why**, and **bundling repeated scripts**.

## Theory

Skill = Reference + Actuator guidance loaded on demand in the main loop ([03](./03-closed-loop-control.md) · [10](./10-context-engineering.md)); evaluation of quality in [13](./13-skill-quality-evaluation.md); side-loop isolation in [14](./14-subagents.md).
