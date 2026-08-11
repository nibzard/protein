# Prototype measurements

These measurements are development evidence, not capacity guarantees.

## Environment

- Date: 2026-08-09
- CPU allocation: 4 cores, 12th Gen Intel Core i9-12900HK
- Memory: approximately 11.7 GiB
- celld: `0.1.0`
- Bucket: local MinIO over loopback
- Celld node lease in the harness: 2 seconds
- Fleet activation concurrency: 32

Local MinIO removes real object-store latency. Production S3 behavior will be
slower and more variable.

## Semantic run

The clean-room harness creates a new bucket and validates:

- Cloudflare Agent state, schedule, WebSocket, and restart recovery;
- Protein event deduplication and conflict detection;
- one committed external executor action and receipt;
- no second logical executor job after duplicate run submission;
- RepoAgent recovery from a fresh local celld cache;
- cold activation of distinct named Protein cells.

Observed final successful run:

| Measurement | Result |
|---|---:|
| Cloudflare probe recovery after node restart | 1.95 s |
| RepoAgent in-flight action and node recovery | 1.63 s |
| Protein cells requested | 1,000 |
| Protein cells successfully activated | 1,000 |
| Fleet activation elapsed | 19.46 s |
| Peak celld RSS across the run | 3,459 MiB |

The recovery time reflects the deliberately shortened two-second test lease.
Default celld ownership TTL is longer.

## Bundle comparison

| Worker | Bundled size | 1,000-cell outcome |
|---|---:|---|
| Cloudflare Agents-based RepoAgent prototype | ~1.7 MB | Interrupted after celld reached ~9.9 GB RSS and requests timed out under pressure. |
| Minimal Protein RepoAgent | 34.2 KB | 1,000/1,000 activations completed in 19.46 s; peak celld RSS was 3,459 MiB. |

The currently built RepoAgent is 40.0 KB after adding reconciliation and proof
hooks. The table retains the bundle measured during the recorded 1,000-cell
run; the new build has only been regression-tested at 100 cells.

This is roughly a 50× bundle-size reduction. Resident memory is not determined
by bundle bytes alone, but the failed comparison was strong enough to reject
the full SDK as Protein's deployable base.

## Reproduce

```sh
CELLD_BIN=/path/to/celld \
PROTEIN_FLEET_SIZE=1000 \
npm run test:celld
```

The current harness also samples celld RSS and prints `peakCelldRssMb`. Results
should be compared only when celld version, machine limits, object store,
concurrency, deployment, and fleet size are recorded together.

## Measurements still required

- peak and steady-state RSS after forced hibernation;
- resident bytes per minimal cell across several state sizes;
- warm request latency and durable-write latency against real S3/R2;
- repeat the completed two-node ownership test after an upstream celld fencing
  fix and under realistic bounded NTP drift;
- quantify duplicate action frequency statistically; the deterministic suite
  already proves duplicates are possible at four post-dispatch crash points;
- 10,000-cell sparse workload with heterogeneous alarms;
- bucket request counts and storage growth per cell;
- WebSocket reconnect behavior across owner movement.
