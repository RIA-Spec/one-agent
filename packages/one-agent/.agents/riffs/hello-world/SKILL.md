---
name: hello-world
description: Minimal example riff - prints a greeting. Use as a template for new riffs.
metadata:
  riff: 'true'
  parameters: '{}'
---
# hello-world

Minimal example riff - prints a greeting. Use as a template for new riffs.

Ships both `scripts/ras.py` (Python) and `scripts/ras.sh` (bash). `riff run` picks the script matching the current RAS mode: Python mode executes `ras.py` inline, bash mode returns a command that runs `ras.sh` (execute it with `act bash`).

## Parameters
- none (optional `name` in RIFF_PARAMS, defaults to "world")

## Execution
- Python: `riff run hello-world` or `riff run hello-world --params '{"name":"Codex"}'`
- Bash: `riff run hello-world` returns `RIFF_PARAMS='...' bash scripts/ras.sh`
