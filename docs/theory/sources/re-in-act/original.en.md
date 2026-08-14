# Re in Act — Open Specification for Reason in Action

> Source: https://re-in-act.org — captured 2026-08-14.

## From ReAct to Re in Act

Re in Act extends reason into the action loop, so AI agents can handle environment disturbances with fewer round trips, less context noise, and stronger local control. Compared with traditional ReAct agents.

### Reason-able Action Space (RAS)

One Reason-able Action Space can coordinate multiple `act()` and `reason()` steps before returning a denoised result.

1. `act()` gathers local evidence — run tests, read logs, or fetch a document without pushing raw output back to top-level reasoning.
2. `reason()` compresses the local signal — turn noisy evidence into one bounded decision using an explicit goal, observation, relevant context, and constraints.
3. `act()` + `reason()` keep the space moving — execute the next step, inspect the result again, and only return a denoised outcome once the local job is actually settled.

### Paradigm Shift

ReAct returns to the outer loop at every step. Re in Act keeps the work moving inside one RAS.

- Thin Action Layer → Reason-able Action Space Strengthens Local Action
- Round-Trip Tax (Reason-Act-Observe) → One Orchestrated Action Phase
- Raw Intermediate Data in Main Context → Intermediate Data Stays in Reason-able Action Space
- Probabilistic Micro-Control Flow → Deterministic Runtime Control Flow

### Two Action Forms

The same idea can run as code or shell pipelines. In both forms, deterministic Turing-complete control is stronger than probabilistic LLM-stepped flow.

## The Interfaces

Two simple interfaces: one for local judgment, one for external action.

### `reason(prompt, example_output)` — Local judgment

Turns goal plus local reality into structured output that the Reason-able Action Space can use right away.

- `prompt`: goal + observation + context + constraints (`string | list`)
- `example_output`: schema hint (`any`)
- returns `{ data }` structured result, or `{ error }` on validation failure after retries

Example prompt:

```text
Goal: decide continue vs retry.
Observation: noisy build log.
Constraints: ignore ANSI noise; return action + reason.
```

### `act(name, args)` — Optional

Calls tools or external systems with explicit arguments, returning structured output and errors. `act()` is optional — the spec provides it as a standard convenience; any user-defined action strategy may be used instead.

- `name`: tool identifier — MCP tool, custom function, bash command, etc.
- `args`: complete tool arguments; stateless — include all needed context
- returns `{ content: [{type, text}], isError: bool }`

## Reason-able Action Spaces in Practice

### Code Reason-able Action Space (Python / TS)

Deterministic orchestration in scripts: branches, loops, retries, and validation happen in code, while `reason()` supplies bounded judgments. That gives the runtime Turing-complete deterministic control instead of probabilistic LLM-stepped control.

```python
test_run = await act('bash', 'npm test -- --reporter json')
focus = await reason(
    ['Goal: pick the retry step.', observation, 'Relevant context: latest CI run.',
     'Constraints: return retry_cmd + reason only.'],
    {"retry_cmd": "", "reason": ""},
)
retry_run = await act('bash', focus['data']['retry_cmd'])
decision = await reason(
    ['Goal: continue or escalate?', retry_run['content'][0]['text'], focus['data']['reason'],
     'Constraints: return action + reason only.'],
    {"action": "continue", "reason": ""},
)
if decision['data']['action'] == 'escalate':
    await act('notify', {'message': decision['data']['reason']})
    print(decision['data']['reason'])
else:
    await act('deploy', {'target': 'production'})
    print('deployed')
```

### Bash Reason-able Action Space

Unix-style pipelines compose `reason` and `act` in a single action phase. Shell gives deterministic, Turing-complete control flow, while the LLM stays confined to bounded local judgments.

```bash
act --manual | \
  reason --prompt "Goal: find the tools needed for this task." --prompt - \
         --prompt "Constraints: return only a JSON array of tool names." \
         --structure '["tool_name"]' | \
  jq -r '.data[]' | while read -r name; do act --manual "$name"; done
```

## Reason-able Action Space as Harness (optional `agent()` extension)

When the optional `agent()` extension is used, the Reason-able Action Space is the harness: `agent()` runs delegated work inside the RAS, returns text and trajectory, `reason()` verifies those signals inside the RAS, and deterministic limits (loops, max iterations, timeout, escalation, stop conditions) are enforced inside the RAS.

This harness framing belongs to the optional `agent()` extension — the point is not that `reason()` is agent-related by itself, but that once `agent()` is introduced, the RAS becomes the harness that contains delegated work, verification, and escalation.
