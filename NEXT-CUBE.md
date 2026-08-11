# Next cube: a durable agentic compute fabric

> Status: implemented and first live run passed. See
> [examples/compute-fabric-cube/RESULT.md](./examples/compute-fabric-cube/RESULT.md).
> This file preserves the build hypothesis. The completed first run processed a
> finite frozen workload under a deterministic runner that selected destination
> cells, phases, and compute tiers. It validates durable heterogeneous-capability
> plumbing, not continuous operation, autonomous escalation, or decentralized
> routing. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the current boundary.

## Objective

Build a `3×3×3` Protein population that handles a bounded stream of real
repository-operations work. The demo should show coordination across many
durable agent identities, cheap cell-local work, and selected tasks using LLM
reasoning or isolated Linux execution.

This is primarily a systems experiment. It asks whether celld can act as the
durable coordination substrate beneath heterogeneous agent compute. It is not
conditioned on the swarm outperforming one large agent.

## Demonstration workload

Use a small multi-package repository with a frozen stream of 12 realistic work
items:

- failing tests and an incomplete bug report;
- a dependency update with an API incompatibility;
- a performance regression;
- a configuration error;
- duplicate reports describing one root cause;
- two individually valid patches that conflict when integrated;
- a security-relevant input-validation defect;
- documentation or migration work coupled to a code change.

Every item must end in an externally checkable outcome: a deduplicated incident,
a reproduced failure, a patch, a rejected hypothesis, a test result, or an
integration receipt. Public checks help agents work; hidden checks make final
acceptance authoritative.

The fixture should deliberately contain dependencies between items. For
example, the dependency update and configuration fix may touch the same file,
while the performance repair must preserve behavior introduced by another
patch. This creates real coordination pressure without scripting agent dialogue.

## Cube organization

The third dimension represents responsibility, while the `x/y` plane provides
local neighborhoods.

| Layer | Durable responsibility | Typical compute |
| --- | --- | --- |
| `z=0` Observe and triage | ingest reports, deduplicate, correlate, prioritize, route | cell-local rules; occasional Luna call |
| `z=1` Investigate and execute | reproduce, research, propose changes, create candidate artifacts | Luna tool loop; bounded or full Linux sandbox |
| `z=2` Verify and govern | test, challenge, detect conflicts, accept or reject, control budgets | deterministic checks; sandbox; occasional Luna review |

There are nine columns and 27 durable cells. Columns should begin with domains
such as runtime, API, data, dependencies, performance, security, tests, docs,
and integration, but roles are not prisons: a cell can route work or request
help when evidence crosses a boundary.

No central LLM plans the entire run. In the completed first implementation, a
deterministic runner publishes work and selects the destination, phase, and
tier. Cells make bounded durable transitions for those assignments. Moving
selection and routing into the population remains a future experiment.

## Compute escalation

Treat compute as durable capabilities rather than code embedded in the cell:

1. **Cell only** — SQLite state transitions, indexes, deterministic policy,
   deduplication, claims, waiting, and messaging.
2. **Model call** — one bounded OpenAI Responses tool loop for semantic triage,
   diagnosis, planning, review, or routing.
3. **Bounded executor** — a narrow command or evaluator with fixed inputs and
   limits.
4. **Linux sandbox** — an isolated checkout for reproduction, editing, tests,
   benchmarks, and artifact creation.

Each request carries one stable, globally namespaced operation identity derived
from deployment, cell class, cell identity, and local action ID. A capability
must support idempotent dispatch or authoritative reconciliation. It returns a durable
receipt containing executor tier, timing, resource use, logs, artifact hashes,
and outcome. Cells store compact references rather than sandbox contents.

In the target architecture, escalation should be agent-selected but
policy-bounded. The request explains
why the stronger tier is needed, what evidence is expected, and its budget.
Verification cells can deny, reduce, or terminate requests that lack useful
evidence.

## Interaction protocol

Use an asynchronous work graph rather than synchronized Game-of-Life turns:

```text
observation -> claim -> diagnosis -> capability request -> artifact
            -> challenge/review -> integration -> acceptance receipt
```

Agents may also emit `duplicate`, `blocked_by`, `supersedes`, `conflicts_with`,
`needs_evidence`, and `budget_denied` relationships. These typed artifacts make
the population inspectable without storing hidden reasoning.

