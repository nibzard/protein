# Swarm Contracts

This document outlines the contracts required by the first demo. They are
application-level contracts built on Protein, not proposed additions to the
Protein runtime and not a general framework API.

## Current implementation boundary

Both celld paths implement stable event/action IDs, generation observations,
filtered local neighborhoods, content-addressed source artifacts, evidence
references, receiver conflict detection, and Protein state/action/journal
inspection.

For repeatable runtime testing, `celld-smoke-mock-services` combines the
deterministic policy, artifact executor, evaluator, and receipt board in
`capability-server.mjs`. It is intentionally weaker than the ownership
boundaries below.

The `celld-experiment` implementation exercises those boundaries with a raw
OpenAI Responses gateway, a containerized public-tool executor, a separate
hidden evaluator, and a deterministic board. Its default 2 x 2 population over
two generations is a live integration vertical slice. It does not yet provide
repeated sequential, isolated, and local runs under a frozen equal budget, so
the evidence-level name is not a claim of swarm advantage.

## Ownership boundaries

### Protein cell

Each named cell owns its compact private state and durable history. It may keep
its coordinate, current generation, current candidate reference, verified
score, remaining local grant, recent attempt references, and a short strategy
summary.

A cell does not own the global topology, authoritative score, experiment-wide
budget, repository workspace, hidden tests, or large artifacts.

### Board

The board is the source of truth for experiment configuration, coordinates,
neighborhoods, generation status, deadlines, eligible submissions, and global
budget grants. It creates a cell-specific observation from a frozen generation
snapshot. It must never expose candidates outside that cell's configured
neighborhood.

The board is deterministic infrastructure. It cannot ask a model what an agent
should do or silently route agents toward a preferred solution.

In the live slice, the board resolves the evaluator action receipt behind each
evidence ID before accepting a submission. Candidate ID and reference,
strategy, score, evidence ID, experiment, and generation must match. The board
then freezes accepted per-cell candidate/evidence/credit records into the next
authoritative generation snapshot.

### Model gateway

The model gateway reconciles turns by Protein action ID and owns the stateless
Responses transcript. It sends strict flat function tools with `store: false`,
replays encrypted reasoning and all other output items unchanged, and accepts
exactly one `function_call` per turn. A continuation must use the preceding
call's exact `call_id`. Application limits bound turns and non-terminal tools.

The gateway cannot execute generated code or see hidden evaluation. Its local
raw transcript is sensitive even though provider-side response storage is
disabled. The complete contract is in [MODEL-GATEWAY.md](./MODEL-GATEWAY.md).

### Artifact executor

The executor owns generated-source storage, visible candidate reads, public
test execution, sandbox resource limits, and content-addressed artifact
references. It receives a frozen candidate allowlist; request payloads cannot
select host paths or read candidates outside that list. Generated code runs in
a separate container with no network, read-only container files, dropped
capabilities, bounded CPU, memory, processes, time, and output.

Executor responses contain compact references and bounded measurements, not
workspaces, transcripts, unbounded source, or logs.

### Evaluator

Only the evaluator can issue a verified score. It owns hidden tests, benchmark
isolation, evaluator versioning, and durable evidence. Agent claims and public
test results may guide work but are not authoritative fitness. The evaluator
runs separately from the executor and model gateway. It returns aggregate pass
counts, gates, score, and benchmark measurements; hidden inputs, expected
values, and per-case details never enter tool output or agent observations.

## Shared vocabulary

| Term | Meaning |
|---|---|
| Experiment | One immutable task configuration and its complete set of comparison runs. |
| Condition | Single sequential agent, isolated population, or locally connected population. |
| Generation | A bounded decision/evaluation window over one frozen snapshot. |
| Observation | The task, local state, budget, and permitted neighbor summaries given to one cell. |
| Decision | One structured behavior selected by an agent for the current generation. |
| Candidate | A content-addressed artifact proposed as a task solution. |
| Evidence | Immutable evaluator or tool output supporting a claim about a candidate. |
| Settlement | The board's final record of eligible candidates, scores, usage, and timeouts for a generation. |
| Lineage | The parent candidates and action that produced a candidate. |

## Required record families

Exact schemas are deferred until implementation, but the following information
must be represented explicitly and versioned from the start.

### Experiment configuration

- stable experiment and condition IDs;
- task and evaluator version;
- population dimensions and neighborhood rule;
- number and duration of generations;
- model, prompt-policy, tool, and executor versions;
- total and per-cell budget grants;
- randomness seeds where the underlying systems support them;
- late-result and tie-breaking policies.

Once an experiment starts, this configuration is immutable.

### Generation snapshot and cell observation

A generation snapshot records every eligible candidate and verified result at
the boundary. Each cell observation derives from that frozen snapshot and
contains:

- experiment, condition, generation, and cell identity;
- the task and acceptance criteria reference;
- the cell's current candidate, score, lineage, and recent feedback;
- remaining budget;
- summaries of only its configured neighbors;
- the generation deadline and contract version.

