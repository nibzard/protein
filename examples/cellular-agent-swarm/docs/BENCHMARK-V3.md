# Artifact Benchmark v3

`sorted-unique-int32/v3` is the active artifact task for new live swarm
experiments. Historical `sorted-unique-int32/v2` source and hidden cases remain
available in `artifact-task-v2.mjs` and `artifact-hidden-v2.mjs`; completed v2
evidence is never relabeled or rescored as v3.

## Correctness contract

Candidate source must export `solve(values)` without imports. For any array of
signed 32-bit integers it must return every distinct value exactly once in
ascending numeric order. Correctness gates performance:

1. the public executor runs seven explicit public cases;
2. every performance workload is checked against a trusted reference result;
3. the separate evaluator repeats those gates with eight additional hidden
   cases;
4. a candidate receives score zero unless every required gate passes.

The public projection may report aggregate gate counts and the four public
workload names. Hidden case inputs, names, expected values, and per-case
results remain evaluator-private.

## Deterministic workload regimes

Every candidate is measured on four 24,000-item workload families:

| Regime | Workload |
|---|---|
| `ordered-duplicates` | Ascending values with repeated runs. |
| `short-disorder` | Mostly ordered values with deterministic local swaps. |
| `duplicate-heavy` | Unsorted values drawn from a narrow domain. |
| `wide-range` | Unsorted signed-int32 values across the full range with sparse duplicates. |

The task records a fixed seed per regime. The deterministic generator derives
a different input for every warmup and measured round, so every candidate sees
the same workload sequence without repeatedly timing one cacheable array.

## Timing and score

The locked-down sandbox performs two untimed warmups per regime. It then
interleaves nine measured rounds across the four regimes. Input creation,
reference calculation, result comparison, and serialization are outside the
timed interval; only `solve(values)` execution is timed.

For each regime, evidence records the minimum, 25th percentile, median, 75th
percentile, maximum, and throughput derived from the median. The authoritative
score is the rounded geometric mean of the four per-regime median throughputs:

```text
regime throughput = input items / median execution milliseconds
score = round(geometric mean of all regime throughputs)
```

The geometric mean keeps one unusually fast workload from dominating the
other regimes. It is still a local runtime benchmark, not a machine-independent
unit. Comparative trials must use the same resolved container image and host,
report each regime separately, repeat whole conditions, and predeclare their
tie and meaningful-effect thresholds.

## Evidence shape

Successful public and hidden evidence includes a bounded benchmark object:

```json
{
  "protocol": "protein-swarm-multi-regime-median/v1",
  "warmupRounds": 2,
  "roundsPerRegime": 9,
  "aggregate": {
    "statistic": "geometric-mean-regime-throughput",
    "score": 12345,
    "throughputItemsPerMs": 12345
  },
  "regimes": [
    {
      "id": "ordered-duplicates",
      "inputItems": 24000,
      "rounds": 9,
      "medianMs": 1.5,
      "minMs": 1.4,
      "p25Ms": 1.45,
      "p75Ms": 1.6,
      "maxMs": 1.8,
      "throughputItemsPerMs": 16000
    }
  ]
}
```

The actual object contains one entry for each of the four regimes. Receivers
validate the protocol, regime order and sizes, round counts, quantile ordering,
and aggregate shape before accepting the score.
