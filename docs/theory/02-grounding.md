# 2. Grounding, Priors, and Posteriors

Grounding is about how cognition aligns with the environment.

No agent enters a task as a blank slate. It always carries prior knowledge, prior patterns, prior experience, and prior default assumptions. These raise startup efficiency, but they also create a systemic risk: the agent can easily mistake general experience for the true state of the current environment.

Epistemologically, an agent's understanding is always being updated between `prior` and `posterior`:

- `Prior`: knowledge, patterns, and default assumptions held before entering the current environment
- `Posterior`: understanding revised by observations, execution results, and new evidence in the current environment

The core of grounding, therefore, is not adding background information but pressing understanding back down onto verifiable facts in the environment. It requires the agent to at least distinguish:

- `Facts`: what the current environment already supports
- `Inferences`: judgments formed from facts that could still be overturned
- `Unknowns`: parts where current evidence is insufficient to conclude anything

The goal of grounding is not to build a story that sounds coherent, but a minimal true model that keeps working.

This means:

- Concepts cannot replace facts
- Names cannot replace structure
- Experience cannot replace evidence
- Local observation cannot be directly extrapolated into global laws

When an agent is stuck, keeps failing, or is told its understanding is off, the cause is often not insufficient action capability but a distorted posterior that needs to return to grounding.
