# Protein Architecture v1

> Status: architecture decision baseline
>
> Evidence cutoff: 2026-08-11
>
> Implementation status: experimental prototype

Protein is a celld-native durable coordination runtime for populations of
named, intermittently active agents. Each Agent Cell owns compact local truth
and durable intentions. Models, evaluators, sandboxes, and other expensive or
side-effectful compute remain replaceable external capabilities whose work is
identified, receipted, and independently verified where the task permits.

This document is the architectural authority for the current research phase.
It consolidates the implementation contract, failure proofs, and lessons from
the swarm, repository-maintenance, formal-methods, and compute-fabric
experiments. It is called v1 because the major boundaries are now earned by
working evidence. It is not a claim that the prototype is production-ready or
that unresolved mechanisms have already been implemented.

Supporting documents provide narrower implementation and evidence detail:

- [RUNTIME.md](./RUNTIME.md) describes the exact `src/` implementation.
- [PROOFS.md](./PROOFS.md) records the action-crash and ownership failures.
- [COMPATIBILITY.md](./COMPATIBILITY.md) records celld and Cloudflare Agents
  compatibility.
- [BENCHMARKS.md](./BENCHMARKS.md) records measured prototype performance.
- [FUTURE-FRAMEWORK.md](./FUTURE-FRAMEWORK.md) preserves historical extraction
  hypotheses; this document supersedes its old example count and maturity
  assessment.
- [QUESTIONS.md](./QUESTIONS.md) tracks unresolved production requirements.

## Status language

Architecture claims use four maturity levels:

| Label | Meaning |
| --- | --- |
| **Core** | Implemented in `src/` and covered by tests or the celld harness. |
| **Pattern** | Implemented and measured in one or more examples, but not a stable exported Protein API. |
| **Decision** | A rule future Protein work must preserve, even if enforcement is still incomplete. |
| **Open** | Proposed, unsafe, or unproven; it must not be presented as a current guarantee. |

## Contents

