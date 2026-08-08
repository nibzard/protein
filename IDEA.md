# IDEA — Protein

## Thesis

**The cell is the right unit of agent work.** celld's Durable Object — one exactly-one-owner actor with its own private SQLite, hibernating between events, woken by alarms — is sized almost perfectly for a *bounded, stateful, event-shaped* agent. Protein is the framework for that unit, and it deliberately refuses to grow past that fit.

The alternative most frameworks pick — a giant, long-running, in-memory exploratory loop — fights every constraint celld imposes (short-lived bounded workers, alarm-only timers, no Node, no blobs). Protein treats those constraints as the design, not as obstacles.

## The metaphor (used with discipline)

- **Cell** = a celld Durable Object. The organism. Owns a private SQLite, exactly-one-owner across the fleet.
- **Protein** = one agent. A cheap, specialized, short-lived functional unit the cell *expresses on demand*, folded to one job, then dormant.
- **DNA** = durable state and skills. Rows in the cell's SQLite, replicated to S3 via LTX.
- **Translation** = the LLM call over outbound `fetch`. It *translates* a step's intent into a concrete action. (Ribosomes translate; they do not fold — so we say "translation," not "folding," for the model step.)

The metaphor is a sizing discipline, not decoration: a protein is a small folded unit, not an organism. Whenever a design choice risks turning a protein into an organism, the metaphor says stop.

## Design principles

1. **One cell per agent.** Single-owner by name. Never hand-roll locks, leases, or job queues — celld's compare-and-swap already serializes each cell's work.
2. **One bounded step per wake.** An alarm fires a short, CPU/wall-clock-bounded worker. Multi-step reasoning is *paced across alarms*, never run as one long synchronous loop.
3. **DNA in SQLite.** All durable memory, conversation, and skills live in the cell's own SQLite (`ctx.storage.sql`), LTX-replicated to S3. No external database to operate.
4. **Hibernate between steps.** Near-zero idle cost. A fleet of long-lived agents costs nothing while waiting; you pay for steps actually taken.
5. **No lock-in — platform or model.** celld runs on your own machines with no Cloudflare account; the LLM is plain outbound `fetch` to any provider. celld's *absences* (`env.AI`, KV, R2-as-blob, Vectorize) are the feature.
6. **Inspectable by construction.** An agent's durable state is a SQLite database you query on a machine you control — not a managed-edge black box.
7. **Idempotent, resumable steps.** Re-arm only after the step's writes are durable. A crash loses at most the in-flight step; the agent resumes from durable state.
8. **Stay portable.** The celld-coupling lives behind one interface. If celld stalls, agents retarget Restate, Rivet, or workerd without rewriting.

## What Protein is *not*

- **Not a giant exploratory agent brain.** Long, tight, many-turn LLM loops with large blob output belong in a Node process (e.g., Wire), not in a cell. Protein is for bounded, scheduled, action-shaped work.
- **Not a general durable-execution / workflow engine.** Temporal, Restate, and Windmill own that category. Protein is narrower: the small bounded agent.
- **Not an all-in-one agent platform.** No managed UI, RBAC, vector store, or compliance accreditation. Teams wanting a packaged product go to Lyzr or Palantir; Protein is the open runtime underneath.
- **Not married to celld.** celld is the first target, chosen for its Cloudflare-DO-API compatibility and self-hosted-no-account model. The portable interface keeps the exit open.

## North star

> Make expressing a self-hosted, durable, no-lock-in agent as simple as writing one function that takes a step — where the durability, the single-ownership, the scheduling, and the memory are the cell's job, not yours.

## Success looks like

A developer writes a single `step()` method, deploys to their own celld fleet, points it at any LLM, and gets an agent that remembers, schedules itself, survives crashes, and costs nothing while idle — without operating a database, a queue, or a Cloudflare account.
