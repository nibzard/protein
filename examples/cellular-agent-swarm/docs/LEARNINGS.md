# Cellular agent swarm learnings

These are the architectural lessons from the first durable Luna swarm and its
ten-pair fixed-quality experiment. The detailed measurements remain in
[`COST-TO-TARGET-RESULT.md`](./COST-TO-TARGET-RESULT.md); this note records what
should shape the next implementation.

## Durable autonomy is working

Protein and celld successfully ran many independent model-backed cells through
bounded tool loops, durable action receipts, generated artifacts, hidden
evaluation, restart recovery, and evidence reconstruction. Across the accepted
runs, 320 cells completed 1,280 cell-generations with 20/20 restart recoveries,
no redeliveries, and no runtime or service errors.

This is already a useful reusable foundation. Durable identity, action
reconciliation, tool execution, artifact storage, evaluation, and evidence
projection belong below any particular grid or benchmark.

## Communication is the current bottleneck

The local-neighbor population did less visible work but spent more tokens to
reach the same verified target. Across the nine valid pairs, local agents used
fewer model requests, tool executions, public checks, evaluator submissions,
and output tokens, while using 30.24% more input tokens at the median. The
neighbor context made each decision more expensive than the work it saved.

The next protocol must exchange compact references and claims, not replay a
neighbor's working context. Communication cost is part of the algorithm, not
incidental infrastructure.

## Propagation is not collaboration

Local runs produced 147 unique candidates versus 270 in isolated runs and
ended with aggregate final diversity of 43 versus 142. They recorded 306
adoptions but only one directly neighbor-derived verified improvement.

The current mechanism efficiently spreads a winner, but rarely turns another
cell's work into new work. A useful collaboration protocol needs explicit
operations such as offering an artifact, reviewing it, proposing a change,
merging contributions, and rejecting a proposal with evidence. Adoption alone
encourages premature convergence and duplicate belief.

## Cost, latency, and final quality are different outcomes

Local runs were usually faster, used fewer tools and evaluations, and reached
a somewhat higher exploratory final score. They were nevertheless more
expensive in recorded tokens at the first fixed-quality crossing. A single
"swarm performance" number would conceal this tradeoff.

Future experiments should report at least verified work completed, input and
output tokens, wall time, tool work, evaluator work, duplicate work, diversity,
and useful cross-agent contributions.

## Integrity must include discarded attempts

The automatic aggregate initially selected a clean retry and would have
reported a passing higher-cost result. The retained first attempt contained an
ambiguous provider request and an exhausted measurement-block retry, which
invalidated the pair under the frozen rules. Auditing all attempts changed the
authoritative result to incomplete.

Attempt history is scientific evidence. Retries must never erase ambiguous
usage, invalid measurement, identity drift, or missing usage records. The
all-attempt audit should run before any comparative conclusion is emitted.

## The work should be the protagonist

The grid is useful as a routing and locality constraint, but it should not be
the product story. The next demo should visibly solve repository-maintenance
work: agents claim issues, inspect code, run tools, publish patches, review
neighbor contributions, and integrate fixes that pass hidden tests.

The dashboard should explain who discovered, implemented, reviewed, improved,
and integrated each result. Movement and cellular metaphors are secondary to
durable, verifiable work.

## Framework extraction rule

Keep experiment-specific topology, generations, seeded defects, and scoring in
the demo. Extract a primitive only when the repository-maintenance environment
also needs it. The likely reusable boundary is:

- durable agent and tool loops;
- task claiming and ownership;
- versioned artifacts and provenance;
- typed inter-agent messages;
- review and acceptance records;
- evaluator adapters; and
- cost, retry, and integrity accounting.

This keeps Protein grounded in working examples instead of designing a general
agent framework in advance.

## Next hypothesis

A population using compact, typed, artifact-centered exchange can complete
more independently verified repository fixes per token than isolated agents,
while producing measurable reviewed or merged contributions instead of simple
candidate propagation.

The first implementation should prove this cheaply on a small repository and a
2x2 population. A larger frozen comparison is justified only after the smoke
run demonstrates real cross-agent improvement and complete evidence.

## Repository-maintenance comparison

The equal-budget follow-up did not find that advantage. Across three paired
Luna trials, peer review won zero, lost one, and tied two against self-review.
Both conditions used 36 provider calls; peer review consumed 29,587 actual
tokens versus 29,973 for self-review. Initial implementations in both
conditions passed all 84 aggregate cases. Peer review finished at 82/84
because one speculative critique caused a correct duration parser to be
replaced by a revision that failed both a public and hidden case.

The framework lesson is sharper than "add more review." Artifact exchange
needs monotonic acceptance. A critique is advisory; a child artifact may
replace its verified parent only after it preserves established evidence. The
next reusable primitive should be an acceptance policy linking parent,
revision, checks, and decision—not another communication channel.
