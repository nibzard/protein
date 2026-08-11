# Fixed-quality Luna experiment result

Run: `celld-swarm-cost-target-20260809213337751-3286792`

Completed: 2026-08-09

Protocol: 10 alternating matched pairs, 4x4 cells, four generations,
`gpt-5.6-luna`, low reasoning, one provider attempt per model action.

## Result

The confirmatory result is **incomplete**. One retained attempt in pair 3 had
one ambiguous provider attempt and the same baseline-drift block failed twice.
Its later clean operational retry cannot repair the pair under the frozen
rules. The authoritative rebuild therefore keeps 9 valid pairs, marks pair 3
invalid, and makes no confirmatory cost claim.

The nine valid pairs still provide useful descriptive evidence:

- both conditions reached the fixed verified-quality target in all 9 pairs;
- isolated won 7 non-tied pairs, local won 0, and 2 were within the 5% tie band;
- median local Responses-token cost at first verified reach was 26.50% higher;
- the deterministic 10,000-sample paired bootstrap interval was +2.22% to
  +74.95%; and
- the isolated-direction exact one-sided sign-test value was 0.0078125.

Those numbers describe the valid subset. They do not restore a preregistered
claim after a planned pair failed integrity.

| Pair | Valid | Local reach | Local tokens | Isolated reach | Isolated tokens | Local delta | Outcome |
| ---: | :---: | :---: | ---: | :---: | ---: | ---: | :--- |
| 1 | yes | G3 | 450,784 | G3 | 441,014 | +2.22% | tie |
| 2 | yes | G2 | 362,179 | G2 | 286,304 | +26.50% | isolated |
| 3 | no | censored | 567,658 | G2 | 323,087 | n/a | invalid |
| 4 | yes | G2 | 352,982 | G2 | 308,974 | +14.24% | isolated |
| 5 | yes | G4 | 573,938 | G2 | 328,062 | +74.95% | isolated |
| 6 | yes | G2 | 361,372 | G1 | 182,309 | +98.22% | isolated |
| 7 | yes | G2 | 322,855 | G2 | 327,350 | -1.37% | tie |
| 8 | yes | G2 | 336,226 | G2 | 298,611 | +12.60% | isolated |
| 9 | yes | G4 | 577,616 | G3 | 436,443 | +32.35% | isolated |
| 10 | yes | G3 | 479,712 | G2 | 327,080 | +46.67% | isolated |

## What we learned

Local exchange compressed the search but did not make it token-efficient.
Across the valid, cost-comparable pairs, local cells used a median 3.06% fewer
model requests, 7% fewer tool executions, 22.73% fewer public checks, 28% fewer
discovery evaluations, and 15.54% fewer output tokens. Yet local input tokens
were 30.24% higher. Neighbor context made fewer decisions substantially more
expensive.

The lineage evidence points to convergence rather than productive synthesis.
Across the nine valid pairs, local runs submitted 147 unique candidates versus
270 for isolated runs, ended with aggregate diversity 43 versus 142, and
recorded 306 adoptions but only one directly neighbor-derived improvement.
The current exchange mechanism mostly propagates candidates; it rarely turns
another cell's work into a distinct verified improvement.

There is a real tradeoff rather than a universal loser. Local runs had the
higher exploratory median final score (45,486 versus 43,886), required less
wall time, and used fewer tools and evaluations. The failure was specifically
the preregistered token cost to the first fixed-quality crossing. Full-run cost,
latency, final quality, and discovery-token cost answer different questions.

## Operational evidence

The 20 accepted runs contain 320 durable cells, 1,280 completed cell-generations
and submissions, 20/20 restart recoveries, zero redeliveries, zero runtime
errors, zero service failures, and zero HTTP 5xx responses. All 7,714 runtime
warnings were the known `peer-owner-unreachable` signal.

Accepted runs recorded 11,761,795 model tokens and 6,432 target-panel evaluator
calls. The discarded attempt adds 578,695 recorded tokens and 465 panel calls,
plus an unknown amount from its ambiguous provider request. Total operational
model spend is therefore at least 12,340,490 tokens.

All 21 attempts are retained and audited. The original automatic summary is
preserved as `summary.pre-integrity-audit.json`; the rebuilt `summary.json` is
deterministic and marks the comparison incomplete.

## Next experiment

Do not scale the current neighborhood mechanism yet. Run a fresh frozen
comparison that keeps the same evaluator and target but changes the
communication primitive:

1. isolated cells;
2. compact local exchange containing only artifact identity, verified ratio,
   and a bounded change note; and
3. role-routed exchange in which a cell must critique, merge, or test a
   neighbor artifact rather than merely adopt it.

Make input-token overhead, unique-candidate diversity, and genuinely
neighbor-derived verified improvements explicit secondary endpoints. Freeze
content hashes for the runner, evaluator, workload, analysis, and dashboard in
addition to the worker bundle. Run the all-attempt integrity audit before any
aggregate conclusion is emitted.

This remains one code-optimization task, one model, one host, and one protocol.
It demonstrates durable autonomous work and exposes a collaboration bottleneck;
it does not establish learning or a general advantage for isolated agents.