Local discovery remains a target mechanism: a cell initially sees its own
inbox and a compact neighborhood index. Cross-cube routing through explicit
artifacts is proposed so distant collaboration can be observable and budgeted;
the first runner did not implement decentralized discovery.

## Required runtime events

The live run should include real, controlled adversity:

- restart celld while actions are outstanding;
- terminate one Linux executor after it accepts a job;
- redeliver at least one event and capability request;
- temporarily deny one compute tier;
- submit conflicting candidate patches for integration;
- allow idle cells to hibernate and later wake from a new event.

These are scheduled fault injections, not hidden chaos. Their times and expected
invariants are frozen before the run.

## Measurements

The dashboard and evidence bundle should report:

- distinct durable cells, wakes, sleeps, events, and cell-to-cell artifacts;
- work claims, handoffs, challenges, conflicts, and resolutions;
- compute requests by tier, approval rate, queue time, runtime, tokens, CPU time,
  and cost;
- accepted outcomes and rejected hypotheses per compute unit;
- duplicate reports merged and duplicate external effects prevented;
- outstanding work and accepted artifacts recovered after restart;
- sandbox failures reconciled without losing or double-applying work;
- artifact provenance depth and which accepted results used multiple agents;
- time from observation to verified acceptance;
- active versus hibernating population over time.

Do not use raw event count as success. Interactions are valuable only when they
route work, add evidence, prevent duplication, expose a conflict, recover an
operation, or contribute to an accepted outcome.

## Success criteria for the first run

The first cube is successful when:

- all 27 cells establish distinct durable identities and at least one later
  wakes after hibernation;
- all four compute tiers are exercised by nontrivial work assigned under the
  frozen tier policy;
- every accepted repository change passes public and hidden evaluation;
- every external execution has a durable, attributable receipt;
- the celld restart loses no accepted work or committed relationship;
- duplicate delivery creates no duplicate logical sandbox or model operation;
- at least one real patch conflict is detected and resolved before acceptance;
- the final evidence bundle can replay the path from incoming report to accepted
  patch, including escalations and failed branches;
- resource and model usage are reported per outcome and per tier.

No requirement says the cube must beat a centralized agent. A small direct
baseline is still useful for cost and task-quality context, but runtime behavior
is evaluated on its own terms.

## Historical implementation sequence

1. **Freeze the workload and invariants.** Create the repository fixture, 12
   event packets, hidden evaluator, dependency graph, fault schedule, and success
   criteria before the live run.
2. **Define the capability envelope.** Standardize dispatch, lookup, receipt,
   resource accounting, artifact references, and the four compute tiers. Reuse
   existing Protein action identity and reconciliation; cancellation remains a
   future runtime protocol.
3. **Build the asynchronous work graph.** Add typed claims, relationships,
   neighborhood indexes, cross-cube routing, deadlines, and per-tier budgets.
4. **Implement the three cell roles.** Keep role policy in the experiment;
   extract framework primitives only where RepoAgent and existing swarm code
   already demonstrate the same contract.
5. **Add executors.** Connect the Responses API gateway, bounded evaluator, and
   isolated Linux sandbox behind the common durable capability protocol.
6. **Instrument replay and metrics.** Generate one append-only timeline, receipt
   index, provenance graph, resource ledger, cell-state snapshot, and compact
   dashboard summary.
7. **Run deterministic rehearsal.** Use scripted capability decisions to prove
   routing, fault recovery, accounting, and evaluation without spending model
   tokens.
8. **Run the live Luna cube.** Freeze model settings and budgets, execute the
   fault schedule, collect the evidence bundle, and record both successes and
   failed hypotheses.
9. **Evaluate framework extraction.** Only after the run, identify capability,
   routing, receipt, or escalation code shared by at least two environments.

## Scope guardrails

- The first cube runs on one celld fleet and one host; it demonstrates logical
  elasticity, not production horizontal scale.
- Linux execution is isolated, time-limited, resource-limited, and has an
  explicit network policy.
- Cells never receive host credentials or unrestricted shell access.
- Model output proposes actions; deterministic policy and evaluators authorize
  effects and acceptance.
- The dashboard must distinguish observed runtime evidence from architectural
  claims and future scale hypotheses.

## Historical first build milestone

The first implementation milestone was not the visual cube. It was the
triage-to-sandbox-to-verification path described as a three-cell vertical
slice. The completed 27-cell implementation contains that path for each
implementation report; no separate three-cell evidence run was retained.
