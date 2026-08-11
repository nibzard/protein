# Protein

> A minimal celld-native runtime for named, durable agent actors.

Protein turns one celld cell into one long-lived agent identity. The cell owns
compact state, a deduplicated event inbox, durable runs, an action outbox,
receipts, an alarm, and hibernatable client connections. Model calls and tools
are application choices; shell, Git, browser, and large-artifact work run behind
external executor APIs.

This repository now contains working code. It is an experimental prototype, not
a production-ready agent platform.

## Documentation map

- [ARCHITECTURE.md](./ARCHITECTURE.md) is the evidence-backed Protein
  Architecture v1 and the authority for system boundaries and maturity.
- [RUNTIME.md](./RUNTIME.md) describes the exact `src/` lifecycle contract.
- [PROOFS.md](./PROOFS.md) records verified failure behavior and the current
  production boundary.

## Why this shape

Celld gives every named cell private SQLite, intended single-owner routing, HTTP/RPC,
hibernatable WebSockets, outbound `fetch`, and one durable alarm. It does not
give a cell a filesystem, subprocesses, a blob service, a queue service, or a
durable workflow engine.

The native agent is therefore an event-driven actor rather than a persistent
process:

```text
chat · webhook · alarm · tool result
                  │
                  ▼
          ProteinAgent(name)
  ┌────────────────────────────────┐
  │ state · events · runs          │
  │ action intents · receipts      │
  │ journal · WebSocket clients    │
  └────────────────────────────────┘
           │              │
           ▼              ▼
       model API     executor/tool API
```

One cell should map to one unit of independently addressable memory and logical
application authority: a user, repository, service, customer account, device,
room, or similar entity. Runs live inside that identity. Model execution stays
external; the associated action, compact receipt, and durable history belong
to the cell.

## What is implemented

- `ProteinAgent`, a small Durable Object base class;
- canonical event IDs with duplicate acceptance and payload-conflict detection;
- durable run records and application-selected status updates;
- revision-fenced event and action claims;
- action intent committed before external dispatch;
- three action safety classes, with unsafe effects outside the supported
  automatic-effect boundary;
- durable receipts plus explicit `ambiguous` outcomes;
- application retries and lease recovery driven by the cell's one alarm;
- a per-cell journal and inspection APIs;
- hibernatable WebSocket connection and state frames;
- a RepoAgent reference whose executor is an external HTTP capability;
- a clean-room celld integration harness using a real S3-compatible bucket.

The central transition is:

```text
event → claimed revision → decision → committed action intent
      → external result → durable outcome event
```

Protein does not claim exactly-once external execution. An idempotent receiver
can safely accept retries, and a reconcilable receiver can be queried before
dispatch. Hard-crash testing showed that celld can recover bucket state from
before Protein's local dispatch marker, so Protein cannot guarantee that an
inherently unsafe receiver becomes `ambiguous` instead of being called again.

## Verified baseline

The integration harness currently pins celld `0.1.0` and Cloudflare
`agents@0.20.1`.

- Cloudflare Agent state, schedules, WebSockets, and bucket-backed restart
  recovery work on celld after a required prebundle workaround.
- Cloudflare Agents `queue()` is not safe for celld async work: it starts a
  detached flush, so an awaited outbound call can be abandoned when the handler
  ends. Protein uses its own alarm-backed inbox/outbox instead.
- The full Cloudflare Agents probe bundle is about 1.7 MB. The RepoAgent built
  on Protein is 40.0 KB with the proof and reconciliation hooks included.
- The final clean-room suite activated 1,000/1,000 distinct Protein cells in
  19.46 seconds with 3,459 MiB peak celld RSS on the recorded development
  machine. See
  [BENCHMARKS.md](./BENCHMARKS.md) for conditions and limits.

These are prototype observations, not general service-level guarantees.

The new fault suites also produced two negative results that define the current
production boundary:

