# Framework Extraction Hypotheses

> Status: working hypotheses, not a framework roadmap. The candidate seams are
> derived from `src/`, RepoAgent, SwarmCell, and the current proof suites. Two
> examples can reveal duplication but cannot establish a reusable abstraction.
> Each proposal below must earn its place in a real vertical before it moves
> into the runtime or a public framework surface. Epistemic labels are used
> throughout: **[observed]** for measured facts, **[inference]** for reasoned
> conclusions, **[proposal]** for design suggestions, and **[speculation]** for
> imaginative futures.
>
> Historical note (2026-08-11): this document predates the repository-
> maintenance, formal-protocol, and compute-fabric environments. Its statements
> about only two examples and needing a third agent are retained as research
> history. [ARCHITECTURE.md](./ARCHITECTURE.md) now owns the current maturity and
> extraction decisions.

---

## The Current State: Two Layers, a Hypothesized Third

**[observed]** The codebase has two layers today:

```
Layer 3 (application):  RepoAgent (390 lines)      SwarmCell (1,704 lines)
                        ─────────────────────      ──────────────────────
                        parseRepoGoal,             BEHAVIOR_COST, lineage,
                        routeRequest,              liveLoopForObservation,
                        objectValue...             observationProvenance...

Layer 1 (runtime):      ProteinAgent (1,231 lines)
                        ──────────────────────────
                        event inbox, action outbox, alarm, schema,
                        revision fencing, WebSocket, journal
```

**[inference]** A thin Layer 2 may be useful if it absorbs stateless mechanics
that both agents genuinely share. This is a hypothesis, not yet a missing
framework layer. Six patterns currently look similar across the two examples:

| Duplicated Pattern | RepoAgent | SwarmCell | Lines wasted |
|---|---|---|---|
| Worker entry: `/:name/` regex → `idFromName` → `DO.get().fetch()` | yes | yes (renamed to `/cells/`) | ~15 each |
| `onRequest` try/catch + GET /state, /actions, /journal, /runs + POST /events | yes | yes (subset) | ~40 each |
| `executeAction`: `fetch(url, {headers: {"idempotency-key": key}})` + error handling | yes | yes | ~15 each |
| `reconcileAction`: `fetch(url/key)` → result or 404 → undefined | yes | yes | ~15 each |
| JSON utilities: `objectValue`, `stringValue`, `numberParam`, `errorResponse` | yes | yes | ~30 each |
| `onAgentEvent`: handle `protein.action.delivered/failed/ambiguous` → advance/fail run | yes | yes (partially) | ~20 each |

That is a rough upper bound of 130-140 similar lines in each current example.
Some are mechanical duplication; others only look alike while encoding
different application semantics. At two agents, this is enough to nominate
candidate seams, not enough to declare a framework.

---

## What the Runtime Contract Makes Possible

**[observed]** The abstract base class exposes three required application
members and four optional overrides:

```
abstract:
  initialState: State
  onAgentEvent(context): Promise<AgentTransition<State>>
  onRequest(request): Promise<Response>

optional override:
  executeAction(context): Promise<JsonValue>
  reconcileAction(context): Promise<JsonValue | undefined>
  onProteinCheckpoint(checkpoint, context): Promise<void>
  onMessage(webSocket, message): void
```

**[inference]** The `AgentTransition` return type is the strongest current seam.
It lets an event handler describe local state, run changes, and durable action
intent as data:

```typescript
{
  state?: State,            // what the agent now remembers
  run?: RunTransition,      // how the run's status changed
  actions?: ActionIntent[], // what external effects to commit
  journal?: JsonValue,      // what to audit-log
}
```

This encourages testable decision functions and keeps declared external action
intent inside the runtime transaction. It does **not** make `onAgentEvent()`
pure or replayable by construction. The method is unrestricted async
TypeScript: an application can still call `fetch`, read time or randomness,
mutate another system, or mutate its own fields. Purity is currently a coding
discipline. A future API would need a restricted decision function or explicit
effect context before Protein could claim to enforce it.

**[observed]** Every action currently declares `idempotent`, `reconcilable`, or
`unsafe`, and the runtime changes its recovery behavior accordingly:

- `idempotent`: dispatch with a globally namespaced operation key derived from
  the stable action identity, then retry on lease expiry.
- `reconcilable`: call `reconcileAction()` first; if a prior result exists,
  skip dispatch entirely.
- `unsafe`: mark `ambiguous` after an uncertain call only when the local
  dispatch marker survives recovery.

