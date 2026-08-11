# Safety proof report

This report records executable evidence for Protein's two hardest boundaries:
external effects across process loss and cell ownership across multiple celld
nodes. It is a falsification report, not a claim that every invariant passed.

Tested on 2026-08-09 with celld `0.1.0`, schema version 2, Node `24.18.0`, and
MinIO over loopback. Every scenario creates a fresh bucket and celld watch
directory. A hard crash is `SIGKILL`, not a graceful restart.

## Executive result

| Claim | Result | Evidence |
|---|---|---|
| Idempotent effects converge after crashes at every tested lifecycle boundary. | **Pass** | Eight of eight crash points completed with one logical executor job. Four post-request points required two HTTP requests. |
| Reconciliation prevents redispatch after an accepted remote effect. | **Pass** | One request, one job, and two authoritative lookups after a crash at remote acceptance. |
| Protein can keep an inherently unsafe effect from being sent after celld loses the local dispatch marker. | **Fail** | The exact-marker crash made one request after recovery; both later crash points made two. All completed instead of becoming ambiguous. |
| Celld maintains one active cell owner in the tested stale-owner, partition, and clock-skew window. | **Fail** | Nodes A and B both served the same cell and both reached `action.dispatch_started`. |
| An idempotency key contains effects during dual-owner dispatch. | **Pass** | The executor observed requests from A and B but created one logical job. |
| State converges after the partition is healed and a fresh owner starts. | **Pass** | The recovered run reached one `completed` terminal record. |

The practical conclusion is narrower than “durable actions.” Protein on celld
`0.1.0` can provide durable orchestration only when every external effect is
idempotent or authoritatively reconcilable. It cannot make an unsafe receiver
safe, and local revision fences cannot repair simultaneous celld owners.

## Lifecycle under test

```text
event claim
   │
   ├── event.before_commit       decision and action intent not committed
   ▼
intent + event committed
   │
   ├── event.committed          intent exists; alarm may not be replicated
   ▼
action claimed
   │
   ├── action.claimed           no dispatch marker
   ▼
dispatch marker committed
   │
   ├── action.dispatch_started   marker exists; executor not called yet
   ├── executor.request_received remote request arrived
   ├── executor.accepted         remote effect exists
   ├── action.response_received  response returned to Protein
   ▼
receipt + outcome event committed in one SQLite transaction
   │
   └── action.committed
```

The controller blocks a selected checkpoint. The harness waits until that
checkpoint is observed, sends `SIGKILL` to celld, discards its local watch
directory, releases the blocked request, and starts a fresh celld process
against the same bucket. This deliberately tests bucket-visible durability,
not merely local SQLite recovery.

The named proof boundaries map to checkpoints as follows:

| Required boundary | Deterministic evidence |
|---|---|
| Action intent | `event.before_commit` and `event.committed` bracket the transaction that inserts the intent. |
| Claim | `action.claimed` fires after the revision-fenced claim transaction. |
| Dispatch | `action.dispatch_started` fires after its marker transaction and before `executeAction()`. |
| Remote request | `executor.request_received` is emitted by the independent controller. |
| Remote acceptance | `executor.accepted` fires after the authoritative job ledger contains the effect. |
| Response | `action.response_received` fires after `fetch()` resolves and before the local outcome transaction. |
| Receipt and outcome | `action.response_received` and `action.committed` bracket one SQLite transaction that writes the receipt and deduplicated outcome event atomically; there is no supported intermediate state. |
| Ownership transfer | The two-node harness proves B takeover, simultaneous A/B dispatch during transfer, and fresh-owner convergence after healing. |

## External-action crash matrix

Command:

```sh
CELLD_BIN=/path/to/celld \
PROTEIN_PROOF_ALLOW_FAILURES=1 \
npm run test:crash-matrix
```

The recorded run used a 1,000 ms Protein action lease.

| Safety | Crash checkpoint | Run / action | HTTP requests | Logical jobs | Lookups | Result |
|---|---|---|---:|---:|---:|---|
| idempotent | `event.before_commit` | completed / delivered | 1 | 1 | 0 | Pass |
| idempotent | `event.committed` | completed / delivered | 1 | 1 | 0 | Pass |
| idempotent | `action.claimed` | completed / delivered | 1 | 1 | 0 | Pass |
| idempotent | `action.dispatch_started` | completed / delivered | 1 | 1 | 0 | Pass |
| idempotent | `executor.request_received` | completed / delivered | 2 | 1 | 0 | Pass |
| idempotent | `executor.accepted` | completed / delivered | 2 | 1 | 0 | Pass |
| idempotent | `action.response_received` | completed / delivered | 2 | 1 | 0 | Pass |
| idempotent | `action.committed` | completed / delivered | 2 | 1 | 0 | Pass |
| reconcilable | `executor.accepted` | completed / delivered | 1 | 1 | 2 | Pass |
| unsafe | `action.claimed` | completed / delivered | 1 | 1 | 0 | Pass |
| unsafe | `action.dispatch_started` | completed / delivered | 1 | 1 | 0 | **Fail** |
| unsafe | `executor.request_received` | completed / delivered | 2 | 1 | 0 | **Fail** |
| unsafe | `executor.accepted` | completed / delivered | 2 | 1 | 0 | **Fail** |

