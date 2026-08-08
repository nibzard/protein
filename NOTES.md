# NOTES — technical reference & landscape

Detailed reference behind `README.md` / `IDEA.md` / `RUNTIME.md`. The full list of celld constraints and gotchas lives in [`CLAUDE.md`](./CLAUDE.md); this file covers design rationale, the competitive landscape, and risk.

## Design decisions & rationale

- **One cell per agent, not one cell per step.** A cell is the durable identity and memory; steps are alarm wakes *within* it. Splitting per-step would throw away the single-owner guarantee and the private SQLite that make the model cheap.
- **Alarms over a long loop.** celld's workers are short-lived and bounded; `setInterval` throws. Pacing across alarms turns a long agent into many cheap, inspectable, resumable units — and lets the cell hibernate between them.
- **DNA as SQLite, not a KV bag.** A relational schema gives queryable, inspectable memory (messages, events, artifacts-metadata) for free. KV is available as the fallback for singletons.
- **`translate()` is provider-agnostic and lives in the subclass.** No `env.AI` exists on celld; even if it did, binding the model would be lock-in we explicitly reject. The base class never imports a provider.
- **No blobs in the cell.** R2 is unusable from a Worker on celld. Artifacts are metadata + hash in SQLite; bytes live in an external object store the caller owns. This is a hard constraint, not a preference.
- **Portable interface from day one.** Every celld-coupling sits behind `ProteinDna` (and a future `ActorRuntime`). The single biggest project risk is celld's maturity; the mitigation is a swappable backend.

### Open design tensions (not yet resolved)