**[observed]** `PROOFS.md` records 10 passes and 3 failures across 13 action
crash scenarios. All idempotent checkpoints converged to one logical remote
job, and authoritative reconciliation avoided redispatch after acceptance.
Unsafe protection failed at the exact committed dispatch marker and at both
later remote checkpoints because a fresh celld process recovered bucket state
from before the marker. Separately, the two-node proof falsified celld's
single-owner invariant in the tested stale-owner, partition, and clock-skew
window: A and B both reached executor dispatch for one action.

The underlying durability and ownership failures are in celld, but the exposed
guarantee is Protein's responsibility. Protein therefore cannot describe
`unsafe` as dispatch-once, and a framework must not offer automatic unsafe
execution as a supported capability. Local revision fencing protects one
runtime history; it does not repair two simultaneously authoritative owners.

---

## Candidate Framework Seams

### 1. A durable capability protocol — defines the real effect boundary

**[observed]** Both examples happen to use HTTP, but URL construction is not the
important common behavior. The proof suites passed only where the receiver
honored a stable action identity or provided an authoritative lookup. That
semantic contract is the reusable seam.

**[proposal]** Layer 2 should define a transport-neutral durable capability:

```typescript
type CapabilityOutcome =
  | { status: "absent" }
  | { status: "running"; operationId?: string }
  | { status: "completed"; result: JsonValue }
  | { status: "failed"; error: string; retryable: boolean };

interface DurableCapability {
  readonly name: string;
  readonly safety: "idempotent" | "reconcilable";

  lookup(input: {
    key: string;
    action: ActionRecord;
  }): Promise<CapabilityOutcome>;

  dispatch(input: {
    key: string;
    action: ActionRecord;
  }): Promise<CapabilityOutcome>;
}
```

The contract is stronger than a pair of convenience fetches:

- `key` is the globally namespaced logical operation identity across retries
  and owner epochs;
- `lookup` is authoritative and does not create the effect;
- repeated `dispatch` with the same key cannot create a second logical effect
  for an idempotent capability;
- `completed` and terminal `failed` outcomes remain queryable for the agreed
  retention window;
- authentication, payload limits, result validation, and retention are part of
  the adapter's explicit contract;
- `unsafe` is intentionally absent. Such effects require manual handling or an
  external broker that adds idempotency, reconciliation, or fencing.

HTTP can be one adapter for this interface. A queue, model gateway, sandbox,
RPC service, or human-approval broker can implement the same semantics without
pretending that they share URL layouts.

### 2. A `ProteinAgentRouter` — may eliminate HTTP boilerplate

**[observed]** Both agents implement the same endpoints with slight variations.
A router mixin or base method could provide standard routes and let subclasses
add custom ones:

```typescript
// What the framework could provide:
protected standardRoutes(request: Request, url: URL): Response | null {
  // GET  /state      → { agent, state }
  // GET  /runs       → listRuns
  // GET  /runs/:id   → getRun
  // GET  /actions    → listActions
  // GET  /journal    → listJournal
  // POST /runs       → startRun (body → { id, goal })
  // POST /events     → acceptEvent (body → { id, type, payload })
  // null → let subclass handle
}

// What the framework could provide for the worker entry:
export function proteinRouter<T extends ProteinAgent>(
  namespace: DurableObjectNamespace<T>,
  prefix: string,  // "/agents" or "/cells"
): ExportedHandler {
  return {
    fetch(request) { /* regex match, idFromName, DO.get().fetch() */ }
  };
}
```

This could eliminate ~55 lines from each current agent. It should remain an
optional adapter: public routes, authentication, and resource naming are
application policy, not durable-agent semantics.

### 3. Shared decoding for action outcomes

**[observed]** Both agents decode `protein.action.delivered`,
`protein.action.failed`, and `protein.action.ambiguous`. They do not necessarily
assign those events the same application meaning. Delivery may finish a run,
advance a phase, update a hypothesis, or wait for approval.

```typescript
function decodeActionOutcome(
  event: AgentEvent,
): DecodedActionOutcome | undefined;
```

The shared part should stop at validated decoding. The application should own
the resulting state and run transition.

### 4. Shared JSON utilities

**[observed]** `objectValue`, `stringValue`, `numberParam`, `errorResponse`,
and similarly named state normalizers appear in both agent files. Pure generic
decoders may belong in `src/helpers.ts`. Agent-specific `normalizeState`
functions and HTTP error policy should remain local unless a third use proves
their semantics are actually shared.

### 5. The documented omissions

**[observed]** From `RUNTIME.md` and `QUESTIONS.md`, these items have been
explicitly deferred but a real framework needs them:

