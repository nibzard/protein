# Fixed-Quality Cost-to-Target Preregistration

## Question and scope

At one fixed, independently verified quality target, does Moore-neighborhood
exchange discover a qualifying artifact with fewer recorded Luna tokens than
isolated cells?

This is a prospective systems experiment on `sorted-unique-int32/v3`. The
completed three-pair pilot selected the design but is excluded from every
estimate and test below. This experiment measures one model, task, topology,
host, and budget configuration; it cannot establish learning or a general
swarm advantage.

## Frozen design

- Ten matched pairs, each containing one `local` and one `isolated` condition.
- A 4×4 population runs for four complete generations in every condition.
- The model is `gpt-5.6-luna` with `low` reasoning effort.
- Conditions use equal configured ceilings: 24 credits per cell, four model
  turns and three tool calls per cell-generation, dispatch concurrency eight,
  and the same model-output, provider, sandbox, evaluator, and runtime limits.
- Odd-numbered pairs run local then isolated; even-numbered pairs run isolated
  then local.
- The worker, prompt and tool-schema hashes, celld version, benchmark,
  evaluator, container-image digest, and all recorded control fields must
  match within every pair and across all twenty runs. The first passing run
  writes `frozen-controls.json`; each later run must match that fingerprint,
  while every configuration-bound field must also match the preregistered
  comparison manifest.
- One provider attempt is allowed per model action. Any ambiguous provider
  attempt or missing usage invalidates the token-cost claim for that pair.

Passing scores are never rerun. Operational condition attempts and invalid
measurement-block attempts are retained. A condition may be attempted at most
twice after a preregistered operational failure; retries never depend on its
score.

## Discovery and candidate panel

All four discovery generations finish before target measurement begins.
Measurement is serialized and cannot feed information back to the cells.

The measurement panel contains every distinct, evaluated, non-seed candidate
from that condition. Candidate hashes are deduplicated, while the earliest
authoritative evaluation generation is retained as the discovery generation.
Selecting only the online winner would preserve benchmark-selection noise and
could miss a qualifying candidate discovered earlier.

## Fixed verified-quality target

Every panel candidate receives nine fresh hidden rechecks. Rechecks run in
blocks of at most four candidates. Each block is measured as:

```text
trusted seed baseline → deterministically balanced candidates → trusted seed baseline
```

Candidate order rotates and reverses by repetition. The hidden evaluator runs
one benchmark at a time. For candidate score \(S_r\) and the two surrounding
seed scores \(B^-_r\) and \(B^+_r\), the normalized ratio is:

```text
baseline_r = sqrt(B^-_r * B^+_r)
ratio_r    = S_r / baseline_r
```

A candidate qualifies only when:

1. all 9/9 public, hidden, and benchmark correctness gates pass; and
2. at least 8/9 normalized ratios are at least `3.0`.

Both seed measurements must pass and be positive. Their drift ratio is
`max(B-, B+) / min(B-, B+)`; a block is accepted only when this is at most
`1.15`. An invalid block is retried once in full. A second failure makes target
evidence incomplete rather than classifying the condition as a non-reach.

The discovery prompt is `protein-swarm-code-agent/v4` with tool schema
`protein-swarm-tools/v3`. Prompt v4 presents verified performance as a multiple
of that run's seed (`seed = 1.0`) instead of exposing host-dependent raw scores.
Tool schema v3 keeps finalization identifiers and lineage runtime-bound, so the
model supplies intent rather than echoing protocol state. These versions and
their hashes are frozen across all twenty discovery runs. Post-run target
classification still uses fresh authoritative v3 hidden evaluations; the
model-visible normalized score is not itself evidence that the target passed.

## Discovery-cost endpoint

For each condition, the first qualifying candidate's earliest evaluation
generation is its first qualifying generation. Primary discovery cost is the
cumulative recorded Responses `total_tokens` for every cell through the end of
that fully settled generation. Using a generation boundary prevents concurrent
completion order from deciding the result.

Fresh target rechecks and their elapsed time are measurement overhead. They
are excluded from discovery cost and reported separately. Model turns, tool
executions, public checks, authoritative discovery evaluations, credits, and
elapsed discovery time are secondary costs measured at the same generation
boundary.

If no candidate qualifies after generation four, the condition is
right-censored at its recorded four-generation boundary. Its terminal cost is
reported but is never imputed as successful cost. Only pairs in which both
conditions reach the target enter paired cost distributions.

## Paired analysis

For each both-reached pair and cost metric \(C\):

```text
local_vs_isolated_pct = 100 * (C_local - C_isolated) / C_isolated
```

Token differences from `-5%` through `+5%` are ties. A one-sided reach counts
as a directional cost win only when its recorded reaching cost is at least 5%
below the other condition's censor boundary; otherwise its cost order remains
indeterminate and it is a tie for the sign test. A neither-reached pair is also
a tie. Thus censored observations affect target attainment, but only a
conservative boundary-dominance result affects the directional cost test, and
no censored observation is inserted into the continuous paired-cost
distribution.

The primary directional test is an exact one-sided sign test over non-tied
pair outcomes with `alpha = 0.05`. Paired token-cost summaries require at least
six both-reached pairs. The median paired difference receives a deterministic
10,000-sample percentile-bootstrap 95% interval using the frozen seed
`protein-cost-target-v1`. No alternative target, stopping rule, or bootstrap
seed is selected after results are observed.

## Decision and claim boundary

A lower-cost result is supported only when all ten planned pairs and their
controls are valid, provider usage is unambiguous, at least six pairs are
cost-comparable, local target attainment is no worse, local wins exceed
isolated wins, the exact test has `p < 0.05`, median paired token cost is at
least 5% lower, and the bootstrap interval lies wholly below zero. The reverse
criteria support a higher-cost result. Every other complete result is
inconclusive; incomplete evidence remains incomplete.

Permitted wording is limited to the frozen setting, for example: “Under this
4×4, four-generation Luna protocol, local exchange reached the fixed verified
quality target with lower recorded discovery-token cost.” Do not claim
equivalence from a null result, count right-censored terminal cost as successful
cost, pool the old pilot, or claim learning, production savings, or general
swarm superiority.
