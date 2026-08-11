# Build Plan

## Guiding rule

Build one evidence-producing vertical slice at a time. Keep the first
implementation local to this example. Reusable framework primitives are an
outcome to earn through a second environment, not a package to design in
advance.

## Milestone 0 — freeze the experiment

Status: complete for the scripted scenario, celld smoke fixture, and live
vertical-slice interfaces. The fairness protocol for a full comparison is not
yet frozen.

Freeze checklist:

- select and license the first task fixture;
- freeze the evaluator boundary and initial score policy;
- define model, tool, evaluation, and time budget accounting;
- freeze the model gateway's request, replay, receipt, and reconciliation
  contract;
- define generation deadlines and late results;
- choose content identity and storage for artifacts;
- review the contracts against Protein's existing lifecycle.

Evidence: `artifact-benchmark.mjs` contains a versioned task, executable source
artifacts, public and hidden smoke checks, and wall-time measurements. These
checks share a process with the mock capability and are not independent
experiment evidence. The live path now has a separate executor/evaluator
boundary and the raw Responses contract in
[MODEL-GATEWAY.md](./MODEL-GATEWAY.md). The active v3 task freezes deterministic
multi-regime inputs and repeated-median scoring in
[BENCHMARK-V3.md](./BENCHMARK-V3.md). Equal-budget units, deadlines, trial
count, tie policy, and the meaningful-effect threshold remain to be frozen for
the comparative run.

## Milestone 1 — deterministic celld slice

Status: complete at evidence level `celld-smoke-mock-services`.

`worker.ts` accepts generation events, records durable and correlated decision
actions, materializes or adopts candidates, submits through a reconcilable
board action, and exposes state, actions, and journals. `swarm-celld-run.mjs`
deploys the Worker to real celld, drives 16 named cells, verifies identity
deduplication and conflicts, restarts celld, confirms state recovery, and emits
an auditable run bundle.

This milestone proves the celld/Protein path only. The external model, executor,
evaluator, and board are deterministic test services.

## Milestone 2 — live OpenAI vertical slice

Status: implemented as the `npm run swarm:openai` path. A live invocation still
requires a caller-supplied `OPENAI_API_KEY`, Docker, celld, and provider access;
no checked-in credential or unrecorded live result is assumed.

The default pilot drives a 2 x 2 population for two generations. The gateway
uses raw stateless Responses requests with strict flat function tools,
`store: false`, encrypted reasoning replay, exact `call_id` continuation, one
function call per turn, and bounded turns/tools. The live gateway defaults to
one provider attempt so ambiguous transport failures are surfaced; operators
may explicitly raise that bounded limit while accepting possible duplicate
work or billing. The artifact executor runs public work in a locked-down
container. A separate evaluator alone imports hidden cases, and the board
accepts only matching evaluator receipts.

Each service persists an in-progress receiver receipt before work, coalesces or
replays an identical action ID and request hash, and rejects conflicting reuse.
That makes local delivery reconcilable; provider timeouts remain ambiguous and
may represent duplicate upstream work or billing.

Exit evidence: the live model/tool/evaluator path produces a redacted bundle
with receipts, usage, lineage, aggregate evaluation, and bounded operational
metrics. Passing this milestone establishes integration only. A single 2 x 2 x
2 run is neither repeated evidence nor an equal-budget comparison and cannot
show swarm advantage.

## Milestone 3 — isolated and sequential baselines

Status: infrastructure path available, experimental baseline not complete.

Provision a 4 x 4 population with no neighbor visibility. Add generation
deadlines, immutable snapshots, global budget receipts, settlement, and
timeouts before introducing cooperation.

Exit evidence: all cells receive equivalent independent observations, the
board settles despite missing cells, and repeated delivery produces no
duplicate logical candidates.

Add a sequential condition that can spend the same total accounted model,
tool, evaluation, and time budget. Freeze attempt accounting for ambiguous
provider failures before comparing it with parallel conditions.

## Milestone 4 — model decisions and local propagation

Status: deterministic propagation works in the mock path, and bounded live
model decisions and terminal behaviors work in the OpenAI vertical slice.
Repeated comparative evidence is not complete.

Enable the bounded decision behaviors and filtered neighborhood observations.
Keep the topology fixed and postpone multi-parent combination.

Exit evidence: a candidate can originate in one cell and be explicitly adopted
or challenged through adjacent generations without leaking to non-neighbors.

## Milestone 5 — evidence-first visualization

Status: the `/celld.html` report is a read-only projection of the latest
completed celld run bundle. It renders recovered cell state, service and model
usage, generation timing, run milestones, and the captured celld log tail. The
scripted scenario remains available separately at `/`.

The richer comparison and lineage inspector is not complete. Add those views
when repeated equal-budget runs produce evidence worth comparing.

Exit evidence: the same recorded run produces the same visible history, and
every displayed score or relationship links to its source record.

## Milestone 6 — comparative and recovery runs

Run the sequential, isolated, and local conditions under equal budgets. Add
the targeted executor-interruption exercise and publish positive or negative
results without selecting only favorable trials.

Exit evidence: a report contains the full configuration, every trial, resource
usage, winning artifacts, evaluator evidence, and known runtime limitations.

## Milestone 7 — second environment

Implement one small non-code environment, such as constraint scheduling or
dataset reconciliation, using the working demo as the source of candidate
abstractions.

Exit evidence: the second environment is useful and reveals which contracts
transfer unchanged, which need small generalization, and which were specific
to code optimization.

## Milestone 8 — consider extraction

Only after milestone 7, consider promoting code out of the example.

Likely candidates include:

- observation and decision envelopes;
- artifact and evidence references;
- budget grants and usage receipts;
- provenance and lineage records;
- replay projections;
- topology-independent neighbor summaries.

Keep these demo-specific unless evidence says otherwise:

- the grid and Moore neighborhood;
- synchronized generations;
- candidate survival and adoption policy;
- code workspaces, tests, benchmarks, and score rules;
- visual presentation.

Extraction is justified only when both environments use a primitive
substantially unchanged, its ownership boundary is clear, and moving it into
Protein does not turn the runtime into a workflow engine, model SDK, evaluator,
or fleet control plane.

## Stop conditions

Pause or narrow the project if:

- the first task cannot be scored independently;
- equal-budget comparison cannot be enforced or audited;
- the board becomes a hidden central reasoning agent;
- locality exists only in the visualization rather than the observations;
- coordination consistently costs more than it contributes;
- reliable execution requires unsafe external effects;
- a normal process plus a database is materially simpler for the demonstrated
  scale and behavior.
