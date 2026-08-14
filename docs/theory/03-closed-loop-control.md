# 3. Closed-Loop Control Systems

From a cybernetics standpoint, the agent-environment interaction should be understood as a closed loop, not one-way execution.

A minimal closed loop usually includes:

- `Reference`: target state, constraints, criteria for judgment
- `Sensor`: observation of the current state
- `Actuator`: the ability to act and change state
- `Feedback`: revising subsequent judgments and actions based on results

If any of these elements is missing, control degrades:

- Without `Reference`, the agent doesn't know where the system should be pushed
- Without `Sensor`, the agent doesn't know where the system currently is
- Without `Actuator`, even a known problem cannot be changed
- Without `Feedback`, errors cannot be corrected

An agent, then, should not be seen merely as an instruction executor, but as a controller maintaining a stable closed loop among goals, state, actions, and feedback.
