# Repository maintenance pilot result

Run `repo-maintenance-20260810160916699-1500881` passed on August 10, 2026.

Four durable Protein cells using `gpt-5.6-luna` each implemented one JavaScript repair, reviewed the clockwise neighbor's artifact, and revised their own artifact from the resulting typed review. Generated code ran in networkless, read-only, capability-dropped Docker sandboxes. A separate hidden evaluation ran after revision.

## Measured result

| Measure | Result |
| --- | ---: |
| Durable cells | 4 |
| Model jobs | 12 |
| Responses API tokens | 9,751 |
| Peer reviews | 4 |
| Reviews requesting changes | 2 |
| Public gates passed | 4 / 4 |
| Hidden gates passed | 4 / 4 |
| celld restart recovery | 2.28 s |

The artifacts covered Unicode slug normalization, case-insensitive HTTP header merging, duration parsing, and capped exponential retry delay. Two reviewers requested changes. All final revisions passed 28 combined public and hidden cases.

The full machine-readable evidence, artifacts, provider response IDs, token usage, cell identities, review verdicts, timeline, and hidden evaluations are in:

`/.protein/repo-maintenance/runs/repo-maintenance-20260810160916699-1500881/summary.json`

## What this proves

This proves a small live vertical slice: durable agent identities can author real code, exchange bounded local review artifacts, revise work, survive runtime restart, and submit to an independent acceptance gate.

It does not prove that four agents outperform one agent, that the topology is optimal, or that this workload generalizes. The next honest comparison is the same tasks under equal token and tool budgets with and without peer review.
