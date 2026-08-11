# Protein runtime conformance result

The celld `0.1.0` crash matrix was projected into `protein-crash-retry-protocol/v1` and checked with Z3 4.15.3 on August 10, 2026.

## Result

The result formalizes Protein's existing production boundary rather than erasing it:

- All eight idempotent scenarios passed the operational crash matrix. They are outside the proof model because their safety comes from receiver deduplication.
- The reconcilable crash after `executor.accepted` projected to `timeout_applied → reconcile_applied` and conformed to every formal transition and safety property.
- The unsafe crash before dispatch uncertainty completed normally and projected to `dispatch_ok`.
- Unsafe crashes at `action.dispatch_started`, `executor.request_received`, and `executor.accepted` did not conform. Celld restored execution from before Protein's durable protection point, and the latter two cases produced two receiver requests.
- The explicitly seeded `timeout_applied → retry_ambiguous` trace was rejected by both the transition relation and the at-most-once safety property.

The complete action matrix therefore remains 10/13, matching Protein's documented negative baseline. Among the five non-idempotent traces projected into the formal vocabulary, two conformed and three unsafe traces were correctly rejected.

This is useful conformance evidence: the abstract proof accurately distinguishes the supported reconcilable path from the known unsafe-delivery boundary. It does not prove implementation refinement for every runtime state, and it confirms that unsafe automatic effects require idempotency or authoritative reconciliation outside Protein.

Evidence: [action-crash report](</home/agent/protein/.protein/formal-protocol/conformance/action-crash-1654151-1786391954575.json>).