| Omission | Priority | What it requires | Framework impact |
|---|---|---|---|
| **Cancellation protocol** | P1 | A durable `protein.run.cancelled` event that advances the run revision and prevents later decisions from committing | New `RunStatus` value, `onAgentEvent` guard |
| **Human approval** | P1 | Action states `awaiting_approval`, `approved`, `rejected` between intent commit and dispatch | New `ActionStatus` values, new transition in `processProteinAction` |
| **Application state migration** | P1 | Ordered migration hooks beyond the single v1→v2 runtime migration | New abstract method, schema version per agent |
| **Retention/compaction** | P1 | Per-table limits, journal truncation, state size budgets | New alarm-driven cleanup pass |
| **Auth/secrets** | P0 | Identity verification, secret references (not values) in state | Middleware in `onRequest`, new `SecretRef` type |
| **Fleet provisioning/indexing** | P1 | Control-plane for cell discovery, global queries | External service, not in-cell |

---

## What Would Make This a Real Framework: A Third Agent

**[observed]** The project's own rule from `AGENTS.md`:

> Build the cellular agent swarm as a concrete, useful demonstration of many
> durable agents solving real problems through local cooperation, competition,
> tools, and verifiable outcomes. ... Favor simple abstractions shaped by
> working examples, and extract framework code only when it proves useful across
> more than one environment.

Right now there are two agents, and they share patterns. But both are examples —
neither is a production design partner.

**[proposal]** The framework question gets answered when a third agent appears
that:

- Uses the extracted Layer 2 (router, executor helper, standard outcomes)
  without modification.
- Has genuinely different external services (not HTTP executors only).
- Proves that the `AgentTransition` contract generalizes beyond "request work →
  get result."

**[proposal]** The `IDEA.md` strongest use cases suggest what that third agent
would be:

### Candidate: Per-customer SaaS agent fleet

One cell per customer account. Each cell receives webhooks from Stripe, GitHub,
and the customer's own systems; maintains subscription state, integration
tokens (as references, not values), and ongoing support runs. This exercises:

- Multiple inbound event sources (not just HTTP POST /events).
- Diverse external services (not just one executor URL).
- Long-lived multi-run identity (not one-shot tasks).
- WebSocket for live customer-facing state.

This would be a very different shape from both RepoAgent and SwarmCell, and it
would stress-test whether the framework primitives generalize.

### Candidate: Service/incident agent

One cell per service or incident. Reconciles alerts, deployments, operator
chat, diagnostic results, and remediation approvals. Keeps live WebSocket
clients during an incident and hibernates afterward. Exercises:

- Alarm-driven periodic reconciliation (polling external monitoring APIs).
- Human approval gates for remediation actions.
- Multi-run lifecycle: one incident is one run; the cell persists across
  incidents.

### Candidate: Persistent room / community agent

One cell per room or community. Stable identity, private state, real-time
connections, cheap inactivity. Exercises:

- WebSocket as the primary interface (not HTTP events).
- Model as an occasional participant, not the sole decision function.
- Long-lived identity with no "runs" in the traditional sense.

---

## The Design Tension: Framework vs Runtime

**[observed]** From `IDEA.md`:

> Protein should remain a small celld-native runtime and compatibility profile
> ... avoid absorbing provisioning, tenancy, global search, secrets, or
> workflow orchestration.

From `CLAUDE.md`:

> Do not add a feature merely because an agent product might need it. Add it
> only when it belongs to the per-cell lifecycle rather than an application
> harness, executor, workflow engine, or fleet control plane.

**[proposal]** The right answer is a two-part structure, not a monolithic
framework:

```
┌───────────────────────────────────────────────────┐
│  Application                                       │
│  (RepoAgent, SwarmCell, CustomerAgent)             │
├───────────────────────────────────────────────────┤
│  Layer 2: Capability protocol + optional helpers   │  ← prove in applications
│  (durable capabilities, router, decoders, utilities)│
├───────────────────────────────────────────────────┤
│  Layer 1: ProteinAgent runtime                     │  ← stays minimal, stays honest
│  (inboxes, outboxes, alarm, fencing,               │
│   safety, journal)                                 │
├───────────────────────────────────────────────────┤
│  celld (Durable Objects on S3-compatible bucket)   │
└───────────────────────────────────────────────────┘
```

Layer 1 is currently 1,231 lines. That number is evidence, not a size target or
a promise never to grow. A change belongs there only when a demonstrated
per-cell durability invariant requires it. Layer 2 should remain stateless;
applications need not be artificially thin.