- the deterministic action matrix passed 10/13 cases; all idempotent and
  reconcilable cases converged, while unsafe protection failed at the committed
  dispatch marker and both later dispatch points;
- a two-node stale-owner test reproduced simultaneous A/B authority and dual
  dispatch under a 9-second wall-clock offset with a 12-second lease. External
  idempotency reduced the two requests to one logical job, and healed state
  converged.

See [PROOFS.md](./PROOFS.md) for the exact checkpoints, topology, results, and
interpretation. Given the ownership and hard-recovery failures, Protein is not
a safe primary controller for high-stakes effects on the tested release.

## Run it

```sh
npm install
npm run check
npm run example:build
```

The real celld test requires Docker and a celld v0.1.0 binary:

```sh
CELLD_BIN=/path/to/celld npm run test:celld

# Exercise the high-cardinality premise.
CELLD_BIN=/path/to/celld \
PROTEIN_FLEET_SIZE=1000 \
npm run test:celld
```

The harness creates an isolated MinIO container and bucket, deploys the
Cloudflare compatibility probe, tests state/schedules/WebSockets/restart,
deploys RepoAgent, tests deduplication/actions/restart, activates the requested
fleet, and removes its temporary infrastructure.

The fault-injection suites additionally require GCC for the clock-offset shim:

```sh
# These exit non-zero while a safety invariant is falsified.
CELLD_BIN=/path/to/celld npm run test:proofs

# Run both suites and print all known pass/fail evidence with exit zero.
CELLD_BIN=/path/to/celld \
PROTEIN_PROOF_ALLOW_FAILURES=1 \
npm run test:proofs
```

## RepoAgent example

RepoAgent keeps durable control state in celld while an external executor owns
the checkout and command environment:

```sh
curl -X POST http://127.0.0.1:18080/agents/acme-api/runs \
  -H 'content-type: application/json' \
  -d '{
    "id": "run-1",
    "goal": {
      "repository": "acme/api",
      "task": "repair the failing tests"
    }
  }'
```

Submitting the same run ID and equivalent goal is idempotent. Reusing the ID
with different content returns a conflict. See
[examples/repo-agent](./examples/repo-agent/README.md).

## Cellular Agent Swarm demo

The swarm example has a real celld-native smoke path. It deploys a 4 x 4
population of named `SwarmCell` Protein agents, drives three generations
through celld, restarts celld after generation one, and writes a complete
evidence bundle with per-cell state, actions, journals, process logs, latency,
and RSS samples.

```sh
CELLD_BIN=/path/to/celld npm run swarm:celld
```

This path uses deterministic mock model/executor/board capabilities so it tests
celld and Protein rather than model quality. It must not be cited as evidence
that a swarm learns or beats a baseline. Each run is stored under
`.protein/cellular-agent-swarm/celld-runs/`.

## Durable compute-fabric cube

The `3×3×3` compute-fabric example uses 27 Protein identities to process a
frozen stream of coupled repository incidents. Its deterministic runner assigns
work across cell-local, `gpt-5.6-luna`, bounded-evaluator, and isolated-Linux
tiers; cells durably execute and reconcile those assignments. The measured run
includes hibernation, celld restart with five actions outstanding, duplicate
delivery, sandbox termination, evaluator denial, hidden tests, conflict
resolution, and replayable artifact provenance. It validates heterogeneous
capability plumbing, not autonomous tier selection or decentralized routing.

```sh
FABRIC_RUNTIME_MODE=mock CELLD_BIN=/path/to/celld npm run fabric:run
CELLD_BIN=/path/to/celld npm run fabric:run
npm run fabric:audit
npm run fabric:logs
```

See [the experiment README](./examples/compute-fabric-cube/README.md) and
[first live result](./examples/compute-fabric-cube/RESULT.md).

## Cellular swarm comparisons

The live paired path uses `gpt-5.6-luna` through the OpenAI Responses API to
compare matched 4 x 4 local and isolated populations over four generations. It
uses equal configured ceilings, alternates condition order, retains every
attempt, and records actual consumption separately:

```sh
CELLD_BIN=/path/to/celld npm run swarm:compare
```

It requires an `OPENAI_API_KEY` supplied through the environment and can incur
meaningful API cost. The first three-pair evidence bundle produced one local
win, one isolated win, and one tie: no repeatable quality advantage was
observed. Local did use fewer recorded tokens, model turns, tools, evaluations,
and elapsed time in all three pairs, a secondary result that needs replication.

The preregistered follow-up measures discovery cost to a fixed, repeatedly
verified 3×-seed quality target over ten matched pairs. It uses conservative
right-censoring and a single frozen control fingerprint across all runs:

```sh
CELLD_BIN=/path/to/celld npm run swarm:cost-target
```

This command is live and potentially expensive. See
[the fixed-quality preregistration](./examples/cellular-agent-swarm/docs/COST-TO-TARGET.md)
before running it. The completed Luna pilot and its retained-attempt integrity
finding are documented in
[the result note](./examples/cellular-agent-swarm/docs/COST-TO-TARGET-RESULT.md).

Serve a read-only projection of the latest real run bundle:

```sh
npm run swarm:dev
```

Open <http://127.0.0.1:8788/celld.html>. It shows the paired verdict when one is
available, plus recovered cell state, action counts and latency, generation
timing, restart recovery, RSS, runtime warnings, milestones, and the captured
celld log tail. The report does not start celld or mutate the bundle.

The root page at <http://127.0.0.1:8788/> remains an explicitly labelled
scripted scenario. It does not invoke celld, Protein cells, an LLM, or external
code execution.
See [examples/cellular-agent-swarm](./examples/cellular-agent-swarm/README.md)
for the evidence levels and artifact layout.

## Project boundary

Protein is not a workflow engine, sandbox, model SDK, vector store, fleet
control plane, or global database. A normal service is better for continuously
active work; a workflow engine is better for finite multi-step pipelines; cron
plus a database is better for a small number of scheduled checks.

Protein is promising only when these conditions occur together:

1. many independently named agents;
2. compact per-agent state;
3. sparse or intermittent activity;
4. events for one identity need coordinated decisions;
5. self-hosting or customer-controlled infrastructure matters.

Current celld is alpha and requires operator-provided ingress, TLS,
authentication, private networking, secrets, monitoring, and upgrade policy.
See [QUESTIONS.md](./QUESTIONS.md) before considering sensitive workloads.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — current architecture decisions, boundaries, guarantees, and open mechanisms
- [PROTEIN-RESEARCH-REPORT.html](./PROTEIN-RESEARCH-REPORT.html) — visual research and architecture decision report
- [IDEA.md](./IDEA.md) — product thesis, use cases, and rejection criteria
- [CELLULAR-AGENT-SWARM.md](./CELLULAR-AGENT-SWARM.md) — locally connected agent experiment vision
- [examples/cellular-agent-swarm](./examples/cellular-agent-swarm/README.md) — celld-native swarm smoke run and scripted scenario
- [examples/repo-maintenance-swarm](./examples/repo-maintenance-swarm/README.md) — durable Luna agents authoring, reviewing, and verifying repository repairs
- [examples/formal-protocol-swarm](./examples/formal-protocol-swarm/README.md) — layered durable agents repairing and proving a crash/retry protocol with SMT
- [RUNTIME.md](./RUNTIME.md) — implemented lifecycle and failure semantics
- [COMPATIBILITY.md](./COMPATIBILITY.md) — Cloudflare Agents/celld evidence
- [BENCHMARKS.md](./BENCHMARKS.md) — measured prototype results
- [PROOFS.md](./PROOFS.md) — crash matrix and two-node ownership evidence
- [QUESTIONS.md](./QUESTIONS.md) — unresolved blockers
- [CASE-LIBRARY.md](./CASE-LIBRARY.md) — historical 100-use-case exploration