- [1. Architectural thesis](#1-architectural-thesis)
- [2. System context](#2-system-context)
- [3. Architectural decisions](#3-architectural-decisions)
- [4. Domain model](#4-domain-model)
- [5. Durable cell contract](#5-durable-cell-contract)
- [6. Event and action lifecycle](#6-event-and-action-lifecycle)
- [7. Durable capability architecture](#7-durable-capability-architecture)
- [8. Population interaction](#8-population-interaction)
- [9. Evidence, governance, and acceptance](#9-evidence-governance-and-acceptance)
- [10. Data placement and consistency](#10-data-placement-and-consistency)
- [11. Residency, recovery, and fault behavior](#11-residency-recovery-and-fault-behavior)
- [12. Security and trust boundaries](#12-security-and-trust-boundaries)
- [13. Observability and evidence integrity](#13-observability-and-evidence-integrity)
- [14. Guarantees and non-guarantees](#14-guarantees-and-non-guarantees)
- [15. Evidence behind the architecture](#15-evidence-behind-the-architecture)
- [16. Framework boundary and extraction policy](#16-framework-boundary-and-extraction-policy)
- [17. Deployment shape](#17-deployment-shape)
- [18. Next architecture proof](#18-next-architecture-proof)
- [19. Architecture change rule](#19-architecture-change-rule)

## 1. Architectural thesis

The basic unit is an identity-centered durable actor:

> A named cell receives durable events, reconciles them against private state,
> commits external action intent before dispatch, records the outcome, and
> becomes eligible for celld eviction when it has no useful work.

Five decisions follow.

1. **An agent is an identity, not a process or one task.** It is designed to
   outlive individual activations, processes, and tasks and can contain many
   runs. Its in-memory isolate may come and go.
2. **The cell is a durable control plane, not a compute container.** It owns
   local memory, coordination, policy, intentions, and compact receipts. It
   does not own a checkout, shell, browser, GPU, or large artifact.
3. **Compute scales with the work.** Cheap transitions stay in the cell;
   semantic reasoning, deterministic evaluation, and full Linux execution are
   requested only when needed.
4. **Coordination is artifact- and evidence-centered.** Agents exchange typed
   claims, references, reviews, conflicts, and results rather than copying
   entire prompts or simulating conversation for its own sake.
5. **Protein does not determine exactly-once effect semantics.** Under failure,
   an attempted operation may produce zero, one, or multiple remote effects.
   Stable identity, receiver idempotency, authoritative reconciliation, and
   receipts are the real effect boundary.

The long-term opportunity is not a larger cube. It is a durable substrate on
which many lightweight identities can coordinate real work while individual
jobs borrow anything from a small cell activation to an isolated Linux
sandbox. The cube is one visualization and test harness for that architecture,
not part of the framework.

## 2. System context

```text
                         embedding control plane
             auth · provisioning · index · quotas · admission
                                  │
                         known name + durable event
                                  │
                                  ▼
┌──────────────────────────────── celld fleet ────────────────────────────────┐
│                                                                            │
│  Agent Cell A              Agent Cell B               Agent Cell N          │
│  ┌──────────────────┐      ┌──────────────────┐       ┌──────────────────┐  │
│  │ compact state    │      │ compact state    │       │ compact state    │  │
│  │ events and runs  │      │ events and runs  │  ...  │ events and runs  │  │
│  │ action outbox    │      │ action outbox    │       │ action outbox    │  │
│  │ receipts/journal │      │ receipts/journal │       │ receipts/journal │  │
│  │ one alarm + WS   │      │ one alarm + WS   │       │ one alarm + WS   │  │
│  └────────┬─────────┘      └────────┬─────────┘       └────────┬─────────┘  │
└───────────┼─────────────────────────┼──────────────────────────┼────────────┘
            │ stable operation       │ explicit event/artifact  │
            │ identity               │ relationships             │
            ▼                        ▼                           ▼
┌──────────────────────── external capability plane ─────────────────────────┐
│ model gateway · bounded evaluator · Linux sandbox · domain API · human gate│
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ receipt + artifact/evidence references
                               ▼
                  artifact store · evaluator · provenance index
```

There is no transaction spanning two cells or spanning a cell and a
capability. Cross-cell work is asynchronous. A durable record on each side,
stable operation identity, and reconciliation are what allow the system to
converge after retries and restarts.

### Responsibility boundaries

| Layer | Owns | Does not own | Maturity |
| --- | --- | --- | --- |
| celld substrate | Named Durable Objects, private SQLite, routing, alarms, outbound fetch, hibernatable WebSockets, bucket recovery | Agent semantics, effect safety, model or tool policy | Dependency; alpha |
| Protein runtime | Per-cell state, runs, event inbox, action outbox, leases, revisions, retries, outcome events, journal, inspection | Prompts, tools, sandboxes, artifacts, topology, global scheduling | **Core** |
| Protein acceptance primitive | Pure monotonic promote-or-retain decision over lineage and evidence | Evaluator authentication, persistence, or domain gate policy | **Core** |
| Emerging Protein protocols | Capability, receipt, artifact, evidence, operation-key, and relationship contracts | Domain roles, task definitions, scoring, experiment phases | **Pattern/Decision** |
| Application or population | Domain state, event decisions, roles, routing, budgets, prompts, workload, evaluation policy | Runtime durability mechanics | Application-owned |
| Experiment harness | Topology, phases, fault schedule, frozen comparisons, evidence bundles, dashboards | Runtime semantics or production orchestration | Experiment-only |
| Capability plane | Model calls, commands, workspaces, tests, browsers, GPUs, external APIs, durable job lookup | Agent identity or lifecycle truth | External service |
| Fleet control plane | Authentication, provisioning, directory/index, global quotas, executor capacity, secrets, monitoring, upgrades | Per-cell semantic decisions | **Open**; embedding-owned |

This separation is deliberate. Protein is not a monolithic agent platform.

## 3. Architectural decisions

| ID | Decision | Why it survived the experiments |
| --- | --- | --- |
| A1 | One named cell represents one independently addressable memory and authority domain. | RepoAgent and every population experiment recovered stable per-cell identity and state. |
| A2 | A run is a goal inside an agent; an activation is transient execution. | Cells completed multiple tasks and later restored without treating a process as identity. |
| A3 | Protein persists state machines, not arbitrary JavaScript continuations. | Restart recovery reconstructed events and actions from SQLite records. |
| A4 | No SQLite transaction may span model, network, or tool I/O. | Revision-fenced claims allowed awaited work without holding storage locks. |
| A5 | External action intent is committed before dispatch. | Crash testing made the uncertainty window explicit and recoverable for safe receivers. |
| A6 | Automatic external effects require an idempotent or authoritatively reconcilable receiver. | All tested idempotent and reconcilable crash cases converged; unsafe cases failed at three checkpoints. |
| A7 | Models propose semantic work; deterministic policy and independent evaluators authorize and accept it. | Hidden tests and Z3 prevented model confidence from becoming authority. |
| A8 | Agent interaction uses typed work and artifact relationships, not raw conversational volume. | Candidate adoption compressed diversity without producing much collaborative improvement. |
| A9 | Artifact promotion is monotonic and evidence-gated. | Speculative peer review regressed a passing repair when promotion lacked this rule. |
| A10 | Grids, cubes, generations, roles, scores, and benchmark budgets remain application concepts. | They varied across environments while the durable runtime contract remained stable. |
| A11 | Fleet-wide concerns remain outside each cell. | Cell-private SQLite provides no global query, quota, or transaction mechanism. |
| A12 | Negative and discarded attempts remain evidence. | A retained ambiguous provider attempt changed a benchmark conclusion from passing to incomplete. |

## 4. Domain model

The following distinctions are normative.

### Agent

The durable identity plus its application-defined behavior. An agent can use
an LLM, deterministic code, or no model at all; the LLM is not the agent.

### Population

An application or control-plane organization of multiple Agent Cells. A
population is not a global Protein runtime object and has no implicit shared
state, scheduler, or transaction.

### Agent Cell

A named celld Durable Object hosting one `ProteinAgent`. It is the unit of
local state, event coordination, action identity, and application authority.
The authority is logical: the tested celld release does not guarantee one active
physical owner in every partition and clock-skew window.

### Activation

One ephemeral execution of the cell's code in memory. An activation can end
without ending the agent. Hibernation and process restart replace the isolate;
the next activation reconstructs from durable records.

### Run

One durable goal inside an Agent Cell. Its current statuses are `queued`,
`running`, `waiting`, `completed`, `failed`, and `cancelled`. The runtime stores
these values but does not yet enforce a legal run-transition graph or implement
cancellation semantics.

### Event

A durable, deduplicated inbox item identified within one cell by a stable ID.
Equivalent JSON is canonicalized, so object-key order does not change event
identity. Reusing an ID with different type, run, or payload is a conflict.

### Transition

An application decision produced from one claimed event. It may update compact
state, change a run, create action intents, and append application journal
data. `onAgentEvent()` is unrestricted async TypeScript today; purity is a
discipline, not an enforced property.

### Action intent and action record

An action intent is the durable declaration of external work. Its record owns
the local lifecycle, attempts, lease, dispatch marker, safety class, compact
result, and error. The action ID is stable across retries.

### Operation identity

The globally unique logical identity seen by a shared capability. The current
base runtime passes the cell-local action ID directly, so two cells can choose
the same ID and alias at one executor. Architecture v1 therefore requires an
external operation identity namespaced at least by deployment, Durable Object
class, cell identity, and local action ID:

```text
deployment / cell-class / cell-name-or-id / local-action-id
```

This requirement is a **Decision**, not yet enforced by `src/`. Applications
must namespace current action IDs or capability adapters must add the cell
scope until Protein exposes a first-class operation key.

### Receipts and outcomes

Protein uses three related but distinct records:

- a **runtime action outcome** is the cell-local status plus result or error
  that produces `protein.action.delivered`, `.failed`, or `.ambiguous`;
- a **capability receipt** is an executor-produced account that may include
  resource use, artifacts, provider identifiers, timing, and failed or denied
  work; and
- an **acceptance receipt** is a deterministic promote-or-retain decision over
  artifact lineage and named evidence gates.

Applications commonly place a compact capability receipt inside the runtime
action result and keep its large supporting data external.

### Artifact, evidence, and relationship

An artifact is useful work stored outside the cell and referenced by stable,
preferably content-addressed metadata. Evidence ties a named gate and authority
to one artifact. A relationship is a typed edge between work or artifacts,
such as `derived_from`, `reviews`, `duplicate`, `blocked_by`,
`conflicts_with`, `supersedes`, `accepts`, or `rejects`. These are currently
**Patterns**, not fully extracted runtime types.

### Capability

A bounded compute or effect provider. A capability can be cell-local policy, a
model gateway, a narrow evaluator, a Linux sandbox, a domain API, or an
approval broker. Cell-local work executes inside a bounded transition. For
external tiers, the cell requests work and the capability owns execution.

### Workflow and experiment run

A workflow is a finite durable pipeline and is distinct from an Agent Cell and
agent run. Whether a separate workflow engine should own a particular pipeline
remains **Open**. An experiment run is the whole harness invocation and evidence
bundle; it too is distinct from a cell or agent run.

## 5. Durable cell contract

### Cell-owned records

The current schema is private to each cell:

| Record | Purpose |
| --- | --- |
| `protein_state` | Current compact application state. |
| `protein_runs` | Goal, status, result, error, and timestamps. |
| `protein_events` | Inbox status, revision, attempts, availability, and lease. |
| `protein_actions` | Outbox intent, safety, dispatch marker, attempts, result-or-error, and ambiguity. |
| `protein_journal` | Sequenced operational lifecycle records. |
| `protein_meta` | Runtime schema version. |

State, payloads, and stored action results are canonical JSON. Repositories,
logs, prompts, transcripts, patches, proof certificates, browser traces, and
other large data belong outside the cell.

### Core invariants

The following combine implemented runtime invariants and normative architecture
decisions. Items 6 and 8 are **Decisions** not yet enforced by `src/`; items 11
and 12 are application obligations. The current `unsafe` action path remains
implemented for explicit ambiguity handling and fault research, but it is
outside the supported automatic-effect boundary described by item 8:

1. Persist event input before acknowledging admission.
2. Deduplicate by stable ID and conflict on different canonical content.
3. Never hold a SQLite transaction across awaited model, network, or tool I/O.
4. Fence every awaited event or action result with a monotonic revision.
5. Commit action intent in the event transaction before external dispatch.
6. Give the receiver a stable, globally namespaced operation identity.
7. Never claim exactly-once external execution.
8. Automatically dispatch only idempotent or authoritatively reconcilable
   effects.
9. Multiplex pending work and lease recovery onto the cell's one alarm.
10. Reconcile the alarm after every alarm activation while work remains.
11. Keep cell state and receipts compact; store large artifacts externally.
12. Treat live WebSocket frames as transient; important inbound data must
    become durable events.

### Atomic local boundaries

The runtime makes three important local SQLite commits:

- run creation and its `protein.run.requested` admission event;
- state, run transition, action intents, event completion, and journal entry;
- terminal action status and result-or-error, plus the corresponding internal
  outcome event.

These are local atomicity boundaries. They are not synchronous object-store
replication acknowledgements. The crash suite recovered a new node from bucket
state older than an already completed local commit.

## 6. Event and action lifecycle

```text
inbound request or callback
        │
        ▼
persist + deduplicate event ─────────────── duplicate → existing status
        │
        ▼ alarm
claim event revision N + lease
        │
        ▼ outside transaction
application decision
        │
        ▼ if revision N is still current
atomic state/run/action-intent commit
        │
        ▼ alarm
claim action revision M + lease
        │
        ├─ reconcilable: authoritative lookup
        │     ├─ found: use prior result
        │     └─ absent: mark dispatch started, then dispatch
        └─ idempotent/unsafe: mark dispatch started, then dispatch

after lookup or dispatch
        ├─ prior/returned result → delivered → terminal outcome event
        ├─ safe error, attempts remain → pending + backoff → alarm → reclaim
        ├─ safe error, ceiling reached → failed → terminal outcome event
        └─ unsafe dispatch uncertainty → ambiguous → terminal outcome event

terminal outcome event → next application transition
```

One current alarm activation processes at most one runnable action or, if no
action is runnable, one event. Actions currently take priority and equal-time
ordering is unspecified; strict FIFO and fairness are not runtime guarantees.
Every post-await commit above is conditional on the claimed revision still
being current.

The action-intent transaction and subsequent alarm reconciliation are separate
operations. Protein re-arms in the alarm handler's `finally` path, but the
complete hard-crash envelope around alarm persistence and repair remains
unproven.

### Revision fences and leases

A revision fence prevents an old awaited result from overwriting a newer local
claim. It does not cancel the remote request or prevent another physical owner
from making the same request.

A lease is a recovery deadline, not a lock, remote timeout, or cancellation
mechanism. If it is shorter than real provider latency, an expired claim can
produce an overlapping retry while the first call is still live. Lease values
must reflect provider latency, but safe receiver semantics remain necessary
regardless of lease length.

Within one active celld owner, a cell's JavaScript runs on one thread, but
handlers can interleave when they await. Applications must serialize mutually
dependent work in durable state; an awaited model or tool call is not a mutex.
Across different cells, work can run concurrently.

### Action safety

| Safety class | Receiver obligation | Protein behavior | Supported automatic use |
| --- | --- | --- | --- |
| `idempotent` | Repeated operation key creates at most one logical effect and rejects conflicting payload reuse. | Retry failures or expired leases up to the configured ceiling. | Yes. |
| `reconcilable` | Authoritative lookup reports a previously accepted or terminal operation without creating it. | Lookup before every dispatch; commit a prior result when found, otherwise dispatch; retry errors up to the configured ceiling. | Yes; preferred for expensive work. |
| `unsafe` | No deduplication or lookup guarantee. | May mark ambiguity when a surviving dispatch marker shows uncertainty. | No. Current hard recovery can lose that marker and redispatch. |

Model calls have the same effect ambiguity as any remote operation. Calling a
provider directly inside `onAgentEvent()` can repeat billing after retry.
Production applications should use a durable model gateway that retains the
operation key, provider response ID, usage, and lookup result.

## 7. Durable capability architecture

The compute-fabric experiment exercised four tiers. The common envelope is an
earned architectural **Pattern**, but it has not yet been extracted into a
stable `src/` interface.

| Tier | Appropriate work | Durable boundary |
| --- | --- | --- |
| `cell` | Deduplication, compact indexing, policy, bookkeeping, routing decisions | One local event transition and receipt. |
| `model` | Semantic classification, diagnosis, planning, patch proposal, conflict review | Reconciled model-gateway job with provider and token receipt. |
| `bounded` | Fixed parser, solver, test, policy, or evaluator with narrow inputs | Deterministic or tightly limited executor receipt. |
| `sandbox` | Checkout, reproduction, editing, tests, benchmarks, browser or OS tools | Isolated job with resource limits, logs, artifact hashes, and lookup. |

The measured live adapters used the OpenAI Responses API with `gpt-5.6-luna`.
Protein core remains neutral to provider, model, prompt format, and tool schema.

The tiers describe capability strength, not agent rank, and do not require a
strict step-by-step ladder. The application should use the cheapest adequate
tier and require a reason, expected evidence, and budget before escalation.

The first cube showed attributable receipts from all four tiers. Particular
fault paths separately exercised reconciliation after restart, duplicate
suppression, sandbox termination, and policy denial; it did not run every tier
through every fault. Its runner selected cells, phases, and tiers. The run did
**not** prove autonomous capability discovery, agent-selected escalation,
decentralized routing, or continuous operation.

### Observed capability pattern

The working examples share stable Protein action identity across retries,
dispatch plus lookup for reconcilable jobs, externally retained completed jobs,
compact outcomes, artifact references, and some resource accounting. The
implementations are not yet uniform: they do not all namespace keys globally,
detect conflicting payload reuse, authenticate callers, or declare a retention
window.

### V1 target capability contract

Before this pattern becomes a supported shared adapter, architecture v1
requires it to provide, regardless of transport:

1. a globally namespaced, stable operation key;
2. payload-conflict detection for operation-key reuse;
3. idempotent dispatch or an authoritative side-effect-free lookup;
4. retained terminal outcomes for an agreed reconciliation window;
5. bounded inputs, authenticated caller identity, and an explicit policy;
6. compact success, failure, denial, termination, and ambiguity receipts;
7. artifact references rather than unbounded results; and
8. resource accounting appropriate to the tier.

An illustrative request contains the requester, operation and capability IDs,
kind, input artifact references, expected evidence, budget, and policy. A
receipt contains the same identities, outcome status, artifact and parent
references, authority or provider metadata, resource use, and timestamps.
Exact field names and enforcement remain extraction work; the required
semantics above are a **Decision**, not a description of every current
executor.

Failure is data. Invalid generated source, a denied compute request, a killed
sandbox, a failed check, or an exhausted budget should return a durable outcome
when the capability remains reachable. Transport failure still uses Protein's
retry and reconciliation path.

A capability can report ambiguity about its own downstream attempt inside a
receipt. Separately, Protein records local `ambiguous` when an unsafe dispatch
cannot be resolved. An unreachable capability cannot return a receipt; the
cell must use its local lease, retry, and reconciliation state.

## 8. Population interaction

The demonstrated and target population model is an asynchronous work graph. It
is a **Pattern/Decision**, not an extracted Protein implementation:

```text
observation → claim → diagnosis → capability request → artifact
            → challenge/review → integration → acceptance receipt
```

Cells should exchange compact facts and stable references. Useful relationship
types include:

- ownership: `claims`, `hands_off`, `blocked_by`;
- identity: `duplicate`, `correlates_with`, `supersedes`;
- derivation: `derived_from`, `revises`, `combines`;
- scrutiny: `reviews`, `challenges`, `needs_evidence`;
- integration: `conflicts_with`, `resolves`;
- governance: `accepts`, `rejects`.

The cube runner authored and routed the current relationship records, while
cells stored them. As a target contract, every relationship should identify its
producer, endpoints, time, and supporting evidence where relevant. Current
records do not yet carry all of those fields.

A meaningful interaction does at least one of the following:

- routes or unblocks work;
- adds independently checkable evidence;
- prevents duplicate work or effects;
- exposes or resolves a conflict;
- recovers an interrupted operation; or
- contributes causally to an accepted artifact.

Raw messages, model turns, neighbor reads, or adoptions are activity metrics,
not success metrics. In the nine valid fixed-quality pairs, local exchange
descriptively reduced several tool-work measures while increasing median input
token cost and compressing diversity. The planned ten-pair confirmatory result
was incomplete.

Topology is application policy. A grid can impose local information flow, a
cube can visualize responsibility, and a registry can enable dynamic routing.
None belongs in Protein core. Current examples use deterministic boards and
runners. Self-routing cells, capability discovery, backpressure-aware handoff,
and cross-population coordination remain **Open**.

## 9. Evidence, governance, and acceptance

Models are valuable for semantic proposals. They are not authoritative merely
because they produced a confident answer. Protein's evidence architecture uses
four roles:

1. a producer creates or revises an artifact;
2. evaluators emit artifact-specific evidence for named gates;
3. policy decides which gates and authorities are required; and
4. an acceptance decision promotes the candidate or retains its verified
   parent.

`decideMonotonicAcceptance()` is a **Core** pure primitive reused by the
repository-maintenance and formal experiments. It accepts a child only when:

- the child's lineage names the verified parent;
- the child preserves every gate already passed by that parent; and
- the child passes every newly required gate.

Otherwise the parent remains current and the receipt records why. Reviews and
model judgments are advice; evaluator evidence and policy decide promotion.
The helper does not authenticate an evaluator or persist its own decision, so
applications must establish authority and commit the acceptance receipt.

Evidence should be auditable and, where feasible, independently replayable:
hidden-test results, source hashes, benchmark inputs, proof certificates,
solver versions, provider response IDs, and policy fingerprints. Identifiers
and hashes support audit but are not replay evidence by themselves. Hidden
chain-of-thought is not a coordination artifact; bounded decisions, citations,
tests, and outcomes are.

## 10. Data placement and consistency

This is the target ownership model. The provenance index, directory, global
queue, quota service, secret integration, and fleet control plane are currently
**Open**.

| Data | System of record | Reason |
| --- | --- | --- |
| Current agent memory and local policy state | Cell SQLite | Private, transactional, keyed by identity. |
| Runs, events, action lifecycle, compact receipts | Cell SQLite | Must recover with the agent's decisions. |
| Large artifacts, logs, transcripts, patches, certificates | External content-addressed store | Too large and operationally different from control state. |
| Capability jobs and authoritative lookup | Capability service | Must survive cell retries and reconcile independently. |
| Evidence and provenance projection | External index derived from receipts and artifacts | Cross-cell query and replay require a fleet view. |
| Agent directory, global work queue, quotas, capacity | Fleet control plane | No cell has global SQL or global transactional authority. |
| Credentials and secret values | External secret manager | Cells should store only scoped references. |

A SQLite transaction is atomic on one local replica. Hard recovery may restore
an older bucket replica, and simultaneous owners can create divergent local
histories. Cross-cell and cell-to-capability flows converge asynchronously.
There is no global snapshot, global event order, or cross-cell atomic update.
Projections must tolerate duplicates, late records, and replay.

## 11. Residency, recovery, and fault behavior

Protein agents are event-shaped rather than always running. HTTP, WebSocket,
or alarm activity starts an activation. When quiet, a cell becomes eligible
for host eviction. Protein does not command hibernation and makes no promise
that a fixed idle interval will force it.

The compute-fabric run demonstrated real restoration under a deliberate
four-resident-isolate cap. That evidence supports identity surviving
hibernation; it does not define a general eviction policy or steady-state cost.

### Expected fault outcomes

| Fault | Expected architectural outcome | Current status |
| --- | --- | --- |
| Equivalent event redelivery | One logical event; duplicate response. | **Core**, verified. |
| Conflicting reuse of an ID | Reject as conflict. | **Core**, verified. |
| Event handler interrupted before commit | Lease expiry and revision-fenced retry. | **Core**; full hard-interruption matrix remains incomplete. |
| Capability accepts work but response is lost | Lookup by operation key, then commit prior result. | **Core/Pattern**, verified for reconcilable receivers. |
| Equivalent duplicate capability request | One cached logical external job. Conflicting payload reuse must be rejected by the target adapter. | Receiver obligation; equivalent duplication verified, conflicting reuse untested by the cube adapter. |
| Scheduled sandbox container termination | Termination remains attributable even when followed by successful evaluation. | **Pattern**, observed as a termination count inside the eventual successful receipt. It did not interrupt the candidate evaluator; a separately durable failed-task receipt and executor-process recovery remain untested. |
| Capability policy denies work | Durable denial; application may alter or retry the request. | **Pattern**, verified. |
| celld process restarts with work outstanding | Reconstruct from rows and reconcile external work. | **Core**, repeatedly observed on one host. |
| Cell is evicted and later wakes | Restore state and continue from durable records. | **Pattern**, observed under forced resident pressure. |
| Two nodes become authoritative under partition/skew | External idempotency may contain effects, but local single-writer safety is not guaranteed. | **Open/known failure**. |
| Unsafe effect followed by hard recovery | Possible redispatch because the durable marker may be absent in recovered bucket state. | **Open/known failure**. |

Lifecycle tests should isolate mechanisms. Aggressive hibernation pressure and
outstanding-action crash recovery can interact and obscure which invariant
failed. Test each independently before combining them.

## 12. Security and trust boundaries

The current repository is not a secure multi-tenant agent platform.

- celld does not provide public ingress authentication or TLS policy for the
  application.
- A caller must be authorized for the specific agent name before routing.
- Cells must not contain host credentials, unrestricted shell access, or raw
  long-lived secrets.
- External capabilities require scoped authentication, input and output size
  limits, time and resource bounds, network policy, and audit redaction.
- Generated code runs outside cells in an isolated executor. The example Linux
  evaluators are networkless and resource-limited; that is an example policy,
  not runtime enforcement.
- Model output proposes actions. Deterministic policy, approval, and evaluation
  must stand between untrusted output and consequential effects.
- Hostile multitenancy is outside the tested celld alpha envelope.
- Automatic payments, destructive production changes, and other high-stakes
  non-reconcilable effects are unsupported.

Authentication, authorization, human approval, secret references, retention,
tenant quotas, and audit policy are required embedding concerns and still lack
first-class Protein primitives.

## 13. Observability and evidence integrity

The per-cell journal is the local operational record. It contains sequenced
event and action lifecycle entries with run, event, and action references. It
is not by itself a fleet-wide trace.

A serious population should project, outside the cells:

- an append-only timeline of milestones and faults;
- every capability and acceptance receipt;
- content-addressed artifact metadata;
- a typed provenance graph;
- provider identifiers and model usage;
- CPU, sandbox, evaluator, latency, and cost ledgers;
- cell-state and outstanding-work snapshots;
- categorized runtime logs and unexpected warning/error counts; and
- every attempt, including discarded, ambiguous, denied, and failed attempts.

Comparative experiments must freeze workloads, budgets, model settings,
evaluators, decision rules, and code fingerprints before live calls. A clean
retry never erases an invalid or ambiguous earlier attempt.

Report separate outcomes rather than one "swarm score": verified work,
quality, time to acceptance, input and output tokens, model turns, tool and
evaluator work, duplicate work, useful cross-agent contributions, conflicts,
recovery, and diversity.

Fleet indexing, tracing, compaction, export, and retention are not implemented
Protein services today.

## 14. Guarantees and non-guarantees

### What v1 can claim

- Named cells recovered compact identity-specific records across the tested
  hibernation and one-host restart scenarios. A fresh owner can still recover a
  bucket snapshot older than the latest completed local commit.
- Equivalent events and runs are idempotently admitted; conflicting ID reuse is
  rejected.
- Local event transitions atomically commit state, run changes, and action
  intent.
- Revision fences prevent stale awaited results from winning one cell's local
  history.
- Alarm-backed leases and retries reconstruct work rather than JavaScript
  continuations.
- Idempotent and authoritatively reconcilable capabilities can converge after
  the tested duplicate and crash scenarios.
- Compact durable cells coordinated external model, bounded, and Linux
  execution through action identities unique within each measured run and
  durable receipts. Shared adapters still require the operation namespace
  defined by v1.
- Versioned artifacts can be promoted monotonically through explicit evidence
  and acceptance receipts.
- Many identities can produce replayable work, provenance, conflicts, and
  recovery evidence on one host.

### What v1 cannot claim

- exactly-once external execution;
- reliable automatic execution of unsafe effects;
- synchronously replicated local commits;
- one active physical owner under every partition and clock-skew window;
- production multi-host safety or horizontal scalability;
- durable arbitrary async continuations;
- global ordering, transactions, discovery, scheduling, quotas, or fairness;
- enforced event-handler purity or enforced run-state transitions;
- a complete cancellation, steering, approval, migration, or retention model;
- authenticated WebSocket replay or reconnect cursors;
- autonomous capability discovery or decentralized self-routing;
- continuous operation of the current compute-fabric example;
- learning, emergent intelligence, or an advantage over one agent;
- a completed equal-budget sequential-agent versus population comparison;
- that a larger population is useful for every problem; or
- production security for hostile tenants or high-stakes effects.

## 15. Evidence behind the architecture

The architecture was not inferred from the cube alone.

| Evidence | Result | Architectural lesson |
| --- | --- | --- |
| [Clean-room celld baseline](./BENCHMARKS.md) | 1,000/1,000 named cells activated in 19.46 s on the recorded machine; one-host restart and action recovery passed. | A small cell-native runtime can exercise a high-cardinality identity model, but this is not steady-state capacity evidence. |
| [Action crash matrix](./PROOFS.md) | 10/13 cases passed; every idempotent and reconcilable case converged, three unsafe cases failed. | Receiver idempotency or authoritative reconciliation is mandatory. |
| [Two-node ownership test](./PROOFS.md) | Partition plus clock skew produced simultaneous owners and dual dispatch. | Local revision fences cannot replace substrate owner fencing. |
| [Exploratory cellular comparison](./examples/cellular-agent-swarm/docs/EXPERIMENT.md) | Three pairs produced one local win, one isolated win, and one tie; no repeatable neighbor-exchange advantage appeared. | Final quality and evaluator noise need replication and must remain separate from cost-to-target. |
| [Fixed-quality cellular comparison](./examples/cellular-agent-swarm/docs/COST-TO-TARGET-RESULT.md) | Of nine valid pairs, isolated won seven, local won none, and two were within the tie band; local used a median 26.5% more Responses tokens at first verified reach. One invalid pair made the confirmatory result incomplete. | Context exchange has a cost; propagation is not collaboration; retain every attempt. |
| [Repository-maintenance comparison](./examples/repo-maintenance-swarm/PEER-REVIEW-COMPARISON.md) | Peer review won 0, lost 1, tied 2; one speculative critique regressed a verified artifact. | Reviews are proposals; promotion must be monotonic and evidence-gated. |
| [Formal protocol pilot and conformance](./examples/formal-protocol-swarm/README.md) | Twelve live cells produced layered diagnoses, proof candidates, and reviews; Z3 independently checked and replayed 13 UNSAT obligations for the encoded finite-state model. Runtime projection preserved the unsafe boundary. | Models can propose; a deterministic authority proves and accepts. Formal models do not automatically prove implementation refinement. |
| [Formal 3×3×3 scale preflight—no 27-cell execution](./examples/formal-protocol-swarm/CUBE-PREFLIGHT-RESULT.md) | Z3 solved 9/9 in about 101 ms; the one-cell centralized and 12-cell layered conditions both solved 9/9, so the gate rejected a 27-cell run. | Do not add cells when the problem has no coordination pressure. |
| [Compute-fabric cube](./examples/compute-fabric-cube/RESULT.md) | 27 identities produced 39 receipts and 41 relationships across four compute tiers. The run reconciled five outstanding actions, restored a cell under resident pressure, suppressed equivalent duplicate dispatch, recorded a scheduled container termination followed by successful evaluation, retried one denial, and resolved one artifact conflict. | Durable cells can coordinate heterogeneous external compute with provenance on one host. The runner, not the cells, selected the schedule. |

These results justify an architecture for durable multi-agent execution. They
do not justify a general claim that more agents produce more intelligence.

## 16. Framework boundary and extraction policy

Protein currently has an implemented runtime kernel and one extracted
governance primitive. The experiments have also earned several reusable
contracts at the architecture level, but their package APIs remain unfinished.

| Candidate surface | Current status | Extraction decision |
| --- | --- | --- |
| `ProteinAgent`, event/action types, errors | Exported `src/` API | Keep minimal and model-neutral. |
| Monotonic artifact acceptance | Exported pure helper | Keep; require applications to authenticate evidence and persist receipts. |
| Globally namespaced operation identity | Missing enforcement | Add before treating a shared capability adapter as safe. |
| Durable capability dispatch/lookup/outcome | Repeated implementation pattern | Next high-confidence extraction; specify semantics before transport helpers. |
| Artifact, evidence, receipt, relationship types | Repeated experiment pattern | Extract the smallest content-addressed and attributable records used unchanged by another continuous-work vertical. |
| HTTP routing and outcome decoding helpers | Mechanical duplication | Optional helpers only; authentication and application transitions remain local. |
| Topology, roles, generations, board phases, scoring | Experiment-specific | Never move into core merely because several demos use them. |
| Fleet registry, scheduler, quotas, secrets, executor pools | External control plane | Integrate by contract; do not place inside every cell. |

A primitive moves inward only when:

1. at least two materially different environments need substantially the same
   semantics;
2. the primitive protects a real invariant or removes genuinely mechanical
   duplication;
3. it stays neutral to model provider, prompt format, topology, and domain;
4. its failure behavior and receiver obligations are explicit; and
5. existing recovery and evidence tests continue to pass through it.

Applications are allowed to remain substantial. Framework quality is not
measured by making every example thin.

## 17. Deployment shape

A production-oriented embedding would contain at least:

```text
authenticated ingress
       │
agent directory + admission + global budgets
       │
celld fleet running Protein applications
       ├── capability gateway and executor pools
       ├── model gateway
       ├── artifact/evidence store
       ├── secret manager
       └── logs, metrics, traces, and audit export
```

Protein itself supplies only the per-cell durable lifecycle. The embedding
owns deployment, network policy, TLS, auth, naming, provisioning, fleet index,
capacity, fairness, secrets, storage lifecycle, monitoring, and upgrades.

Until celld has verified owner fencing and recovery acknowledgement, the
current evidence envelope is a controlled single-host or otherwise
single-authority prototype using idempotent or reconciled external effects.
Authentication and other production requirements remain unresolved even in
that envelope. Protein must not be the primary controller for high-stakes
production effects on the tested release.

## 18. Next architecture proof

The next experiment should test the part this architecture has not yet earned:
a continuous, less centrally orchestrated population.

It should introduce:

- a durable work stream rather than a frozen phase script;
- capability registration and discovery;
- bounded executor pools with visible queue pressure;
- cell-authored requests that name expected evidence and budgets;
- typed claim, handoff, blocked, conflict, and acceptance records;
- routing based on durable local state and compact indexes;
- global admission and fairness outside the cells;
- specialization or reputation derived only from verified outcomes; and
- long-running recovery, cost, congestion, and useful-interaction metrics.

The experiment should compare orchestration policies under equal work and
resource ceilings. It should not presuppose that decentralization, reputation,
or a larger population is better. Multi-host execution remains out of the
high-stakes path until the known ownership failure is resolved.

## 19. Architecture change rule

Architecture v1 is final for the evidence available at its cutoff, not final
for all future Protein versions. A change to these boundaries must include:

1. the concrete new use case or failure that requires it;
2. the layer that owns the responsibility and why adjacent layers do not;
3. the durability, effect, security, and recovery semantics;
4. executable evidence or an explicit **Open** label;
5. updates to `RUNTIME.md`, `PROOFS.md`, compatibility evidence, and examples
   when their claims change; and
6. no promotion of experiment topology or benchmark mechanics into the core
   without reuse in another materially different environment.

The enduring principle is simple: **durable identities own decision history
and evidence references; elastic capabilities perform work; neither may
pretend the other is durable by implication.**
