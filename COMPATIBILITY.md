# Celld and Cloudflare Agents compatibility

Tested on 2026-08-09 with:

- celld `0.1.0`, commit `553ae73`;
- Cloudflare `agents@0.20.1`;
- Node `24.18.0` and esbuild `0.28.x`;
- MinIO as the S3-compatible fleet bucket.

The executable probe is under `probes/cloudflare-agents/`. The clean-room
harness is `scripts/celld-e2e.mjs`.

## Result

Cloudflare Agents is useful prior art and partially executable on celld, but it
is not currently a drop-in celld agent framework.

| Surface | Result | Evidence / boundary |
|---|---|---|
| Base Agent construction | Pass with prebundle | The agent activates as a SQLite Durable Object. |
| Persistent `state` / `setState` | Pass | Count survived a fresh celld node and local cache. |
| Direct SQL | Pass | Agent internal schema and state rows worked. |
| Durable schedules | Pass | A one-second callback ran through the cell alarm and persisted state. |
| Hibernatable WebSockets | Pass | Identity, state, custom connect, and echo frames were observed. |
| Alarm-backed async callback | Pass | Scheduled callbacks can await outbound I/O. |
| `queue()` with awaited outbound I/O | **Fail** | `queue()` launches `_flushQueue()` as detached work. Celld allowed the synchronous claim, ended the handler, and abandoned the pending fetch; the action stayed `delivering`. |
| Sub-agents/facets | Unsupported | Current Agents sub-agents require `ctx.facets`; celld does not expose it. |
| Workflows | Unsupported | Celld lists Workflows as planned, not implemented. |
| Email and managed platform tools | Unsupported | Celld does not provide Cloudflare Email, Browser, Workers AI, R2, or related services. |
| Full SDK fleet footprint | Poor | The prebundled probe is about 1.7 MB and the interrupted 1,000-cell activation reached about 9.9 GB RSS on the test host. |

The Protein crash test also verified that action lease expiry can cause
overlapping remote requests while the first call is still in flight. The mock
executor's stable per-cell action ID collapsed them to one job. This is why
action idempotency remains mandatory even under a single cell owner. A shared
executor additionally requires the cross-cell operation namespace specified in
[ARCHITECTURE.md](./ARCHITECTURE.md).

The deterministic hard-crash suite goes further: a fresh celld process can
restore state from before a completed local action transaction. Eight
idempotent crash points and one reconcilable acceptance case converged, but
unsafe protection failed at the dispatch marker and two later points. The
two-node suite also reproduced
simultaneous owners under a stale-owner partition and wall-clock offset. These
are failed celld/Protein safety invariants, not Cloudflare Agents compatibility
results; the exact evidence is in [PROOFS.md](./PROOFS.md).

## Packaging workaround

Direct `celld deploy` from the probe TypeScript failed during bundling because
the Agents dependency graph selected `mimetext`'s Node build, which imports the
bare `path` module. Celld externalizes `node:*`, not the bare specifier.

The probe prebundles with:

```sh
esbuild probes/cloudflare-agents/worker.ts \
  --bundle \
  --format=esm \
  --platform=neutral \
  --target=es2022 \
  --main-fields=module,main \
  --conditions=workerd,worker,browser \
  --external:cloudflare:* \
  --external:node:* \
  --alias:path=node:path \
  --outfile=probes/cloudflare-agents/dist/worker.js
```

Celld then deploys the generated module successfully.

This workaround is a probe result, not a recommended production dependency
strategy. Importing the package root also exposes unsupported features and
produces a large bundle.

## Why Protein does not extend Cloudflare Agent

The first implementation did extend `Agent` and passed a complete single-agent
RepoAgent run after replacing `queue()` with schedules. The high-cardinality
test then invalidated that choice: the full SDK bundle exhausted the available
memory before 1,000 resident cells completed activation.

Protein now extends the Workers `DurableObject` class directly and implements
only its required event, run, action, alarm, journal, and WebSocket semantics.
The original minimal RepoAgent bundle was 34.2 KB and completed the same
1,000-cell test. The current bundle is 40.0 KB after adding authoritative
reconciliation and deterministic proof checkpoints.

## Upstream opportunities

Potential upstream work should be discussed rather than hidden in Protein:

- make Agents package entrypoints modular so core state/schedule/WebSocket code
  does not import email, MCP, facets, and platform tools;
- make queue flushing explicitly event-lifetime-bound or alarm-backed;
- publish a Durable Objects-only compatibility profile;
- add celld conformance tests for the subset that claims compatibility.

Until then, Protein treats Cloudflare Agents as a behavioral reference and
keeps the probe pinned separately from its production runtime.
