# Protein

> A celld-native AI agent framework. One agent = one cell.

**Protein is the agent framework that fits in one celld cell: wake on an alarm, take a bounded step, call any LLM over plain `fetch`, write the result to your private SQLite, re-arm, and hibernate — a durable, single-owner protein, not a server you stand up or a giant loop you host.**

## What it is

Protein is an AI agent framework written for **celld** — the self-hosted runtime (by Deno / Ry Dahl, Apache-2.0) that runs Cloudflare-style Workers and Durable Objects on your own machines. One Protein agent lives inside one celld **cell** (a Durable Object): a hibernating, exactly-one-owner actor with its own private SQLite database.

Instead of running an agent as one long-lived in-memory loop, a Protein agent is paced by alarms:

1. **Wake** on an alarm (celld's only timer).
2. **Recall** prior state from its own SQLite.
3. **Take one bounded step** — call the LLM over plain outbound `fetch` (any provider).
4. **Persist** the result back to SQLite.
5. **Re-arm** the alarm, then **hibernate** to near-zero idle cost.

You bring whichever model you like. There is no `env.AI` to couple you to one model, and no edge to couple you to one cloud.

The center of the design is restraint: Protein is the **small, bounded agent celld is actually good at** — and explicitly *not* the giant exploratory brain other frameworks try to be. A protein is a small folded unit, not an organism.

See [`IDEA.md`](./IDEA.md) for the vision and [`RUNTIME.md`](./RUNTIME.md) for the exact base-class contract.

## Why "Protein"

A cell makes proteins: cheap, specialized, short-lived functional units it expresses on demand, each folded to one specific job. celld's runtime primitive *is* the cell; Protein is the framework for the thing that cell produces to actually do work. The name is also a sizing warning: a protein is a small folded unit, not an organism — which is the whole point.

## Status

**Concept / pre-build.** No code yet. This repository currently holds the design, the runtime contract, and the market/feasibility analysis. The first implementation milestone is the base class in [`RUNTIME.md`](./RUNTIME.md) against the verified celld API.

## Reality check (read this before betting on it)

The market research in [`NOTES.md`](./NOTES.md) is deliberately blunt:

- **The durable-actor-for-agents idea is not novel.** [Restate](https://github.com/restatedev/restate) and [Rivet](https://github.com/rivet-gg/rivet) already ship self-hosted, stateful single-writer actors with durable timers and are far more mature, multi-maintainer, and explicitly agent-first.
- **celld is a very young foundation.** Effectively bus-factor-1 (Ryan Dahl), PRs-by-email governance, and its S3-no-consensus coordination model is publicly disputed on correctness. Protein inherits that risk wholesale.
- **The defensible wedge is narrow.** What is genuinely unique: celld is the only *distributed, self-hosted, Cloudflare-DO/Workers-API-compatible* runtime (existing DO agents port with little change), plus the opinionated bounded-agent framing. Both are real but easily copied.

Protein's success depends on celld maturing (or on Protein staying portable) far more than on any feature Protein itself ships. The single most important early decision is therefore a **portable actor interface** so agents can retarget Restate / Rivet / workerd if celld stalls. See [`QUESTIONS.md`](./QUESTIONS.md).

## Repository layout

| File | Purpose |
|---|---|
| [`IDEA.md`](./IDEA.md) | Vision, thesis, design principles, what Protein is *not* |
| [`RUNTIME.md`](./RUNTIME.md) | The runtime contract: base class, DNA schema, the re-arm rule |
| [`CLAUDE.md`](./CLAUDE.md) | How to work on this codebase (celld constraints, conventions, gotchas) |
| [`NOTES.md`](./NOTES.md) | Technical reference + competitive landscape + risks |
| [`QUESTIONS.md`](./QUESTIONS.md) | Open questions to resolve before/while building |
| [`LOG.md`](./LOG.md) | Chronological work log |

## Origin

Protein was conceived during an exploration of [Wire](https://github.com/) (a zero-weight browser agent) on top of celld. The conclusion there: celld is a poor home for Wire's *heavy exploratory loop*, but an excellent home for *small, bounded, scheduled action agents*. Protein generalizes that into a framework.
