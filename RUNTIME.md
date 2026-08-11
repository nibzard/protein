# Protein runtime contract

This document describes the implementation in `src/`, not a future base-class
proposal.

## Runtime object

`ProteinAgent<Env, State>` extends the Workers `DurableObject` class. One named
Durable Object is one agent identity. Applications provide:

```ts
class MyAgent extends ProteinAgent<Env, MyState> {
  initialState = { /* compact JSON state */ };

  protected async onAgentEvent(ctx) {
    // Return a state/run transition and durable action intents.
  }

  protected async executeAction(ctx) {
    // Invoke an external idempotent or reconcilable capability.
  }

  protected async reconcileAction(ctx) {
    // Return an authoritative prior result, or undefined if none exists.
  }

  async onRequest(request) {
    // Map application HTTP to startRun(), acceptEvent(), and inspection.
  }
}
```

The runtime deliberately does not prescribe a model SDK, prompt format, memory
algorithm, or tool schema.

## Public lifecycle operations

### `startRun({ id, goal })`

Creates a durable run in `queued` state and accepts the canonical
`protein.run.requested` event.

- Repeating the same ID and canonically equivalent JSON goal is idempotent.
- Reusing the ID with different content throws `ProteinConflictError`.
- A successful response is sent only after both the run and its event/alarm
  path have been written.

### `acceptEvent({ id, type, runId?, payload })`

Persists a deduplicated event and reconciles the cell alarm.

- Event IDs are unique within an agent cell.
- Equivalent repeats return `{ duplicate: true }`.
- A repeated ID with different type, run, or payload conflicts.
- Object-key ordering does not change event identity; JSON is canonicalized.

### Inspection

- `getRun(id)`
- `listRuns(limit)`
- `listActions(limit)`
- `listJournal(limit)`

These read only the current cell. Celld has no fleet-wide SQL index; global
discovery belongs in an application control plane.

## Durable schema

The current schema version is `2`. Startup migrates a version-1 action table by
adding the nullable `dispatch_started_at` column before recording version 2.

| Table | Purpose |
|---|---|
| `protein_state` | Current compact application state. |
| `protein_runs` | Goals, lifecycle status, result, and error. |
| `protein_events` | Inbox, claim revision, attempts, retry time, and lease. |
| `protein_actions` | Outbox intents, safety class, attempts, dispatch marker, receipt, and ambiguity. |
| `protein_journal` | Append-only operational lifecycle records. |
| `protein_meta` | Runtime schema version. |

Cloudflare Agents internal tables are not used by the production runtime.

## Event processing

One alarm activation processes at most one runnable action or event and then
reconciles the next alarm.

For an event:

1. A short SQLite transaction selects a pending event or an expired processing
   lease, increments its attempt and revision, and records `event.claimed`.
2. `onAgentEvent()` runs outside the transaction. Another request may interleave
   while it awaits.
3. A second transaction verifies the claimed revision.
4. If current, it writes application state, the run transition, action intents,
   event completion, and journal entries atomically.
5. If stale, none of the decision is applied.
6. Failure either schedules application backoff or terminally fails the event
   and associated run after the configured ceiling.

The runtime does not persist an arbitrary JavaScript continuation. Recovery
reconstructs work from event/action rows.

## Action processing

An `ActionIntent` contains:

```ts
interface ActionIntent {
  id: string;
  kind: string;
  payload: JsonValue;
  safety: "idempotent" | "reconcilable" | "unsafe";
}
```

The intent is inserted in the same transaction as the event decision. A later
alarm activation claims it and increments its revision. A reconcilable action
first calls `reconcileAction()` with its stable action ID. If no authoritative
result exists, Protein commits `dispatch_started_at` and then calls
`executeAction()` with the action ID as `idempotencyKey`.

Action IDs are unique only inside one Agent Cell. The current
`ActionExecutionContext.idempotencyKey` is therefore a stable cell-local key,
not a globally unique executor key. Before addressing a shared receiver, an
application adapter must namespace it by deployment, Durable Object class, cell
identity, and local action ID. The base runtime does not yet construct or
enforce that operation identity.

Outcomes:

- **delivered:** a receipt was persisted;
- **failed:** the retry ceiling was exhausted before a successful receipt;
- **ambiguous:** an unsafe action threw after dispatch could have begun;
- **pending/delivering:** work or lease recovery remains.

