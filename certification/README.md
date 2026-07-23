# Certification

A golden-set certification suite for the model-agnostic runtime: run the same
tasks against each provider you might use and see which models can actually
handle your assistant's workload.

The harness lives in `src/eval/` and is driven by `scripts/ab-eval.ts`. Tasks are
tagged `smoke` (a fast subset) or `full` (the whole grid), and every check is
deterministic (no LLM grading).

## Files

- **`baseline.json`** (committed once you create it) — your certified bar: the
  last run you promoted with `--update-baseline`. Regression checks compare
  against it, and it lives in git so certification drift shows up in a diff.
  This repo ships without one; you seed it from your own providers (see below).
- **`runs/`** (gitignored) — per-run history written by `--save`, for local
  before/after comparison.

## Workflow

```bash
# Build first (the compiled JS runs under your pinned Node):
npm run build

# See what a single provider scores (reads AI_PROVIDER/AI_MODEL from .env):
node dist/scripts/ab-eval.js --tier=full

# Grid several providers at once (needs each provider's key in .env):
node dist/scripts/ab-eval.js --providers=anthropic,openai,google --tier=full

# Happy with the result? Promote it to your certified bar:
node dist/scripts/ab-eval.js --providers=anthropic,openai,google --tier=full --update-baseline

# Later, gate changes against the bar (exits non-zero on a regression):
node dist/scripts/ab-eval.js --providers=anthropic,openai,google --tier=full --baseline
```

`--baseline` exits non-zero if any task regressed (baseline PASS → now FAIL) or
if a provider that exists in the baseline did not run this time (a certified lane
you are no longer verifying), so it can gate CI. `--tier` defaults to `smoke` to
keep casual runs cheap; the full grid costs real tokens (one round-trip per task
per provider).

## Flags

- `--tier=smoke|full` — task subset (default `smoke`)
- `--providers=a,b,c` — grid these providers (injected models, `.env` untouched)
- `--<provider>-model=` — override a provider's model
- `--task=<name>` / `--category=<name>` — run a single task or capability bucket
- `--save` — write this run to `certification/runs/`
- `--baseline` — compare against `certification/baseline.json`
- `--update-baseline` — promote this run to the certified bar
