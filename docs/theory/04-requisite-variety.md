# 4. Requisite Variety and the Good Regulator

The Law of Requisite Variety states that for a controller to effectively control an environment, it must itself possess enough variety in states and actions to cover the environment's variation.

The Good Regulator theorem states that every good regulator must be a model of the system it regulates.

Together, these two principles say that an agent's effective control depends on two things:

- It must have enough variety to cope with environmental change
- It must form an internal model close enough to the environment

Change in an internal system can come from:

- Permission differences
- Incomplete data
- State drift
- Branching flows
- Exceptional flows
- Legacy structures
- Discrepancies between stated rules and actual behavior

If an agent has only a single path, a single way of judging, or a single action pattern, it quickly loses control once the environment deviates from the standard case.

If an agent's internal model is too coarse, too stale, or wrong, then the stronger its actions, the worse the deviation usually becomes.

A stably working agent must therefore have, at once:

- A grasp of the overall goal
- The ability to recognize local state
- The ability to switch between different observation surfaces
- The ability to switch between different means of intervention
- The ability to reorganize action sequences when the original path fails
- The ability to continuously correct its internal model

Requisite variety emphasizes that control capability must match environmental complexity; the Good Regulator theorem emphasizes that control capability must rest on a sufficiently true internal model.
