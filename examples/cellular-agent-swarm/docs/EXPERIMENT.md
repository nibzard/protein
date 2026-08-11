# Experiment Plan

## Evidence boundary

Keep three modes separate in code, output, UI, and claims:

1. `scripted-simulation` previews interaction and visualization contracts. It
   contains authored outcomes and does not run celld or an LLM.
2. `celld-smoke-mock-services` runs real named Protein cells through celld with
   deterministic external capabilities. It can establish runtime behavior,
   action recovery, identity semantics, and resource measurements only.
3. `celld-experiment` uses recorded live model calls, a sandbox executor,
   separate hidden evaluation, and durable board receipts. A run at this level
   has the machinery needed for an experiment, but answers the research
   question only after the repeated equal-budget comparison protocol below is
   completed.

`npm run swarm:celld` produces level 2 evidence. Its scores are smoke fixture
measurements, not comparative agent results. `npm run swarm:openai` produces
the level 3 evidence shape for a small live vertical slice; the label does not
mean the comparison has been run.

## Live vertical slice

The default live pilot runs 2 x 2 real Protein cells for two generations. It
connects the raw OpenAI Responses gateway, bounded tool loop, containerized
public executor, separate hidden evaluator, deterministic receipt board, and
run evidence end to end. It is deliberately small enough to inspect and to
bound live API cost.

That single pilot can establish that the components interoperate under its
recorded configuration. It is not repeated evidence, does not compare all
three conditions, and does not demonstrate equal budget. It cannot establish
that locality helped, that agents learned, or that a swarm outperformed one
agent. No headline quality or cooperation metric should be computed from it as
though it were the experiment below.

## Implemented local-versus-isolated comparison

`npm run swarm:compare` implements the narrower topology comparison needed
before adding the sequential condition. Its frozen default is three matched
pairs, 4 x 4 cells, four generations, `gpt-5.6-luna` at low reasoning, 24
credits per cell, at most four model turns and three non-terminal tool calls per
cell and generation, benchmark `sorted-unique-int32/v3`, and evaluator
`protein-swarm-evaluator/v3`. Local and isolated order alternates by pair.

The runner verifies equal configured ceilings and records actual consumption;
it does not call unequal spend "equal budget." Passing outcomes are never
rerun. Operational retries remain visible alongside provider attempts and
ambiguous calls. The first completed comparison produced one local win, one
isolated win, and one tie, with a median local-minus-isolated seed-relative
effect of -1.33 percentage points. The supported conclusion is only that no
repeatable neighbor-exchange advantage was observed in those three pairs.

The completed bundle records prompt/tool schema v2. A post-run fallback audit
led to v3, where finalization no longer asks the model to echo strategy or
lineage identifiers already held by the runtime. V3 has a bounded live protocol
probe, but the recorded v2 comparison is not relabeled or recomputed as a v3
experiment. Pair validation requires non-missing equality across the protocol,
prompt and tool versions, tool hash, Worker hash, model settings, sandbox image,
benchmark serialization, topology, and configured ceilings.

Local consumed fewer recorded tokens, turns, tools, evaluations, and elapsed
time in every pair while final best scores remained close. That is a secondary
descriptive efficiency pattern, not proof of quality equivalence or a general
swarm advantage. Candidate lineage suggests reuse and earlier convergence, not
learning or collaborative synthesis.

The preregistered 5-point band classifies pair outcomes; it is not a validated
equivalence margin. Runtime evaluations of identical candidate hashes varied
by more than 5%, and isolated conditions had more evaluations, so a best-score
endpoint also has unequal best-of-many noise opportunity. Replication should
first reduce or model this evaluator variability.

## Research question

At a fixed total model and tool budget, does local exchange between durable
agents improve the best verified solution compared with one sequential agent
or the same population working independently?

The experiment must answer this question even if the answer is no. Agent
activity, attractive animations, and message volume are not success metrics.

## First task

Use one small code-improvement fixture with:

- a correct but meaningfully inefficient baseline;
- more than one plausible optimization strategy;
- deterministic public correctness tests;
- hidden edge cases unavailable to agents and the model gateway;
- a stable performance benchmark isolated from agent workspaces;
- a useful final patch that a person can inspect;
- a short runtime so repeated trials are affordable.

The task, evaluator, and score policy are frozen before comparative runs begin.
The fixture may be purpose-built, but the work must remain genuine code
reasoning and modification rather than selecting from predefined solutions.

## Comparison conditions

