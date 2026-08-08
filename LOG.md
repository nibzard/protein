# LOG — work log

A chronological record of decisions and progress on Protein. Newest at the top.

## 2026-08-08 — Origin & scaffold

**Origin.** Protein was conceived during an exploration of running [Wire](https://github.com/) (a zero-weight browser agent) on celld. That work concluded:
- celld is a poor home for Wire's *heavy exploratory LLM loop* (alarm wall-clock bound, no blobs, no Node);
- but celld is an excellent home for *small, bounded, scheduled action agents* — the single-owner, hibernating, alarm-paced cell is almost the ideal unit for that shape of work.

Protein generalizes the second conclusion into a framework.

**Settled.**
- Name: **Protein** — a cell makes proteins; a protein is a small folded functional unit, not an organism (sizing discipline).
- Thesis: the cell is the right unit of agent work; Protein is the deliberately small bounded agent that fits it.
- Foundation: celld (self-hosted Cloudflare Workers + Durable Objects; no edge/account lock-in).
- Model access: plain outbound `fetch` to any provider (no `env.AI`).

**Verified (against celld source + compat docs, across several research passes).**
- celld API surface that Protein builds on: `DurableObject` base, `ctx.storage.sql` (private SQLite), alarms (`setAlarm`/`alarm()`), `acceptWebSocket`/`getWebSockets`/`webSocketMessage`, outbound `fetch` + `new WebSocket`, `ctx.waitUntil`.
- Hard constraints encoded: no Node (`node:*` are silent no-op stubs), no `env.AI`/KV/D1/Queues/Vectorize, R2 loads-but-throws, alarms-only (no cron, `setInterval` throws), `setWebSocketAutoResponse`/`WebSocketRequestResponsePair` absent (issue #123).

**Market research (Aug 2026).**
- Closest peers: **Restate** and **Rivet** already ship self-hosted durable-actor-for-agents at far greater maturity. Temporal owns heavyweight durable execution. LangGraph/Letta/Mastra are agent frameworks that assume a durable home.
- Honest verdict: the durable-actor-for-agents idea is not novel; Protein's unique parts are thin — celld is the only distributed self-hosted Cloudflare-DO-API-compatible runtime, plus the bounded-agent opinion — on a very young, bus-factor-1 foundation whose correctness is publicly disputed.
- Demand: strongest in regulated/sovereign (EU AI Act Art. 10), cost/"agent tax", model portability, and BYO-Cloud (run DO-agents off the Cloudflare edge).

**Scaffold created.** `README.md`, `IDEA.md`, `RUNTIME.md` (base-class contract, DNA schema, re-arm rule, example), `CLAUDE.md` (celld constraints + conventions), `NOTES.md` (landscape + risks), `QUESTIONS.md` (open questions), this log.

**Key decisions recorded.**
- Portable interface from day one (`ProteinDna` + future `ActorRuntime`) to retarget Restate/Rivet/`workerd` if celld stalls — the #1 risk mitigation.
- v1 scope: single-cell, single-agent, bounded steps. Multi-cell composition and fleet primitives deferred.
- No blobs in the cell; artifact bytes live in caller-owned object storage.

**Next.** (see [`QUESTIONS.md`](./QUESTIONS.md) "Immediate next actions") prototype the portable interface with a second backend; run the `RUNTIME.md` example on local celld against a real LLM; write a failover/partition test measuring data loss.
