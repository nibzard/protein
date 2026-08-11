# Peer review versus self-review

Comparison `maintenance-compare-20260810161902332-1509133` completed on August 10, 2026.

## Result

Peer review won zero paired trials, lost one, and tied two. This sample does not show a peer-review quality advantage.

| Condition | Arms passed | Provider calls | Actual tokens | Final cases | Hidden tasks |
| --- | ---: | ---: | ---: | ---: | ---: |
| Clockwise peer review | 2 / 3 | 36 | 29,587 | 82 / 84 | 11 / 12 |
| Isolated self-review | 3 / 3 | 36 | 29,973 | 84 / 84 | 12 / 12 |

Each arm used four durable cells, three `gpt-5.6-luna` Responses calls per cell, and a 1,400-token output cap per call. The same four tasks, checks, restart procedure, and condition-independent runner were used. Condition order alternated across three pairs. All 72 expected provider response IDs are present in the receipts.

Actual token use was nearly equal: peer review used 386 fewer tokens in aggregate. The paired token differences were +233, -408, and -211 tokens. The quality result is therefore not explained by a larger peer-review call budget.

## The important failure

All 24 initial implementations across both conditions passed every case before review. In peer trial 1, the retry-delay cell reviewed a correct duration parser and requested exact decimal arithmetic for hypothetical precision cases. The author followed that advice, producing a more complicated revision that failed its public `1.5m` case and hidden `1h` case. The workflow recorded the failed public evidence but still allowed the revision to replace the passing artifact.

Local critique created work and confidence, but no new task evidence. The missing system primitive is a monotonic acceptance gate: a revision must not displace its parent when it fails already-established checks. Reviews should be treated as proposals, not authority.

## Claim boundary

This is a small synthetic repository workload with three paired trials. It isolates reviewer identity—neighbor versus self—under matched call and maximum-output budgets. It does not establish that peer review is generally harmful or that multi-agent systems cannot help. It does show that this peer-review design added no measured value here and can regress correct work without a runtime-enforced acceptance rule.

Machine-readable evidence is at [comparison.json](</home/agent/protein/.protein/repo-maintenance/comparisons/maintenance-compare-20260810161902332-1509133/comparison.json>).
