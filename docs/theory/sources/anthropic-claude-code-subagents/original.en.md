# Create custom subagents (excerpt)

> **Source**: https://code.claude.com/docs/en/sub-agents  
> **Excerpt focus**: definition · built-in agents · general-purpose · context isolation · delegation patterns

---

Subagents are specialized AI assistants that handle specific types of tasks. Use one when a side task would flood your main conversation with search results, logs, or file contents you won't reference again: the subagent does that work in its own context and returns only the summary.

Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions. When Claude encounters a task that matches a subagent's description, it delegates to that subagent, which works independently and returns results.

Subagents help you:

* **Preserve context** by keeping exploration and implementation out of your main conversation
* **Enforce constraints** by limiting which tools a subagent can use
* **Reuse configurations** across projects with user-level subagents
* **Specialize behavior** with focused system prompts for specific domains
* **Control costs** by routing tasks to faster, cheaper models like Haiku

Claude uses each subagent's description to decide when to delegate tasks.

## Built-in subagents

### Explore

A fast, read-only agent optimized for searching and analyzing codebases.

* **Tools**: read-only tools; Write and Edit are denied
* **Purpose**: file discovery, code search, codebase exploration

Claude delegates to Explore when it needs to search or understand a codebase without making changes. Thoroughness levels: **quick** / **medium** / **very thorough**.

### Plan

A research agent used during plan mode to gather context before presenting a plan.

* **Tools**: read-only tools; Write and Edit are denied
* **Purpose**: codebase research for planning

### general-purpose

A capable agent for complex, multi-step tasks that require both exploration and action.

* **Model**: inherits from the main conversation
* **Tools**: every tool available to subagents
* **Purpose**: complex research, multi-step operations, code modifications

Claude delegates to general-purpose when the task requires both exploration and modification, complex reasoning to interpret results, or multiple dependent steps.

Unlike Explore and Plan, **general-purpose can be resumed** — use it when follow-up work on the same delegated thread is needed.

### claude

Catch-all with every tool available to subagents when no specialized agent fits.

## Common patterns

### Isolate high-volume operations

Running tests, fetching documentation, or processing log files can consume significant context. By delegating these to a subagent, verbose output stays in the subagent's context while only the relevant summary returns to your main conversation.

### Run parallel research

For independent investigations, spawn multiple subagents to work simultaneously. Each subagent explores its area independently, then Claude synthesizes the findings.

### Choose between subagents and main conversation

Use the **main conversation** when:

* The task needs frequent back-and-forth or iterative refinement
* Multiple phases share significant context
* You're making a quick, targeted change
* Latency matters

Use **subagents** when:

* The task produces verbose output you don't need in your main context
* You want to enforce specific tool restrictions or permissions
* The work is self-contained and can return a summary

Consider **Skills** instead when you want reusable prompts or workflows that run in the main conversation context rather than isolated subagent context.

## Manage subagent context

Each subagent starts with a **fresh, isolated context window**. It doesn't see your conversation history, the skills you've already invoked, or the files Claude has already read. Claude composes a delegation message that summarizes the task, and the subagent works from there.

A non-fork subagent's initial context contains:

* **System prompt**: the agent's own prompt (not the full Claude Code system prompt)
* **Task message**: the delegation prompt Claude writes when handing off
* **CLAUDE.md files**: hierarchy loaded like main conversation (Explore and Plan skip this)
* **Git status**: snapshot at parent session start (Explore and Plan skip)
* **Preloaded skills**: skills named in the agent's `skills` field

Some main-conversation state **never** reaches a subagent: output style, auto memory, and the parent's context window size (subagent uses its own model's window).