Total: 10 passed and 3 failed.

### What the crash result proves

Even `action.committed` can be followed by redelivery after hard process loss.
The SQLite transaction was complete in the killed process, but a fresh celld
node restored a bucket replica from before that transaction. The same loss can
erase `dispatch_started_at`. Therefore a fresh Protein runtime cannot use that
local marker to decide whether an unsafe remote call happened. The crash at
`action.dispatch_started` is stronger: the first process was killed before
calling the executor, yet recovery lost the committed marker and sent the
unsafe call instead of marking it ambiguous.

The marker still prevents blind retry when it survives recovery, but it is not
a durability acknowledgement. For `reconcilable` actions, Protein queries the
authoritative external system before every dispatch. For `idempotent` actions,
the receiver owns the stable action ID and collapses repeats. Those contracts,
not local exactly-once execution, are what made the passing cases pass.

## Two-node ownership chaos test

Command:

```sh
CELLD_BIN=/path/to/celld \
PROTEIN_PROOF_ALLOW_FAILURES=1 \
npm run test:ownership-chaos
```

Topology:

```text
                    authoritative executor
                     (idempotency ledger)
                         ▲         ▲
                         │         │
              node=A     │         │     node=B, +9 s wall clock
client ───────► celld A  │         │  celld B ◄────── client
                  │      │         │      │
             peer proxy A  ×   ×  peer proxy B
                  │                     │
             store proxy A ×       store proxy B
                  │                     │
                  └──────── MinIO ──────┘
```

The node TTL was 12 seconds. B's real-time clock was shifted forward 9 seconds
while monotonic time remained unchanged. The sequence was:

1. Activate the cell through A and verify a request through B forwards to A.
2. Cut B-to-A routing only. B returns an owner-unreachable error and does not
   immediately claim the cell.
3. Restore healthy routing, restart B with the shifted wall clock, and then cut
   both peer routes plus A's object-store route.
4. Wait until A's last published lease is expired in B's clock view but before
   A's monotonic self-fence deadline.
5. Verify B takes over while A still serves its resident copy.
6. Submit the same idempotent run to both direct node addresses and block both
   at `action.dispatch_started`.
7. Release both dispatches, heal the topology, restart a fresh owner, and read
   the terminal run.

Recorded result:

| Invariant | Observation | Result |
|---|---|---|
| Healthy routing uses the elected owner. | Direct A returned A; B returned A. | Pass |
| A peer partition does not immediately create a new owner. | B returned HTTP 500 `DurableObjectRoutingError` while A's lease was live. | Pass |
| Only one active owner exists during stale-owner takeover. | Direct A returned A while direct B returned B. | **Fail** |
| Duplicate external effects are contained. | Dispatch checkpoints came from A and B; executor requests = 2, logical jobs = 1. | Pass |
| A fresh owner converges after healing. | Final run status = `completed`. | Pass |

Total: 4 passed and 1 failed.

This is a deliberately adversarial 75%-of-TTL clock shift, not a claim about
ordinary NTP drift. It demonstrates that celld's local self-fence and another
node's wall-clock expiry decision can overlap. The exact operational skew bound
must come from celld; Protein cannot enforce it inside the Worker.

## Interpretation and required architecture

```text
Protein revision fence
  protects: stale async result committing over a newer local revision
  does not protect: two celld owners independently calling a remote system

External idempotency / reconciliation
  protects: repeated calls, crash redelivery, dual-owner dispatch
  does not provide: uniqueness of local execution

Celld owner fencing
  must protect: the single-authority invariant itself
```

Production acceptance therefore requires all of the following:

1. Treat `idempotent` and `reconcilable` as enforced capability contracts, not
   descriptive labels.
2. Reject automatic `unsafe` dispatch for high-stakes effects on celld `0.1.0`,
   or route it through an external broker that supplies durable idempotency,
   reconciliation, or fencing.
3. Obtain an upstream celld fix and rerun this exact ownership harness before
   claiming one active owner under partitions and clock skew.
4. Preserve stable action IDs outside ownership epochs. A takeover retry must
   address the same logical effect, as the dual-dispatch test does.
5. Do not describe the current runtime as exactly once.

Useful upstream primitives would be a bucket-replication acknowledgement for a
specific SQLite transaction and a fencing token that downstream brokers can
reject once a newer owner epoch exists. Either one would strengthen the model;
neither is exposed to Protein today.

## Reproduction semantics

Both proof commands exit non-zero when an asserted invariant fails. This is
intentional: known failures remain visible in CI. Set
`PROTEIN_PROOF_ALLOW_FAILURES=1` to collect the complete report with exit zero.
`npm run test:proofs` always runs both suites before returning their aggregate
status.

The harnesses require Docker, GCC, and a celld v0.1.0 binary. They allocate
isolated loopback ports, MinIO containers, buckets, and temporary celld watch
directories, and clean them up when finished.