Every terminal action produces a deduplicated internal event such as
`protein.action.delivered`. The terminal status and result-or-error plus its
outcome event are inserted in one SQLite transaction, so a restart cannot
strand a delivered action without its follow-up event. Application logic uses
that event to finish or advance the run.

### Exactly-once boundary

Protein cannot atomically commit SQLite and a remote API call. Revision fencing
prevents stale local results from winning but cannot retract a remote call.
If an action lease is shorter than the real executor latency, a recovery alarm
can dispatch an overlapping retry while the first request is still live.
Idempotency or authoritative reconciliation is therefore required even without
a node crash; lease duration is not a cancellation mechanism.

- `idempotent` receivers must honor the globally namespaced operation key.
- `reconcilable` handlers must implement an authoritative lookup. Protein calls
  it before every dispatch because a crash can erase the local marker.
- `unsafe` actions become ambiguous after an uncertain dispatch only when the
  dispatch marker survives recovery. The real-celld crash matrix proved that
  bucket recovery can lose this marker and redeliver the action. Consequently,
  automatic unsafe effects are not production-safe on the tested celld release.

The same matrix observed redelivery even after the local receipt/outcome
transaction and `action.committed` checkpoint. A completed local SQLite commit
is not evidence that its replica is already recoverable by a fresh celld node.
See [PROOFS.md](./PROOFS.md).

Model calls have the same fundamental ambiguity if performed inside
`onAgentEvent()`. Applications should record provider request IDs and tolerate
repeated billing or use an idempotent model gateway.

### Monotonic artifact acceptance

`decideMonotonicAcceptance()` promotes a versioned child artifact only when its
lineage names the verified parent, it preserves every gate previously passed by
that parent, and it passes every newly required gate. Its durable receipt names
the candidate and the artifact retained after the decision. Failed or missing
evidence therefore retains the parent rather than allowing review or revision
to regress established work. Repository-maintenance and formal-proof examples
both use this primitive.

## Alarm model

Celld provides one alarm per cell. Protein multiplexes all event availability,
event leases, action availability, and action leases onto it.

- Pending work contributes `available_at`.
- Claimed work contributes `lease_until`.
- The earliest timestamp becomes the physical alarm.
- A fired alarm always re-arms if work remains.
- No runnable or recoverable work deletes the alarm.

Retries use bounded exponential backoff. Celld's own finite alarm retry is a
last-resort host mechanism, not the application retry policy.

## Concurrency

Celld runs one cell on one thread, but handlers may interleave while one awaits.
Protein therefore never treats a model or tool call as a lock.

Event and action revisions are monotonic fences:

```text
claim revision N → await external work → commit only if revision is still N
```

Cancellation and steering are expected to become events that advance the
relevant revision. Explicit cancellation is not yet implemented.

## State and WebSockets

Application state is compact canonical JSON. `setState()` persists it and
broadcasts a `protein.state` frame to hibernatable WebSocket clients.

On connection the runtime sends:

```json
{
  "type": "protein.connected",
  "agent": "agent-name",
  "state": {}
}
```

Inbound messages are delegated to the optional application `onMessage()` hook.
Important conversation history must be accepted as durable events; a live frame
alone is not durable input.

## External executor boundary

RepoAgent demonstrates the intended split. The cell retains the run, action ID,
policy, and receipt. The executor receives an HTTP request with:

```http
Idempotency-Key: run:run-1:execute
```

That reference header is the raw cell-local action ID. It is sufficient only
when the receiver is scoped to that cell or the application already makes its
action IDs globally unique. A shared production adapter must use the namespaced
operation identity described above.

The executor owns checkout, filesystem, commands, tests, and artifacts. Its
response is compact JSON stored as the action receipt. Large artifacts remain
outside the cell and should be referenced by content-addressed metadata.

## Known omissions

- cancellation and steering protocol;
- human approval primitive;
- general application-state migration hooks beyond the version-1-to-2 runtime
  migration;
- authentication, authorization, and secret references;
- retention/compaction policy;
- fleet provisioning, indexing, and observability;
- child-agent conventions;
- enforcement that prevents applications from selecting `unsafe` for automatic
  high-stakes dispatch;
- a celld replication acknowledgement or downstream owner-fencing token.

These are tracked in [QUESTIONS.md](./QUESTIONS.md).
