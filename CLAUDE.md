# Contributor guide

## Project purpose

Protein is a minimal celld-native runtime for named durable agent actors. Keep
identity, compact state, event/run lifecycle, action intent, receipts, alarms,
and live connections in the cell. Keep shells, repositories, browsers, GPUs,
and large artifacts behind external capabilities.

## Commands

```sh
npm install
npm run typecheck
npm test
npm run check
npm run probe:build
npm run example:build

CELLD_BIN=/path/to/celld npm run test:celld
CELLD_BIN=/path/to/celld PROTEIN_FLEET_SIZE=1000 npm run test:celld
```

The celld test requires Docker. It creates and removes a uniquely named MinIO
container and temporary celld work directories.

## Layout

- `src/protein-agent.ts` — Durable Object runtime and SQLite lifecycle
- `src/types.ts` — public JSON/event/run/action contracts
- `examples/repo-agent/` — durable control plane plus HTTP executor contract
- `probes/cloudflare-agents/` — pinned upstream compatibility probe
- `scripts/celld-e2e.mjs` — clean-room integration and fleet harness
- `scripts/mock-executor.mjs` — idempotent non-shell executor fixture
- `test/` — fast Node unit tests

## Non-negotiable invariants

1. Persist event input before acknowledging it.
2. Deduplicate by stable ID and conflict on different content.
3. Never hold a SQLite transaction across model, network, or tool I/O.
4. Fence every awaited event/action result with a monotonic revision.
5. Commit action intent before external dispatch.
6. Keep the local action ID stable and namespace the receiver operation key by
   deployment, cell class, cell identity, and local action ID. The current base
   context exposes only the cell-local key.
7. Never claim exactly-once external execution.
8. Mark uncertain unsafe actions `ambiguous`; do not blindly retry them.
9. Multiplex all pending work and leases onto the one cell alarm.
10. Re-arm the alarm after every alarm activation while recoverable work remains.
11. Keep application state and receipts compact JSON; store large artifacts elsewhere.
12. Do not add the full Cloudflare Agents package to production bundles.

## Compatibility cautions

- The Cloudflare Agents package requires the prebundle flags in `package.json`.
- Its `queue()` detached flush is not compatible with awaited celld work in the
  tested versions.
- Facets, Workflows, Email, Browser, Workers AI, and R2 are not available on
  current celld.
- A new celld or Agents version must rerun the compatibility probe before docs
  are updated.

## Design discipline

Do not add a feature merely because an agent product might need it. Add it only
when it belongs to the per-cell lifecycle rather than an application harness,
executor, workflow engine, or fleet control plane.

When runtime behavior changes, update `RUNTIME.md`, `COMPATIBILITY.md`, the
clean-room test, and the decision log together.
