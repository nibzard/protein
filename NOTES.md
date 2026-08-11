# Research notes

Research date: 2026-08-09.

## Corrected cube thesis — 2026-08-11

The purpose of a larger cellular population is not only to maximize benchmark
intelligence or prove that many agents beat one agent. That framing is too
narrow.

Protein and celld can demonstrate a future agentic compute fabric in which many
lightweight agents retain durable identity, local state, schedules, work claims,
relationships, and provenance while sleeping between useful activations. Most
agents may need only their cell for coordination. Some work should escalate on
demand to an LLM, a bounded tool process, or a full Linux sandbox, then return a
durable result and receipt to the originating cell.

The central systems question is therefore:

> Can a large population of durable agents coordinate heterogeneous, escalating
> compute reliably and economically over time?

A cube is valuable when it makes that operating model visible: agents wake,
exchange artifacts, claim or challenge work, request stronger executors, survive
runtime interruption, resolve conflicting changes, and hibernate again. Final
task quality remains important, but so do recovery, duplicate suppression,
provenance, resource escalation, utilization, cost, and the integrity of work
across many interactions.

The formal-protocol preflight rejected its nine independent mutations as an
*intelligence benchmark* for a larger cube. It did not reject the cube as a
systems demonstration. Its actual lesson is that a cube workload must contain
coupled work, heterogeneous resource needs, and durable interactions whose value
cannot be reduced to parallel enumeration.

## First compute-fabric cube learnings — 2026-08-11

The first live `3×3×3` run passed with 27 durable identities and four execution
tiers. The canonical evidence is
`compute-fabric-openai-20260811071417338-2078129`.

Observed lessons:

- Cell-only work, model calls, bounded evaluators, and Linux sandboxes can share
  one durable capability/receipt lineage without putting heavyweight execution
  inside the cell.
- Long model calls need leases sized for real provider latency. A lease adequate
  for the mock executor caused reentrant claims in the live run.
- A cell's inbox should be serialized even while the fleet remains concurrent.
- Executor rejection is evidence, not an HTTP failure. Invalid generated source
  must return a durable failed-check receipt so another agent can revise it.
- Hibernation and outstanding-action crash recovery should be exercised as
  distinct lifecycle phases. Resident pressure, not idle time alone, was the
  reliable way to demonstrate hibernation on the small single-host fleet.
- The useful interaction unit is an artifact, relationship, receipt, or
  recovery decision. Raw message volume remains a poor success metric.

The final run recorded 39 complete receipts, 348 Protein journal entries, 41
typed relationships, 11 Luna calls, one reconciled duplicate dispatch, one
terminated sandbox retry, one denied evaluator retry, and one resolved conflict
between independently correct patches. All four accepted repairs passed hidden
evaluation.

## Celld substrate

Primary sources:

- [celld repository](https://github.com/denoland/celld)
- [official overview](https://github.com/denoland/celld/blob/553ae73f83c87c3f7c7a5f73c32c2211d9d7341f/docs/README.md)
- [Cloudflare compatibility](https://github.com/denoland/celld/blob/553ae73f83c87c3f7c7a5f73c32c2211d9d7341f/docs/cloudflare-compat.md)
- [limitations](https://github.com/denoland/celld/blob/553ae73f83c87c3f7c7a5f73c32c2211d9d7341f/docs/limitations.md)
- [security model](https://github.com/denoland/celld/blob/553ae73f83c87c3f7c7a5f73c32c2211d9d7341f/docs/security.md)
- [testing and performance](https://github.com/denoland/celld/blob/553ae73f83c87c3f7c7a5f73c32c2211d9d7341f/docs/testing.md)
- [v0.1.0 release](https://github.com/denoland/celld/releases/tag/v0.1.0)

Verified design facts:

- one named cell owns one private SQLite database;
- cells share no database;
- HTTP, RPC, inbound hibernatable WebSockets, outbound HTTP/WebSockets, and one
  alarm are available;
- handlers execute on one thread but may interleave while awaiting;
- acknowledged writes are documented as gated on bucket durability;
- cells may hibernate and restore from the operator-owned bucket;
- no functional filesystem, subprocess, general TCP, queue service, workflow
  service, blob binding, browser, email, or native AI service is present;
- one fleet runs one application and operators provide ingress, TLS, auth,
  private networking, secrets, monitoring, and updates.

Important disputed guarantee:

- [issue #132](https://github.com/denoland/celld/issues/132) reports overlapping
  owner authority under clock skew. Treat one-writer as a celld claim pending
  resolution and independent testing.

## Cloudflare Agents comparison

Primary sources:

- [Cloudflare Agents repository](https://github.com/cloudflare/agents)
- [Agents architecture](https://developers.cloudflare.com/agents/)
- [state](https://developers.cloudflare.com/agents/runtime/lifecycle/state/)
- [scheduling](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/)
- [WebSockets](https://developers.cloudflare.com/agents/runtime/communication/websockets/)
- [harnesses](https://developers.cloudflare.com/agents/harnesses/)
- [Agents and Workflows](https://developers.cloudflare.com/agents/concepts/workflows/)

The important conceptual agreement is the split between:

- durable runtime: identity, SQL, connections, schedules, recovery;
- harness: prompts, models, tools, streams, and continuation policy.

Protein follows that split. Its executable compatibility findings are in
[COMPATIBILITY.md](./COMPATIBILITY.md).

## Alternatives pressure test

Primary documentation reviewed:

- [Restate virtual objects and sessions](https://docs.restate.dev/ai/patterns/sessions)
- [Restate durable timers](https://docs.restate.dev/develop/ts/durable-timers)
- [Rivet actor lifecycle](https://rivet.dev/docs/actors/lifecycle/)
- [Rivet actor queues](https://rivet.dev/docs/actors/queues/)
- [Temporal documentation](https://docs.temporal.io/)
- [AWS EventBridge Scheduler quotas](https://docs.aws.amazon.com/scheduler/latest/UserGuide/scheduler-quotas.html)

Conclusions:

- Cron plus a shared database wins for a small fixed set of jobs.
- A normal process wins continuous, library-heavy, artifact-heavy work.
- Temporal wins finite workflows with rich signals, retries, compensation, and
  operational tooling.
- Restate and Rivet already cover much of the keyed durable actor story.
- Managed serverless scheduling makes “many timers” insufficient as a product
  thesis.
- Celld's meaningful wedge is the combination of Workers/Durable Objects
  familiarity, private per-cell SQLite, hibernation, and self-hosting.

## Product learning

The initial design overfit scheduled case shepherds. The 100-use-case library
showed that many jobs can be represented as sleeping state machines, but it did
not establish demand for celld or Protein.

The corrected demand unit is a fleet of independently addressed agents owned by
an embedding product. The reference RepoAgent is valuable because it exercises
that unit while making the external executor boundary explicit.

## Evidence policy

Documents distinguish:

- celld project claims;
- Cloudflare or competitor product claims;
- locally reproduced observations;
- unresolved hypotheses.

Local numbers always record the binary/package versions and environment. They
must not be generalized into production SLAs.
