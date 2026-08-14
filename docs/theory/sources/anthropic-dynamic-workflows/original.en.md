# A harness for every task: dynamic workflows in Claude Code

> **Author**: Thariq Shihipar (@trq212) · Anthropic  
> **Published**: 2026-02  
> **Source**: https://x.com/trq212/status/2061907337154367865  
> **Also on**: Claude Blog · [Dynamic workflows docs](https://code.claude.com/docs/en/workflows)

---

Last week, we released dynamic workflows in Claude Code. Claude can now write its own harness on the fly, custom-built for the task at hand.

While the default Claude Code harness is built for coding, it is also useful for many other types of tasks because, as it turns out, many tasks resemble coding tasks. But there are certain classes of tasks where we have had to build custom harnesses on top of Claude Code to achieve peak performance such as Research, security analysis, agent teams, or Code Review.

Workflows allow you to dynamically create harnesses that enable Claude to solve all of those problems and more natively inside of Claude Code. You can also share and re-use these workflows with others.

## Example prompts

- "This test fails maybe 1 in 50 runs. Set up a workflow to reproduce it, form theories and adversarially test them in worktrees /goal don't stop until one theory works."
- "Using a workflow, go through my last 50 sessions and mine them for corrections I keep making and turn the recurring ones into CLAUDE.md rules"
- "Use a workflow to dig through #incidents in Slack for the past six months and find recurring root causes where nobody has filed a ticket."
- "Take my business plan and run a workflow where different agents tear it apart from an investor's, a customer's, and a competitor's perspective."
- "Go through my blog post draft and using a workflow verify every technical claim against the codebase, I don't want to ship anything wrong."

## How dynamic workflows work

Dynamic workflows execute a javascript file with a few special functions that help spawn and coordinate subagents.

Dynamic workflows also include standard JavaScript functions like JSON, Math, and Array, to help process data.

It's particularly useful to know that dynamic workflows can decide which models an agent uses and whether subagents are run in their own worktree, allowing Claude to choose the intelligence level and isolation needed.

If a workflow is interrupted, for example by user action or quitting the terminal, resuming the session will allow the workflow to pick up where it left off.

## Why dynamic workflows

When you ask the default Claude Code harness to do a task, it needs to both plan and execute in the same context window. For many coding tasks, this is highly effective, but it can sometimes break down over long-running, massively parallel and/or highly structured adversarial tasks.

The longer Claude works on a complex task in a single context window, the more it becomes susceptible to:

- **Agentic laziness** — stops before finishing a complex, multi-part task after partial progress
- **Self-preferential bias** — prefers its own results when asked to verify against a rubric
- **Goal drift** — gradual loss of fidelity to the original objective across many turns, especially after compaction

Creating a workflow helps combat these by orchestrating separate Claudes with their own context windows and focused, isolated goals.

## Dynamic vs static workflows

Static workflows (Agent SDK, `claude -p`) need to work for all edge cases and are usually more generic. With Claude Opus 4.8 and dynamic workflows, Claude is now intelligent enough to write a custom harness tailor-made for your use case.

## Helpful patterns

- **Classify-and-act** — classifier routes to different agents or behavior
- **Fan-out-and-synthesize** — split into steps, run agent per step, barrier merge
- **Adversarial verification** — separate verifier per spawned agent
- **Generate-and-filter** — generate ideas, filter by rubric, dedupe
- **Tournament** — N agents compete; judge picks winner pairwise
- **Loop until done** — spawn until stop condition (no new findings, no errors)

## Use cases

- **Migrations and refactors** — fan-out per callsite/module; fix in worktree; adversarial review; merge
- **Deep research** — fan-out searches, fetch, adversarial verify claims, synthesize cited report
- **Deep verification** — identify factual claims; one subagent checks each
- **Sorting at scale** — tournament or bucket-rank when 1000+ rows won't fit one prompt
- **Memory and rule adherence** — one verifier agent per rule; skeptic persona for false positives
- **Root-cause investigation** — disjoint evidence agents (logs, files, data); panel of verifiers
- **Triaging at scale** — classify, dedupe, act; quarantine untrusted readers from high-privilege actions
- **Model routing** — classifier picks Sonnet vs Opus based on expected complexity

## When not to use dynamic workflows

Workflows often use more tokens. Regular coding tasks usually do not need a panel of 5 reviewers. Ask: does it really need more compute?

## Tips

- Detailed prompting with the patterns above creates best results
- "Quick workflow" for small adversarial checks
- Pair with `/goal` and `/loop` for repeatable triage/research
- Token budgets: prompt "use 10k tokens" to cap usage
- Save with `s` in workflow menu; check into `~/.claude/workflows` or distribute via Skill

---

*Thariq Shihipar and Sid Bidasaria (@sidbid) · Anthropic · Claude Code*
