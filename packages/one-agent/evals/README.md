# ONE Agent Evals

TypeScript benchmark runner that calls the real ONE agent runtime.

## Files

- `agent_eval.ts`: benchmark runner
- `datasets/`: downloaded benchmark datasets
- `results/`: JSON result reports

## Download real datasets

From `packages/one-agent`:

```bash
pnpm evals:download:browsecomp
pnpm evals:download:deepsearchqa
```

Notes:

- BrowseComp downloads from OpenAI public simple-evals storage.
- DeepSearchQA uses Kaggle CLI (`kaggle datasets download -d deepmind/deepsearchqa`).
- For Kaggle, configure `~/.kaggle/kaggle.json` first.

## Run evaluations

```bash
pnpm evals:smoke
pnpm evals:run:browsecomp
pnpm evals:run:deepsearchqa
```

Custom run examples:

```bash
tsx --env-file=.env ./evals/agent_eval.ts run --benchmark browsecomp --judge llm --max-samples 20
tsx --env-file=.env ./evals/agent_eval.ts run --benchmark custom --dataset-path /absolute/path/to/data.jsonl --judge exact
```

## CLI summary

Download mode:

```bash
tsx ./evals/agent_eval.ts download --dataset browsecomp --out-dir ./evals/datasets
tsx ./evals/agent_eval.ts download --dataset deepsearchqa --out-dir ./evals/datasets
```

Run mode:

```bash
tsx --env-file=.env ./evals/agent_eval.ts run --benchmark browsecomp --judge exact --max-samples 50
```
