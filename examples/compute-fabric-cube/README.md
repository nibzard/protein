# Durable agentic compute fabric

This experiment implements the `3×3×3` cube described in
[NEXT-CUBE.md](../../NEXT-CUBE.md). Twenty-seven Protein cells form nine domain
columns and three responsibility layers:

- triage cells observe, deduplicate, correlate, and route work;
- execution cells use Luna or isolated Linux sandboxes to produce artifacts;
- verification cells run hidden evaluators, resolve conflicts, and issue
  durable acceptance receipts.

The cube is a systems demonstration, not only a swarm intelligence benchmark.
It measures durable identity, heterogeneous compute escalation, asynchronous
relationships, provenance, recovery, duplicate suppression, hibernation, and
resource use.

## Frozen workload

`fabric-config.json` defines 12 coupled repository incidents, the 27-cell
topology, model and executor budgets, controlled faults, and success criteria.
It is frozen before model calls. Four code repairs use the existing maintenance
fixture and public/hidden evaluators; dependent reports create deduplication,
documentation, security, migration, and integration relationships.

## Compute tiers

| Tier | Execution boundary |
| --- | --- |
| `cell` | Durable SQLite transition inside FabricCell |
| `model` | Bounded OpenAI Responses function call |
| `bounded` | Narrow authoritative hidden evaluator |
| `sandbox` | Networkless, read-only, resource-limited Linux container |

This experiment constructs globally unique Protein action IDs and uses them to
reconcile every external request. Every completion returns a resource-accounted
receipt and content-addressed artifact. Shared framework adapters must enforce
the broader operation-key namespace defined in
[ARCHITECTURE.md](../../ARCHITECTURE.md).

## Run

```sh
npm run fabric:build
FABRIC_RUNTIME_MODE=mock CELLD_BIN=/path/to/celld npm run fabric:run
CELLD_BIN=/path/to/celld npm run fabric:run
npm run fabric:audit
npm run fabric:logs
```

The mock rehearsal uses deterministic model decisions but real celld, MinIO,
Docker sandboxes, evaluators, restart, and fault injection. The live run uses
`gpt-5.6-luna` through the OpenAI Responses API.

Each evidence directory under `.protein/compute-fabric/runs/` contains:

- `summary.json`: complete metrics, cell snapshots, receipts, and decisions;
- `timeline.jsonl`: replayable run milestones;
- `receipts.jsonl`: capability and cell-local receipts;
- `provenance.json`: artifact lineage and typed relationships;
- `celld-audit.json`: categorized runtime restores, hibernation starts,
  warnings, and errors;
- executor and celld logs;
- `LEARNINGS.md`.

See [RESULT.md](./RESULT.md) for the first measured live run.
