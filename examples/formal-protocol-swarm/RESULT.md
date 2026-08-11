# Formal protocol pilot result

Run `formal-protocol-20260810170341250-1548476` passed on August 10, 2026.

The acceptance primitive was subsequently integrated and verified by run `formal-protocol-20260810200222353-1657099`, which passed the same 13 obligations with four durable acceptance receipts, 12 model calls, 14,141 tokens, and 2.76-second restart recovery.

## Measured evidence

| Measure | Result |
| --- | ---: |
| Durable cells | 12 |
| Shape | 2×2×3 |
| Luna Responses calls | 12 |
| Responses tokens | 13,501 |
| Solver-valid candidates | 4 / 4 |
| Adversarially approved candidates | 4 / 4 |
| Formal obligations | 13 |
| Certificate obligations replayed as UNSAT | 13 / 13 |
| Invalid mutations rejected | 3 / 3 |
| Restart recovery | 2.85 s |

The seeded protocol admits the solver-generated trace:

```text
pending, effects=0
  -- timeout_applied -->
ambiguous, effects=1, receipt=false
  -- retry_ambiguous -->
committed, effects=2, receipt=true
```

All four synthesis columns independently selected `require_reconciliation`. The promoted proof uses an invariant linking phase, receipt, reconciliation, and effect count. Z3 proved initiation, preservation for every transition, four safety implications, and the policy prohibiting unreconciled ambiguous retry.

The acceptance layer rejected the original protocol and the `retry_without_effect` and unrelated `payload_guard` mutations. The final certificate was regenerated independently and replayed from its content-hashed SMT-LIB files using Z3 4.15.3.

This proves the encoded finite-state repair, not conformance of Protein's TypeScript implementation and not a swarm advantage.

Evidence:

- [summary.json](</home/agent/protein/.protein/formal-protocol/runs/formal-protocol-20260810170341250-1548476/summary.json>)
- [certificate manifest](</home/agent/protein/.protein/formal-protocol/runs/formal-protocol-20260810170341250-1548476/certificate/manifest.json>)
