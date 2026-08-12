# Protein and AWC

Status: architecture note and validation proposal, 2026-08-12.

Companion document: [Protein integration requirements in AWC](https://github.com/nibzard/awc/blob/main/docs/explanation/protein-integration.md).

## Decision

Protein and AWC are a strong composition, not one product.

Protein makes agent identity, intent, coordination, evidence, and acceptance
durable. AWC makes the Linux working sets behind selected agent actions cheap to
fork, mount, checkpoint, and recover.

This extends the Protein story from many durable lightweight agents to a mixed
compute fabric. Most agents can remain cells. Some actions can escalate into a
Linux sandbox with a private, durable workspace. The workspace service remains
outside Protein's core.

AWC does not make a population more intelligent. It may make large coding-agent
populations more affordable and recoverable. Those are separate claims and
need separate measurements.

## Why the fit is real

Both systems assume that logical population is larger than active compute.
Protein can keep many identities and pending actions durable while only a few
actions use Linux. AWC can keep many logical workspaces while only a few are
mounted.

AWC's immutable checkpoints also fit Protein's artifact model. A checkpoint is
a candidate result with content identity, lineage, and a structural diff.
Protein can attach independent evaluation and decide whether to accept it.

The useful combined lifecycle is:

```text
Protein cell action
    -> durable Linux-job broker
    -> AWC fork from an accepted snapshot
    -> scheduler places a sandbox on a suitable host
    -> AWC mounts one private writable workspace
    -> agent uses tools inside the sandbox
    -> AWC checkpoints an immutable candidate
    -> evaluator mounts the candidate read-only
    -> Protein records evidence and accepts or rejects it
    -> broker unmounts and reclaims the temporary workspace
```

## Responsibility boundary

| Layer | Owns | Does not own |
| --- | --- | --- |
| Protein | Durable agent state, action intent, budgets, routing, receipts, relationships, evaluation, and acceptance | Mounts, processes, cgroups, caches, or workspace storage |
| Linux-job broker | Globally idempotent job lifecycle, reconciliation, and composition of placement, sandbox, and workspace | Agent reasoning or artifact acceptance |
| Fleet scheduler | Admission, fairness, host capacity, placement, and cache-locality policy | Workspace truth or agent state |
| Sandbox or executor | Processes, command policy, cgroups, resource limits, secrets, and network isolation | Workspace history or Protein acceptance |
| AWC | Immutable snapshots, metadata-only forks, private mounts, host caches, checkpoints, diffs, and workspace fencing | Agent orchestration, model calls, semantic memory, evaluation, or shared writable collaboration |

These boundaries matter. Protein should not become a distributed filesystem.
AWC should not become an agent orchestrator or sandbox platform.

## Workspace model

Do not allocate one permanent AWC workspace for every Protein cell. Create one
lazily for a Linux action or a longer job. Pin accepted snapshots when they must
outlive the temporary workspace. Reclaim rejected and abandoned branches.

Each active writer needs its own workspace fork. Agents cooperate through
immutable artifacts, diffs, review, and explicit integration. They do not share
one writable POSIX directory.

A checkpoint is durable workspace data, not proof of correctness. Protein's
evaluator and acceptance record remain authoritative. An accepted artifact
should identify the exact checkpoint digest it evaluated.

## Identity and reconciliation

Every cross-system operation needs one stable key:

```text
<deployment>/<cell-class>/<cell-id>/<local-action-id>
```

The broker should use this key for job creation and AWC mutations. Repeating an
operation with the same key and payload must return the same result. Reusing the
key with another payload must produce a conflict.

Protein should store a compact receipt containing:

- the global operation key and broker job ID;
- the AWC workspace ID and base snapshot digest;
- the parent and candidate checkpoint IDs and digests;
- the evaluator evidence and final acceptance decision;
- terminal outcome, durability state, timings, resource use, and cache metrics.

Mount tickets, object-store credentials, and other capabilities must never enter
cell state or model context.

AWC fencing protects publication of a canonical workspace head. It does not fix
dual ownership inside celld. It also does not make arbitrary external effects
exactly once. Protein and the broker still need global operation identity,
authoritative terminal lookup, and replay-safe receipts.

## What this adds to the Protein story

The architecture can demonstrate heterogeneous agent compute without treating
every agent as a container:

- a cell can perform cheap coordination and state transitions;
- a model call can provide bounded reasoning;
- a tool action can use a narrow remote service;
- a selected action can escalate into a full Linux sandbox;
- the result can return as an immutable, evaluated artifact.

This is a more important result than a larger cube alone. It tests whether many
durable agents can share expensive infrastructure while retaining identity,
recovery, evidence, and bounded autonomy.

AWC can improve the economics of the Linux tier through shared bases, lazy
reads, private deltas, and host caches. It is relevant only when the workload
has high fan-out, substantial read overlap, small private deltas, and sparse
activity.

## What this does not prove

The composition does not by itself prove:

- that a population outperforms one agent under an equal budget;
- that AWC outperforms a native overlay on one host;
- that every real-world agent task benefits from a workspace;
- that checkpoint durability implies semantic correctness;
- that workspace fencing solves celld ownership or external exactly-once work.

Existing AWC measurements are especially important here. On one host, AWC lost
to plain OverlayFS on local storage, cold start, and several agent-experience
measures. The remaining economic thesis is cross-host reuse through a shared
object store and cache. That thesis still needs a real multi-host test.

## Validation plan

First prove the lifecycle, then its economics, then its effect on agent work.

### 1. Contract and failure proof

Run one real Protein action through the broker, sandbox, and AWC. It must create
one fork, one writer, one checkpoint, one evaluator result, and one reconciled
Protein receipt. Remount the acknowledged checkpoint on a fresh host.

Repeat after losing responses and killing each component at lifecycle
boundaries. Equivalent retries must converge. Conflicting retries must fail.
Stale writers must never replace a newer head.

### 2. Sparse population proof

Create thousands of logical agent jobs from a shared base. Keep only a bounded
minority mounted and running. Measure logical workspaces, active mounts,
sandboxes, memory, file descriptors, and cleanup lag.

### 3. Cross-host economics

Use at least two worker hosts and one real shared object store. Compare AWC with
a fair OverlayFS or lazy-image baseline. Measure remote bytes, physical bytes,
fork time, mount time, first useful command, copy-up cost, checkpoint time, and
cache suppression.

### 4. Attribution experiment

Use the same task corpus, model, tools, budgets, concurrency, and evaluator in a
two-by-two study:

| Agent topology | Ordinary workspace baseline | AWC workspace |
| --- | --- | --- |
| One agent | A | B |
| Protein population | C | D |

`A` versus `B` isolates workspace infrastructure. `A` versus `C` isolates the
population design. `C` versus `D` shows whether AWC changes population
economics. Only verified accepted work counts as output.

Useful metrics include accepted work per dollar, accepted work per minute,
duplicate effort, recovery time, remote bytes, unique stored bytes, active
compute, queue delay, and evaluator score.

## Historical implementation audit

The initial review inspected AWC commit `074bace` from 2026-08-11. Its unit test
suite passed, and its FUSE and S3 features compiled. The review also found gaps
in the live checkpoint lifecycle, lease-to-session binding, idempotent publish,
unmount handling, recovery, cleanup, and several metrics.

AWC advanced after that audit. By commit `610222e`, it had corrected several
important paths. These included lease-to-session binding, mount activation and
release, lower snapshot selection, and read-path fetch coordination. The old
findings must therefore not be quoted as current defects.

Current readiness depends on the companion AWC contract and its tests. At this
date, lost-response-safe checkpoint publication, unmount disposition,
retention for accepted snapshots, actionable cache-locality data, and the full
multi-host failure matrix remain unproven integration requirements.

## Architecture rule

Keep the integration replaceable. Protein should depend on a durable Linux-job
capability and immutable artifact receipts, not on AWC internals. AWC should
remain one workspace adapter behind that capability.

If another workspace system later satisfies the same contract, Protein should
be able to use it without changing cells, prompts, evaluation, or acceptance.
