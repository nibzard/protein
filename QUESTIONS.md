# Open questions and blockers

Protein is an executable prototype. The items below separate demonstrated
behavior from the claims that remain unsafe to make.

## P0 — correctness and production blockers

### 1. Can celld `0.1.0` maintain one active owner in the tested skew window?

Celld documents one writer per cell, but open issue
[`denoland/celld#132`](https://github.com/denoland/celld/issues/132) reports an
overlap between old and new owner authority under clock skew. Protein's local
revision fences do not fix two concurrently authoritative nodes writing or
calling tools.

**Answered for the tested topology: no.** The two-node harness isolated A from
peers and the object store, shifted B's wall clock forward by 9 seconds against
a 12-second TTL, and observed both nodes serve the same cell. Both reached
`action.dispatch_started`; an external idempotency key contained the two calls
to one job. State converged after healing. See [PROOFS.md](./PROOFS.md).

Required resolution evidence:

- upstream resolution or a verified operational bound;
- the same executable harness passing against the candidate release;
- a documented safe skew/fencing model and operational bound.

Until then, do not use Protein as the primary control for high-stakes effects.

### 2. What is the precise crash envelope around external actions?

**Answered for the implemented lifecycle.** The deterministic matrix now kills
celld at intent, claim, request arrival, remote acceptance, returned response,
and receipt/outcome boundaries. Idempotent and reconcilable effects converged.
Unsafe protection failed at the exact committed dispatch marker and both tested
post-dispatch points because bucket recovery lost the local marker. Even the
checkpoint after the receipt/outcome transaction produced idempotent
redelivery. See
[PROOFS.md](./PROOFS.md).

The remaining blocker is architectural rather than missing fault injection:

- require idempotent or authoritative reconciliation contracts;
- reject automatic unsafe effects, or add an external effect broker;
- obtain celld replication acknowledgement and ownership fencing primitives.

#### Cross-cell operation namespace

Action IDs are primary keys only inside one cell, while the current base class
passes the raw action ID as `ActionExecutionContext.idempotencyKey`. Two cells
can therefore alias one logical job at a shared receiver if they choose the
same local ID. Architecture v1 requires an operation identity namespaced by
deployment, Durable Object class, cell identity, and local action ID. This must
be enforced in Protein or every shared capability adapter before the capability
contract is considered complete.

### 3. Are alarm recovery and repair sufficient after every hard interruption?

Protein multiplexes pending work and leases onto one alarm. Validate:

- fired alarm before claim;
- claim before decision;
- event decision before action alarm reconciliation;
- expired event/action leases;
- celld's finite platform alarm retry exhaustion;
- orphan wake entries after node loss.

### 4. How are authentication, authorization, and secrets provided?

Celld does not terminate public TLS or authenticate end users. Protein currently
accepts application requests and stores compact JSON without an auth policy.

A production embedding needs:

- authenticated ingress and deterministic agent-name authorization;
- tenant-aware rate limits and payload ceilings;
- secret references rather than secret values in cell state;
- executor authentication and scoped capabilities;
- audit redaction and retention.

### 5. Is current celld safe for the intended tenancy model?

Celld explicitly describes the current alpha as unsafe for hostile
multitenancy. One fleet also runs one application. User-supplied Worker code,
untrusted generated code, and arbitrary executor credentials are out of scope
until the isolation model changes.

## P1 — runtime completeness

### 6. What is the cancellation and steering protocol?

Cancellation should be a durable event that advances the run revision and
prevents later decisions from committing. It cannot retract an external action
already accepted. Define idempotent cancel, terminal precedence, and WebSocket
steering semantics.

### 7. How should human approval work?

Approval belongs between committed action intent and dispatch. Define:

- action states `awaiting_approval`, `approved`, and `rejected`;
- who may approve;
- expiry and revocation;
- stable approval evidence;
- whether payload changes invalidate approval.

### 8. How are schema and application state migrated?

Runtime schema version 2 includes one in-place migration that adds the action
dispatch marker. This is evidence for the mechanism, not a general upgrade
framework. Application `initialState` is not a migration mechanism. Define
ordered runtime migrations, application migration hooks, rollback behavior,
and large-fleet rollout safety.

### 9. What is the reconciliation API?

`reconcilable` now calls the distinct `reconcileAction()` hook before every
dispatch. The remaining contract work should distinguish:

- `dispatch(action)`;
- `lookup(idempotencyKey)`;
- retryable absence;
- authoritative delivered/failed state.

### 10. How are journal and state retained?

Define per-table limits, compaction, export, deletion, legal hold, and state
size budgets. Large workspaces, logs, prompts, patches, and artifacts must stay
outside the cell.

### 11. What are the WebSocket recovery guarantees?

Test hibernation, reconnect cursors, owner movement, duplicate client messages,
and connection authorization. Current frames provide live state, not a durable
stream protocol.

## P1 — fleet and product blockers

### 12. Who provisions and indexes agents?

Cells share no database. Protein can address a known name but cannot list every
tenant, query all active runs, or enforce global quotas. The embedding product
needs a control-plane index or a deliberately sharded registry.

### 13. What is the real steady-state fleet cost?

The 1,000-cell activation passes with the small runtime, but measurements still
need forced hibernation, reactivation, real object storage, heterogeneous
alarms, WebSockets, and non-empty state. Peak activation throughput is not the
same as cheap steady state.

### 14. How are global budgets and fairness enforced?

Per-cell budgets do not prevent one tenant from activating many cells or
consuming executor/model capacity. Define admission, global rate limits,
backpressure, and executor quotas outside the cells.

### 15. Is Protein a library, compatibility profile, or upstream patch set?

The current minimal runtime is useful evidence. Design-partner work must decide
whether the durable inbox/outbox belongs:

- in Protein as a library;
- upstream in celld examples or Workflows;
- upstream in a modular Cloudflare Agents core;
- in an application-specific RepoAgent service.

## Closed by the current implementation

- **Is a Codex process native inside celld?** No. Filesystem and shell execution
  require an external executor.
- **Can current Cloudflare Agents run at all?** Partially. State, schedules, and
  WebSockets pass with a prebundle workaround.
- **Can its queue safely drive awaited celld work?** No in the tested version;
  detached flushing abandons the async continuation.
- **Should Protein extend the full Agent class?** No for the current fleet
  premise. The 1,000-cell comparison rejected its bundle/residency cost.
- **Can a minimal runtime complete 1,000 named-cell activations?** Yes in the
  recorded local test; this is not yet a production capacity claim.
