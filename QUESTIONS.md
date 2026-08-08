# QUESTIONS — to resolve before/while building

What we need answered before committing serious effort. Grouped by theme; each marked **[BLOCKER]** (resolve before writing core code) or **[DECIDE]** (resolve before v1 ships) or **[VALIDATE]** (resolve before claiming product-market fit).

## Foundation risk (celld)

- **[BLOCKER]** If Ryan Dahl / Deno Land deprioritize celld within 12 months, what is the concrete fallback? Is the actor/storage/alarm interface genuinely swappable to Restate, Rivet, or `workerd` without rewriting agents? — *Decide by prototyping the portable interface against a second backend early.*
- **[BLOCKER]** Can celld's S3-no-consensus replication pass an independent correctness review and a failover/chaos/partition load test that measures actual data loss? The entire durability pitch inherits this doubt.
- **[VALIDATE]** How fast does celld actually mature — contributor base, community (Discord/Discussions), roadmap execution (D1/Queues)? Set a checkpoint (e.g., 3–6 months) to reassess commitment.

## Scope & positioning

- **[VALIDATE]** How large is the audience that specifically wants to *migrate existing Cloudflare DO/Workers agents off the edge* — vs. just staying on Cloudflare or picking Restate/Rivet? Quantify before betting the wedge on CF-API compatibility.
- **[VALIDATE]** Do real buyers want the "deliberately small bounded agent," or do they gravitate toward the giant exploratory loops LangGraph/CrewAI enable? Validate with paying design partners, not philosophy.
- **[VALIDATE]** Who is the first design-partner customer, and is their need "a self-hosted durable agent" (where Restate/Rivet already win) or specifically "run my Cloudflare DO code on my own metal" (Protein's narrow edge)?
- **[DECIDE]** Does Protein ship enough fleet primitives (concurrency, fairness, observability) to be viable beyond single-agent — or is it permanently scoped to one-cell-at-a-time, and is *that* market big enough?
- **[DECIDE]** Is "no `env.AI` / fetch-only" a real buying criterion, or do users actually prefer the convenience of a binding — making it a non-differentiator?

## Demand / market

- **[VALIDATE]** Does EU AI Act / sovereignty demand actually convert to *open-runtime* adoption, or do regulated buyers default to Palantir/Lyzr packaged products regardless of openness and licensing?
- **[VALIDATE]** Is the cost / "agent tax" pain strong enough that buyers adopt a new runtime, or do they just hand-roll a DIY stack (Ollama+vLLM+Postgres+framework)?

## Technical unknowns

- **[BLOCKER]** What is the real durability window — how long between a SQLite write and its LTX replication to S3, and what happens to in-flight steps under node failure? Until measured, assume any step can be replayed and design idempotency accordingly.
- **[DECIDE]** Does `ctx.storage.sql.exec` reliably return iterable column-keyed rows across celld builds (verified in source today), and is the SQL feature set (transactions, indexes, the full SQLite surface) complete enough for our DNA schema? Pin this with a test.
- **[DECIDE]** How do we keep alive an inbound hibernatable WebSocket without `setWebSocketAutoResponse` (absent, issue #123)? Implement keepalive inside `webSocketMessage`/`alarm`, or accept shorter-lived sessions?
- **[DECIDE]** Where do artifact *bytes* live, given R2 is unusable from a Worker? Caller-owned S3/MinIO, or a sibling process? Define the artifact contract before agents start emitting evidence.
- **[DECIDE]** Multi-cell composition: do we standardize a planner/worker pattern (cells addressing cells by name + shared nothing), or stay single-cell for v1 and let users compose themselves?

## Product & DX

- **[DECIDE]** What is the minimum `Protein` developer experience? Target: write one `step()` method, `celld deploy`, point at an LLM, done. What gets in the way of that today?
- **[DECIDE]** Language/SDK surface: TypeScript-only at first (celld is V8/JS), or do we design the contract to be language-agnostic from the start (Restate/Rivet are multi-language)?
- **[DECIDE]** Observability story without a managed platform: what do we build on celld's alarm/SQLite primitives so a developer can see what their agent is doing?
- **[VALIDATE]** Licensing & governance of Protein itself (MIT/Apache?), and whether "self-hosted, no lock-in" needs to be reinforced by a license that blocks a competing managed wrapper.

## Immediate next actions

1. Prototype the **portable `ProteinDna` + `ActorRuntime` interface** with two backends (celld + one of Restate/Rivet) — de-risks the #1 foundation risk.
2. Stand up a **local celld** and run the `RUNTIME.md` example end-to-end against a real LLM `fetch` — proves the verified API set in practice.
3. Write a **failover/partition test** that measures data loss on a mid-step crash — answers the durability-window blocker.