- **Multi-cell composition.** Planner/worker over named cells is possible and idiomatic, but cross-cell ordering is the application's job (celld gives single-cell serialization, not cross-cell). v1 stays single-cell; a composition layer is post-v1.
- **Fleet primitives.** Concurrency, fairness, rate limits (Hatchet's strength) are absent. v1 is explicitly single-agent / small-fleet.
- **Durability window.** A Worker cannot observe when LTX replication to S3 completes. The re-arm rule assumes prompt replication; we have not yet measured data loss under failure. See [`QUESTIONS.md`](./QUESTIONS.md).

## Competitive landscape (market research, Aug 2026)

The durable, self-hosted agent space splits into four layers. Protein lives in layer 2.

1. **Heavyweight durable-execution platforms** — Temporal (~22k★, MIT), Windmill. Mature, cluster-based, shared DB, general-purpose. Operationally heavy; over-engineered for a bounded agent.
2. **Lightweight durable-actor / step runtimes** — **Restate**, **Rivet**, DBOS, Inngest, Trigger.dev, Hatchet. Single-binary or library-shaped, minimal infra. **This is Protein's neighborhood.**
3. **Agent frameworks** — LangGraph, Letta (MemGPT), Mastra, CrewAI, AutoGen, Agno, PydanticAI. Supply agent logic but assume an external durable home + scheduler you operate.
4. **Sovereign/enterprise platforms & DIY** — Palantir AIP, Lyzr (packaged, accredited, lock-in); Dify/n8n (self-hosted app platforms); DIY Ollama+vLLM+Postgres+framework.

### Closest peers

| Peer | Self-hosted | Durable state | Where Protein wins | Where they win |
|---|---|---|---|---|
| **Cloudflare Agents SDK** | No (edge only) | Per-agent DO SQLite, hibernates | Self-hosted, no account, no `env.AI`, model-portable | Mature SDK, edge network, ecosystem |
| **Restate** | Yes (BSL→Apache) | Virtual Objects (single-writer) + journal, no DB | Relational SQLite vs opaque KV; CF-DO-API compat; bounded-agent opinion | Far more mature, agent-first, multi-language, Restate Cloud |
| **Rivet** | Yes (Apache-2.0) | Per-actor durable state + durable execution | Lighter; CF-DO-API portable | Most mature self-hosted DO-for-agents (~5.9k★), multi-maintainer, observability |
| **Temporal** | Yes (MIT) | External shared DB, sharded by workflow id | Small bounded agent, per-agent private SQLite, no cluster | Battle-tested, polyglot, huge ecosystem |
| **LangGraph** | Yes (bring your own) | Checkpoints you wire (Postgres/Redis) | Protein *is* the durable single-owner home LangGraph assumes | Graph ecosystem dwarfs celld's |
| **Letta (MemGPT)** | Yes (run server + Postgres) | Self-editing memory blocks | Hibernating self-contained cell, no DB to run | Superior memory model, sleep-time compute |

### The wedge (honest)

The capability combination Protein advertises is **largely already delivered** by Restate and Rivet, which are far more mature. What is genuinely unique is thin:

1. celld is the only **distributed, self-hosted, Cloudflare-DO/Workers-API-compatible** runtime — existing DO/Workers agents port with little change (`workerd` is single-process only; Restate/Rivet have their own APIs).
2. The opinionated **"small bounded agent, not a giant loop"** framing.

Both are real but easily copied, and both sit on a very young foundation. Net: a narrow niche on an unproven substrate, not a wide-open category.

### Demand signals (who wants this)

- **Regulated / sovereignty** (strongest): EU AI Act Article 10 + GDPR/HIPAA drive on-prem, auditable-agent demand. Cleanest wedge — durable, inspectable, self-hosted, every wake a SQLite row.
- **Cost / "agent tax"**: enterprises alarmed by per-run/per-seat markup on managed agent platforms; Protein's bounded self-hosted model attacks that.
- **Model portability**: "vendor lock-in at the model layer is harder to unwind than at the agent layer"; `fetch`-only/no-`env.AI` aligns precisely.
- **BYO-Cloud**: practitioner demand (calv.info "Durable Objects are Made for Agents"; celld HN thread) to run the DO-agent model outside the Cloudflare account — Protein's most specific opening.

Ideal buyer: an engineering team in fintech/legal-tech/health-tech (or a sovereignty-first EU org) that has *already decided* self-hosted-no-lock-in is the requirement and is choosing between Restate, Temporal, a DIY stack, or hand-rolling on Cloudflare — not the enterprise buyer who needs a packaged UI/RBAC/certs (that buyer goes to Lyzr or Palantir).

## Top risks

| Risk | Severity | Mitigation |
|---|---|---|
| celld is bus-factor-1 (~1 week old, PRs-by-email, no community plumbing) | **High** | Portable interface; isolate celld code; cultivate upstream relationship with Ry; document an off-celld migration path from day one |
| celld's S3-no-consensus correctness is publicly disputed (Kleppmann-style critique on HN) | **High** | Independent correctness writeup; chaos/failover/partition tests that measure data loss; keep LTX exports as an escape hatch; market the failure model honestly |
| Restate + Rivet already own self-hosted durable-actor-for-agents at maturity | **High** | Do not compete on generic durable execution. Compete narrowly on CF-DO-API compat + bounded-agent opinion; consider Restate/Rivet as *backends* via the portable interface |
| "Bounded agent" is a convention, easily copied | Medium | Make it structural: bounded-step policy + durable file-based skills + evidence-backed runs (the Wire pattern) baked into the DX |
| Missing fleet primitives (concurrency/fairness/observability) | Medium | Scope v1 to single-agent/small-fleet; build minimal observability on celld primitives; communicate bounded scope as the product |
| Most defensible demand (sovereign/defense) routes to accredited vendors | Medium | Target regulated-but-open segment (fintech/legal/health) where auditable self-hosted agents suffice without government accreditation |

## Source notes

Competitive and demand claims are directional, gathered Aug 2026 from official docs/GitHub plus practitioner posts and HN threads; vendor "rankings" and price tiers come from SEO-shaped comparison sites and should not be read as hard adoption data. Full source list is in the market-research transcript; key references: calv.info (Durable Objects are Made for Agents), the celld HN thread (id 49185430), Restate/Rivet/Temporal docs, Rasa/Lyzr/NeuralTrust sovereignty writeups.
