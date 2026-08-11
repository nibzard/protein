# Decision log

## 2026-08-09 — Reset the primitive from first principles

Rejected the prior “one goal, one bounded step, mostly waiting case shepherd” as
the definition of Protein. It was one possible harness overfit into the core.

Decided that the native primitive is an identity-centered Agent Cell. A cell may
hold many sequential runs and reacts to HTTP, WebSocket, alarm, and tool-result
events.

## 2026-08-09 — Keep execution outside the cell

Celld has no usable persistent filesystem or subprocess API. A Codex-like
RepoAgent therefore keeps control state in the cell and delegates checkout,
shell, tests, browser, and artifacts to an external executor capability.

## 2026-08-09 — Probe Cloudflare Agents before cloning it

Pinned `agents@0.20.1` and celld `0.1.0`.

Observed:

- direct celld bundling failed on `mimetext` → bare `path`;
- a neutral prebundle with `path` aliased to `node:path` deployed;
- persistent state, schedules, WebSockets, and restart recovery passed.

## 2026-08-09 — Reject Agents `queue()` for celld async work

The first RepoAgent committed an action claim and then remained `delivering`;
the mock executor received no request.

Inspection showed `queue()` calls `_flushQueue()` without awaiting it or binding
it to the current event lifetime. Celld ended the handler after the synchronous
claim, abandoning the awaited outbound fetch. Alarm-backed scheduled callbacks
completed correctly.

Decision: Protein owns an alarm-backed durable inbox/outbox and does not expose
Cloudflare Agents queue semantics as compatible.

## 2026-08-09 — Reject the full Agents SDK as Protein's base

An Agents-based RepoAgent bundle was about 1.7 MB. During a 1,000-cell activation
run, celld reached roughly 9.9 GB RSS on an 11.7 GiB host and requests began
timing out under pressure. The run was stopped.

Reimplemented `ProteinAgent` directly on `DurableObject` with only state,
events, runs, actions, alarm reconciliation, journal, and WebSockets. The
RepoAgent bundle fell to 34.2 KB in the final implementation.

## 2026-08-09 — First validated baseline

The clean-room harness passed:

- Cloudflare probe state, schedule, WebSocket, and restart;
- Protein event deduplication and conflict detection;
- committed external action and receipt;
- no second logical executor job on duplicate submission;
- RepoAgent recovery from a fresh celld cache;
- recovery of an idempotent executor action interrupted in flight by restart;
- 1,000/1,000 minimal Protein cell activations in 19.46 seconds at 3,459 MiB
  peak celld RSS.

With a two-second test ownership lease, observed fresh-node recovery was roughly
1.8 seconds. These are local MinIO measurements, not production guarantees.

## Current decision

Protein proceeds as a minimal celld-native runtime and evidence project. It does
not proceed as a change-monitor product, general workflow engine, full
Cloudflare Agents port, or in-cell Codex clone.

## 2026-08-09 — Falsify unsafe-action and single-owner guarantees

Added schema version 2, persistent dispatch markers, an authoritative
reconciliation hook, deterministic lifecycle checkpoints, an executor ledger,
a 13-case hard-crash matrix, and a two-node partition/skew harness.

Observed 10/13 crash cases pass. Every idempotent case converged to one logical
job, and reconciliation avoided redispatch after remote acceptance. Unsafe
protection failed at the exact dispatch marker and two later points: a fresh
celld process restored state from before the local marker, sending once after
the marker-only crash and making a second request after later crashes.
Even a crash after the local receipt/outcome commit caused idempotent
redelivery.

The two-node test passed healthy routing and immediate partition behavior, then
reproduced overlapping A/B authority after A became stale and B's wall clock
was shifted forward. Both nodes reached executor dispatch for the same action.
The receiver observed two origins and two requests but one logical job, then a
fresh owner converged to a completed run after healing.

Decision: idempotency or authoritative reconciliation is a mandatory Protein
capability contract. `unsafe` is descriptive evidence only and must not be
treated as safe automatic dispatch on celld `0.1.0`. Protein also cannot claim
single-owner correctness until the celld ownership harness passes against an
upstream fencing fix. Full evidence and reproduction commands are in
`PROOFS.md`.