All conditions receive the same starting artifact, task information, model
family, tool capabilities, and total accounted budget.

1. **Sequential:** one agent may spend the complete budget over repeated turns.
2. **Isolated:** the population works in parallel but receives no other cell's
   candidates or results.
3. **Local swarm:** the same population receives only its configured neighbors'
   frozen summaries at generation boundaries.

The MVP population is 4 x 4 with a Moore neighborhood and ten generations.
Those values are experimental parameters, not framework assumptions.

## Fair budget

Before implementation, define accounting units for:

- model input and output usage;
- model request count;
- executor CPU time or normalized tool time;
- evaluation count;
- wall-clock deadline.

Parallelism may improve elapsed time, but it must not create undisclosed extra
compute. Report total consumed resources and wall time separately. Failed,
retried, and reconciled operations remain visible in the accounting even when
a provider cannot prevent duplicate billing.

In particular, a model-provider timeout after dispatch is ambiguous. A retry
may create and bill another response even when the local gateway action later
completes once. Count every known attempt, retry, returned usage record, and
ambiguous attempt; never infer zero cost merely because no provider response ID
arrived.

## Scoring

Correctness is a gate. A candidate that fails required public or hidden tests
cannot win through performance alone.

Among correct candidates, the primary endpoint is the best independently
verified performance reached within the fixed budget. Cost, time, and solution
diversity are reported separately rather than hidden inside an arbitrary
composite score.

The active artifact fixture freezes its benchmark statistic and within-run
noise handling in [BENCHMARK-V3.md](./BENCHMARK-V3.md). A comparison still
predeclares its whole-run repetition count, tie rule, and minimum meaningful
effect before trials begin.

## Secondary measures

- time and cost to the first correct improvement;
- median and best verified score by generation;
- invalid candidates rejected by public tests and hidden evaluation;
- useful challenges or new tests discovered;
- independent discoveries versus adopted improvements;
- candidate and strategy diversity over time;
- duplicate or abandoned work;
- model, tool, and evaluation utilization;
- inactive, exhausted, late, and failed cells;
- completeness of lineage and evidence;
- recovery time and logical duplicate count after interruption.

## Trial protocol

1. Record the complete configuration, prompt policy, model identifier, task and
   evaluator versions, budgets, seeds, and environment metadata.
2. Start every condition from the same immutable baseline.
3. Run without manual steering after the condition begins.
4. Preserve all Protein journals, action receipts, candidate references,
   evaluations, settlements, and usage records.
5. Repeat each condition enough times to show variation rather than presenting
   the best run. Pilot repetitions may be small; the final count is chosen
   before looking at comparative results.
6. Report all configured runs, including failures and timeouts.

The trial manifest records non-secret model settings, requested and returned
model identifiers, prompt/tool schema versions and hashes, turn and tool
limits, retry policy, provider request IDs, usage, sandbox/evaluator versions,
and any ambiguous attempts. It never records the API key.

## Reliability exercise

At least one separate run interrupts the model gateway or candidate executor
after dispatch begins. The expected outcome is eventual convergence through
idempotency or authoritative reconciliation, with no duplicate logical
candidate or evaluation. This is a durability demonstration, not part of the
quality comparison.

Current celld ownership and replication limitations documented in
[PROOFS.md](../../../PROOFS.md) must be disclosed with the result. The demo does
not claim exactly-once execution.

Gateway receiver receipts can reconcile the same Protein action and request
hash, but they cannot prove exactly-once execution by the external model
provider. This distinction must remain visible in the recovery report.

## Interpretation

The local swarm is promising if it produces a predeclared meaningful
improvement over the isolated population at the same budget, or reaches
equivalent quality with materially better cost or time, across repeated runs.

If it performs no better, converges prematurely, or spends most of its budget
copying and coordinating, that is a useful negative result. The next step is to
change or reject the interaction hypothesis—not to add more agents until the
animation looks busier.

## Demonstration view

The UI should explain the evidence rather than replace it:

- grid color shows verified score;
- activity and lineage show where ideas originate and spread;
- a selected cell exposes its observation, decision, artifacts, evidence, and
  cost;
- charts compare best and median score, diversity, and usage by generation;
- a timeline replays immutable records;
- the final screen compares all three conditions and links to the winning
  artifact and evaluation.

Public projections show bounded summaries, hashes, aggregate hidden pass
counts, and evidence references. They exclude credentials, raw model replay
items and reasoning, generated source and function arguments, unbounded error
bodies, and hidden case inputs, expected values, names, or per-case failures.
