# 3×3×3 cube preflight result

Decision: **do not run the larger cube on this task**.

The suite, budgets, and gate were frozen before any model call. The measured run
was `cube-preflight-20260810223933160-1753493`.

| Condition | Agents | Luna calls | Tokens | Correct repairs |
| --- | ---: | ---: | ---: | ---: |
| Exhaustive Z3 enumeration | 0 | 0 | 0 | 9/9 in 101.168 ms |
| Centralized | 1 | 12 | 13,943 | 9/9 |
| Layered Protein | 12 | 12 | 13,150 | 9/9 |

The centralized cell's state was unchanged after a celld restart and contained
all 12 completed runs. Both live conditions agreed with the authoritative
evaluator on all nine mutations.

None of the precommitted reasons to scale fired:

- the centralized condition missed no mutation;
- the layered condition did not beat it;
- no accepted repair causally depended on a neighbor artifact;
- no cross-column integration conflict appeared;
- exhaustive enumeration stayed far below the one-second threshold.

## What this teaches us

Adding 15 more cells would measure orchestration volume, not collective
intelligence. These mutations are independent, their candidate spaces are tiny,
and the column boundaries introduce no real dependency. The layered condition's
slightly lower token count is a single-run observation, not evidence of an
advantage.

A worthy cube task must make coordination necessary: decisions in one region
must alter constraints elsewhere, local fixes must sometimes conflict, and a
single exhaustive pass must become expensive or impossible. Until such a task
is frozen with an equal-budget baseline and causal ablations, the smaller
population is the more informative experiment.

The complete machine-readable evidence is in
`.protein/cube-preflight/runs/cube-preflight-20260810223933160-1753493/summary.json`.
