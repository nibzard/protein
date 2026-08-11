# Protein — product thesis

## Thesis

The celld-native agent primitive is an identity-centered durable actor:

> A named cell receives events, reconciles them against private state, commits
> action intent before external execution, records results, and hibernates when
> it has no runnable work.

The agent is not an always-running LLM process. A model is one possible decision
function inside a bounded activation. A goal is a run inside an agent, not the
agent's identity.

Protein exists only if this actor shape is materially easier and safer than
assembling the same behavior from a shared database, scheduler, queue, leases,
WebSocket service, and outbox.

## Why celld changes the design

Celld makes four things unusually direct:

1. **Named ownership.** A user, repository, service, device, or room maps to a
   stable address and an intended active cell owner. The tested celld release
   can temporarily produce overlapping owners under partition and clock skew;
   see [PROOFS.md](./PROOFS.md).
2. **Private transactional state.** The agent's compact memory and lifecycle
   ledger live beside its code in SQLite.
3. **Event-shaped residency.** HTTP, RPC, WebSockets, and alarms wake the cell;
   it can leave memory between events.
4. **Self-hosted placement.** State is replicated to an operator-owned
   S3-compatible bucket rather than a managed Durable Objects account.

Celld does not make arbitrary async JavaScript durable and does not provide an
OS sandbox. That leads to a control-plane/data-plane split:

- the cell owns identity, decisions, runs, approvals, action intent, receipts,
  and client continuity;
- external services own Git workspaces, shells, browsers, GPUs, large blobs,
  and specialized tools.

## Agent, run, and workflow

These are different units:

- **Agent:** an open-ended identity that wakes on events and may exist for
  months or years.
- **Run:** one goal or task governed by that identity.
- **Turn:** one bounded decision attempt within a run.
- **Action:** a durable request to change or query an external system.
- **Workflow:** a finite run-to-completion program with durable step replay.

Protein implements the first four. It should integrate with a workflow engine
when a run becomes a large pipeline rather than recreating durable continuations
inside a cell.

## Demand filter

A use case creates real demand for Protein only when most of these are true:

- there are hundreds or thousands of independently addressed agents;
- each owns small, private, long-lived state;
- most are inactive most of the time;
- several event sources can target the same identity;
- ordering and deduplication matter within that identity;
- users need to reconnect to live work;
- self-hosting or customer-premises deployment matters;
- large compute and artifacts can remain outside the cell.

“Durable,” “uses an LLM,” or “runs on a timer” are not sufficient. Cron,
Postgres, serverless schedulers, Restate, Temporal, Rivet, and source-native
automation already cover large parts of that space.

## Strongest use cases

### 1. Embedded per-customer agent fleets

A B2B product provisions one agent per customer account, workspace, or owned
resource. Each instance has private preferences, ongoing runs, integrations,
and reconnectable state. The product already owns authentication and fleet
provisioning; Protein supplies the per-agent lifecycle.

This is the strongest economic driver because the repeated keyed-state and
lifecycle problem appears at fleet scale.

### 2. Repository engineering agents

One cell represents a repository and retains repository policy, conversations,
runs, approvals, action receipts, CI callbacks, and review feedback. An external
executor checks out the repository and runs commands.

This is the strongest reference harness. It exercises interactive sessions,
long waits, tool callbacks, duplicate webhooks, restart recovery, and external
effects without pretending celld is a shell host.

### 3. Service and incident agents

One cell per service or incident reconciles alerts, deployments, operator chat,
diagnostic results, and remediation approvals. It can keep live WebSocket
clients during an incident and hibernate afterward.

### 4. Device and site agents

One cell per device, vehicle, facility, or site receives sparse events,
maintains local history, schedules maintenance decisions, and coordinates
external systems. It is not a hard-real-time controller.

### 5. Persistent rooms, communities, and characters

Rooms and AI characters naturally need stable identity, private state,
real-time connections, and cheap inactivity. This is architecturally native
even when the model behavior is simple.

### 6. Sovereign organizational assistants

One agent per employee, team, or account keeps memory and integration state on
customer-controlled infrastructure. A fleet may justify celld; one personal
assistant usually does not.

## False fits

Protein should reject these as primary demand evidence:

- one webpage watcher or a handful of reminders;
- one-shot research, summarization, or coding;
- continuously busy agents;
- global shared-memory swarms;
- ETL and report-generation pipelines;
- GPU inference or high-rate telemetry processing;
- shell, browser, or Git execution inside the cell;
- exactly-once payments or other non-reconcilable side effects;
- hostile user-supplied code on the current celld alpha.

The earlier 100-case exercise remains in [CASE-LIBRARY.md](./CASE-LIBRARY.md),
but most entries demonstrate that the runtime *could* host a case. They do not
show that anyone would deploy celld for it.

## Product decision

Protein should remain a small celld-native runtime and compatibility profile:

- use the Durable Objects API rather than inventing a platform-neutral lowest
  common denominator;
- keep the model and tool harness replaceable;
- add durable event/action semantics celld does not supply;
- make external execution a first-class capability boundary;
- publish measured compatibility and failure behavior;
- avoid absorbing provisioning, tenancy, global search, secrets, or workflow
  orchestration.

Cloudflare's Agents SDK is valuable prior art and a compatibility target, but
the current full bundle is too broad for Protein's minimal fleet premise and
its detached `queue()` behavior is unsafe for awaited work on celld. See
[COMPATIBILITY.md](./COMPATIBILITY.md).

## Continue and stop conditions

Continue if design partners need large customer-controlled fleets and Protein
removes meaningful per-identity lifecycle code.

Shrink Protein to examples or upstream contributions if:

- normal services plus Postgres remain just as simple;
- users prefer Restate, Temporal, Rivet, or managed Durable Objects;
- celld's ownership and recovery model cannot meet the required envelope;
- the external executor boundary dominates the product;
- fleet observability, auth, and provisioning become the real project.