A neighbor summary may expose candidate identity, verified score, lineage
family, and selected evidence references. It must not leak hidden tests, remote
cells, private memory, or unbudgeted model reasoning.

### Agent decision

The MVP supports one behavior per cell per generation:

- `explore`: construct an independent candidate;
- `improve`: modify the cell's or a neighbor's candidate;
- `challenge`: seek a counterexample or additional test evidence;
- `adopt`: make a neighbor's candidate the next local baseline;
- `wait`: spend no further budget in this generation.

Each decision records its target candidates, intended outcome, maximum grant,
and producing model-action ID. Combining multiple parents is deliberately
deferred until the basic lineage and budget semantics work.

### Candidate and lineage reference

A candidate record includes a content-derived identity, artifact location,
originating cell and generation, parent IDs, creation action ID, environment
version, and submission time. Candidate content is immutable. A later change
creates a new candidate with a new identity.

### Evaluation result and evidence

An evaluation records candidate identity, evaluator and test-suite versions,
correctness outcome, performance measurements, verified score, resource usage,
evidence reference, and completion time. Re-evaluation under a different
evaluator version creates a distinct result rather than rewriting history.

### Budget grant and usage receipt

Every model or executor operation consumes a named grant and returns measured
usage. The board settles authoritative experiment usage from receipts. Cells
may keep a local balance for decisions, but it is not the global source of
truth.

The live pilot records provider tokens, request attempts, model turns, tool
calls, sandbox work, evaluator calls, retries, ambiguity, and wall time as
separate measures. Its current per-cell limits bound cost but do not yet prove
equal budgets across comparison conditions.

### External action receipt

The model gateway, executor, evaluator, and board expose durable receiver
semantics for Protein actions:

- the receiver canonicalizes the request and binds its hash to the action ID;
- in-progress state is persisted before external work starts;
- the same action ID and request hash joins pending work or returns the stored
  completed result;
- the same action ID with different content is a conflict;
- a completed result contains compact IDs, measurements, and evidence
  references sufficient for reconciliation.

These receipts deduplicate logical work at the local receiver boundary. They do
not guarantee that an upstream model provider executed only once after a
timeout or connection failure.

### Generation settlement

Settlement records the frozen input snapshot, accepted and late submissions,
verified results, usage, exhausted or timed-out cells, and the snapshot used by
the next generation. It is append-only and safe to replay.

## Event and action lifecycle

The initial application protocol needs only a few durable event families:

- experiment assigned or stopped;
- generation opened with a cell-specific observation;
- model decision completed or failed;
- candidate materialized or failed;
- evaluation completed or failed;
- generation settled.

External action families cover model decisions, candidate materialization,
public tool runs, and authoritative evaluation. Every external request uses the
Protein action ID as its idempotency key or supports authoritative lookup by
that ID. The demo must not dispatch `unsafe` actions. The model loop alternates
one validated provider function call with one locally executed function output
until it selects a terminal behavior or reaches its configured turn/tool
limit.

A model-provider timeout after dispatch is ambiguous: the provider may have
completed and billed a response before the gateway lost contact. The gateway
records request IDs, attempts, usage it received, and ambiguity rather than
claiming exactly-once provider execution. Retried and ambiguous attempts remain
part of the run's cost evidence.

Late results remain recorded but are not silently inserted into a settled
generation. A later generation may adopt them only through an explicit board
policy and visible event.

## Identity and replay invariants

- Event IDs are stable and unique within a cell; different content under the
  same ID is a conflict.
- Candidate, evidence, and configuration identities are immutable.
- Every derived artifact identifies its parents and producing action.
- Only verified evaluator results affect the official score.
- Neighborhood observations are derived from frozen snapshots.
- Budget usage comes from durable receipts rather than model self-report.
- Responses continuation replays every prior output item unchanged and binds a
  tool output to the exact immediately preceding `call_id`.
- Public executor evidence and hidden evaluator evidence are different record
  families with different owners.
- Settlement and visualization data are append-only projections of recorded
  events, actions, artifacts, and evaluations.
- Large or sensitive data is referenced, not embedded in cell state.
- All contracts carry a version before compatibility is promised.

## Evidence and redaction boundary

Public projections and shareable reports may include stable IDs, versions and
hashes, bounded usage, latency, pass counts, scores, lineage, receipt status,
and references to separately controlled evidence. They must exclude
credentials and Authorization headers, raw provider transcripts and reasoning
items, generated source and raw function arguments, unbounded error bodies,
and every hidden case's input, expected output, name, or per-case failure
detail.

`store: false` prevents provider-side Responses storage; it is not a redaction
mechanism for the gateway's application-owned replay state. Raw gateway state
and full evaluator records are sensitive operational data, not public report
projections. A complete local audit directory can also contain candidate source
and must not be published wholesale without an explicit review.