**[inference]** The risk to watch for is Layer 2 accreting features that belong
in Layer 1 (making the runtime larger) or in applications (making the framework
opinionated about model choice, prompt format, or tool schemas). The current
project explicitly avoids prescribing a model SDK, prompt format, memory
algorithm, or tool schema. A framework should preserve that neutrality.

### Where the line is drawn

**[proposal]** Features belong in Layer 1 only if they involve durable state,
revision fencing, alarm multiplexing, or action safety. Everything else stays
in Layer 2 or the application:

| Concern | Layer | Why |
|---|---|---|
| Event deduplication and conflict detection | 1 | Transactional SQLite, revision fencing |
| Action commit-then-dispatch lifecycle | 1 | Transactional, lease recovery, safety classes |
| Alarm reconciliation | 1 | Multiplexes all work onto one celld alarm |
| Schema creation and migration | 1 | Transactional DDL |
| WebSocket accept/broadcast/close | 1 | Hibernatable connection lifecycle |
| HTTP routing (GET /state, POST /events, etc.) | 2 | Standard pattern, no durability concern |
| Durable capability contract and transport adapters | 2 | Enforces the external idempotency/reconciliation boundary without prescribing transport |
| Validated action-outcome decoder | 2 | Shared protocol decoding without application transitions |
| JSON validation utilities | 2 | Pure functions |
| Model call orchestration (prompt, tools, turns) | 3 | Application choice; runtime is model-agnostic |
| Budget and credit tracking | 3 | Application semantics |
| Fleet discovery and indexing | external | Cells share no database |

---

## The Ladder: Incremental Steps to a Framework

**[proposal]** These steps are ordered by decreasing certainty and increasing
speculation. Each step can be validated independently.

### Step 1: Specify and exercise durable capabilities (highest priority)

Define `DurableCapability`, its outcome states, retention requirements, and the
idempotent/reconcilable receiver obligations. Implement an HTTP adapter and
refactor RepoAgent and SwarmCell to use it without changing their behavior.
Keep direct automatic `unsafe` dispatch outside the public framework contract.

**Exit evidence:** both examples pass existing recovery suites through the
adapter; the action crash matrix still passes every idempotent and reconcilable
case; a deliberately nonconforming receiver fails contract tests.

### Step 2: Extract only proven-pure utilities (low risk)

Move generic JSON decoders that are behaviorally identical into a shared
module. Do not generalize state normalizers, authorization, or error policy
merely because the functions have similar names.

**Exit evidence:** both examples import the helpers and their tests pass
unchanged.

### Step 3: Extract the HTTP router and worker entry (moderate certainty)

Create `proteinRouter()` for the worker entry point and
`standardRoutes()` for the request handler. Refactor both agents to call them
and add only their custom routes. Keep the helper optional so applications can
own authentication and public API shape.

### Step 4: Extract an action-outcome decoder (moderate certainty)

Add a decoder for Protein's internal action-outcome event payload. Do not add a
default run transition; each application decides whether delivery completes,
advances, pauses, or merely annotates a run.

**Exit evidence:** both applications delete local payload parsing while
retaining their distinct transition logic.

### Step 5: Cancellation protocol (P1, moderate certainty)

Add `cancelled` to `RunStatus`. Handle `protein.run.cancelled` as a durable
event that advances the run revision. Pending actions for that run are
abandoned; committed actions that have already been dispatched cannot be
retracted. Add tests for the revision fence.

**Effort:** ~4 hours. **Risk:** moderate (touches the core lifecycle).

### Step 6: Human approval primitive (P1, moderate certainty)

Add `awaiting_approval`, `approved`, `rejected` to `ActionStatus`. In
`processProteinAction`, insert an approval gate between intent and dispatch:
actions with an approval requirement enter `awaiting_approval` and only proceed
to dispatch after an approval event. Add tests.

**Effort:** ~6 hours. **Risk:** moderate (new state machine transition).

### Step 7: Application state migration hooks (P1, lower certainty)

Add an abstract `migrateState(fromVersion, state): State` method and a per-agent
schema version stored alongside the runtime schema version. The runtime calls
it on activation when the version differs.

**Effort:** ~3 hours. **Risk:** moderate (migration correctness is subtle).

### Step 8: Retention and compaction (P1, lower certainty)

Add configurable per-table limits. The alarm-driven cleanup pass truncates old
journal entries, completed events, and terminal actions beyond the retention
window. State size is checked and warned on activation.

**Effort:** ~4 hours. **Risk:** moderate (must not delete recoverable work).

### Step 9: The third agent (high speculation)

