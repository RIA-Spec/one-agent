# 6. Abstraction Levels

A complex environment cannot be understood and controlled through a single abstraction layer alone.

Theoretically, there are at least two different but complementary abstractions:

- `Semantic abstraction`: goals, scenarios, object relationships, key constraints
- `Operational abstraction`: actions, conditions, inputs/outputs, local state changes

Semantic abstraction lowers the agent's comprehension cost so it first grasps "what problem am I actually dealing with."
Operational abstraction preserves local control so the agent can decompose, advance, and correct the overall problem.

With only semantic abstraction, the agent tends to stay at the macro level and never land on concrete action.
With only operational abstraction, the agent tends to drown in stacks of local actions and lose the overall direction.

An effective agent must therefore be able to switch between abstraction levels.