Build one of the candidates above (per-customer SaaS, service/incident, or
persistent room) using only Layers 1 and 2. Observe where the framework breaks
or forces application-specific decisions back into shared code. Adjust.

**Effort:** days to weeks. **Risk:** high (this is the real test).

---

## Comparison to Existing Systems

**[observed]** The demand filter in `IDEA.md` explicitly compares Protein to
existing infrastructure:

> Cron, Postgres, serverless schedulers, Restate, Temporal, Rivet, and
> source-native automation already cover large parts of that space.

**[inference]** Protein's differentiator is not any single capability. It is
the specific combination of:

1. **Named ownership** — one stable address per identity, not a queue or table
   row.
2. **Private transactional state** — compact JSON in SQLite beside the code,
   not a shared database.
3. **Event-shaped residency** — wakes on HTTP/RPC/WebSocket/alarm, hibernates
   between. Not an always-running process.
4. **Self-hosted placement** — S3-compatible bucket, not a managed account.
5. **Durable inbox/outbox with safety classes** — commit-then-dispatch with
   revision fencing. Temporal has durable workflows; Protein has durable agent
   identity.

| System | Identity | Private state | Event-driven | Self-hosted | Durable effects |
|---|---|---|---|---|---|
| Postgres + cron | table row | schema/table | no | yes | transactional |
| Temporal | workflow ID | workflow state | yes | yes | retryable |
| Restate | service/key | keyed state | yes | yes | journal-based |
| Cloudflare DO + Agents | object name | SQLite | yes | no (managed) | queue (unsafe on celld) |
| Protein | cell name | SQLite | yes | yes | commit-then-dispatch + safety |

**[inference]** None of these competitors combines all five properties. The
closest is Temporal, which has durable workflows but no concept of a persistent
identity that owns multiple runs and hibernates between them. Restate has keyed
state and journaling but is oriented toward RPC services rather than agent
identity.

**[speculation]** Protein's niche, if it has one, is the fleet scenario: many
long-lived identities, mostly inactive, each owning small private state, each
reachable by multiple event sources, requiring ordering and deduplication within
the identity. That combination is awkward to build on Temporal (which models
workflows, not persistent agents) and expensive on managed DOs (which charge per
object-hour regardless of activity).

---

## What Could Go Wrong

**[inference]** Three failure modes for the framework direction:

**1. Layer 2 accretes into a second runtime.** The helpers grow their own
state machines, their own lifecycle hooks, their own opinions about model
integration. The clean boundary blurs. Prevention: Layer 2 must be stateless
helpers and default handlers only. If something needs durable state or
fencing, it goes in Layer 1 or stays in the application.

**2. The third agent does not generalize.** The per-customer SaaS agent turns
out to need fundamentally different primitives (e.g., multi-tenant event
routing, per-customer secret isolation) that the current contract does not
support. Prevention: document the gap honestly and decide whether to extend
Layer 1 or keep it in the application.

**3. celld does not improve.** The ownership-skew failure (issue #132) and the
unsafe-effect crash gap remain unresolved upstream. The framework is
architecturally sound but cannot be deployed for high-stakes effects.
Prevention: keep the safety boundary documentation accurate, contribute
upstream, and accept the idempotent/reconcilable-only limitation until celld
provides fencing primitives.

---

## Summary

**[observed]** Protein has meaningful executable evidence, not a complete
framework proof: 13 deterministic action-crash scenarios, a two-node ownership
test, celld integration coverage, and two substantially different examples.
The evidence proves idempotent and reconcilable recovery in the tested cases.
It also falsifies unsafe dispatch protection and single-owner exclusivity in
the tested failure windows.

**[inference]** The first reusable abstraction worth testing is the durable
capability protocol because it encodes what made the safety cases pass. Router,
decoder, and JSON helpers are smaller extraction candidates. Their duplicated
line count is maintenance evidence, not product evidence.

**[proposal]** Treat the document as a sequence of hypotheses:

1. Stable action identity plus authoritative lookup/dispatch semantics can be
   expressed as a transport-neutral capability contract.
2. RepoAgent and SwarmCell can adopt that contract without losing their
   application-specific behavior.
3. Stateless helpers can reduce proven duplication without becoming a second
   runtime.
4. Further lifecycle features and a third application should be added only
   when a real vertical supplies concrete requirements.

The discipline that matters most is preserving honest boundaries: celld owns
placement and replication, Protein owns per-cell durable intent, capabilities
own external-effect convergence, and applications own agent meaning. None of
those boundaries should claim a guarantee that the proof suites have
falsified.
