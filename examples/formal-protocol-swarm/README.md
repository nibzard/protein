# Formal crash/retry protocol swarm

This experiment uses a `2×2×3` layered Protein population to repair and prove a finite-state crash/retry protocol. The third dimension is responsibility rather than decoration:

- `z=0`: counterexample explorers;
- `z=1`: repair and invariant synthesizers;
- `z=2`: adversarial proof checkers.

The four columns focus on identity, ambiguity, receipts, and recovery. Horizontal neighbors exchange bounded diagnosis or candidate artifacts; vertical edges promote counterexamples into proof candidates and then acceptance decisions.

## Formal problem

An external action can time out after its effect has occurred, leaving the runtime in an ambiguous state without a receipt. The seeded transition retries that action directly. Z3 produces a two-step trace in which `timeout_applied` followed by `retry_ambiguous` reaches two external effects.

The accepted repair requires reconciliation before retry. A candidate is promoted only if Z3 proves:

```text
Initial(s)                  => Invariant(s)
Invariant(s) ∧ Step(s, s') => Invariant(s')
Invariant(s)                => Safety(s)
```

Preservation is checked separately for all seven transitions. Four safety properties and the no-direct-ambiguous-retry policy are also checked. Every obligation must be `UNSAT`.

## Run

Create the bounded solver environment once:

```sh
python3 -m venv .protein/tools/z3-venv
.protein/tools/z3-venv/bin/pip install -r examples/formal-protocol-swarm/requirements.txt
```

Run the deterministic solver check:

```sh
npm run formal:check
```

Run twelve live Luna cells through celld:

```sh
CELLD_BIN=/path/to/celld npm run formal:run
```

The evidence bundle contains durable cell state, actions and journals, provider receipts and usage, all acceptance decisions, mutation results, and a replayable SMT-LIB certificate.

The same specification now drives a real-runtime trace projector in the crash matrix. See [CONFORMANCE-RESULT.md](./CONFORMANCE-RESULT.md). Reconcilable recovery conforms; three known unsafe-delivery scenarios are rejected, matching Protein's documented 10/13 crash baseline.

## Cube preflight

Before scaling this experiment to a 3×3×3 population, run the frozen bounded
comparison:

```sh
CELLD_BIN=/path/to/celld npm run cube:preflight
```

`cube-preflight.json` fixes nine protocol mutations, 27 candidate patches,
equal 12-call budgets for centralized and four-column layered Luna conditions,
and the decision gate before any model call. `preflight_solver.py` exhaustively
checks safety and progress. The runner persists every live call through celld,
checks restart recovery, and writes `summary.json` plus `LEARNINGS.md` under
`.protein/cube-preflight/runs/`.

The 27-cell follow-up is justified only if the centralized condition misses a
mutation, the layered condition beats it, a neighbor artifact is causally
necessary, a real cross-column conflict appears, or solver enumeration takes at
least one second. Otherwise the task is too cheap or too decomposable to teach
us anything useful by merely adding cells.

The first frozen run fired none of those conditions, so the cube was rejected.
See [CUBE-PREFLIGHT-RESULT.md](./CUBE-PREFLIGHT-RESULT.md).

## Claim boundary

The certificate proves the finite-state model encoded in `protocol_solver.py`, assuming Z3 is sound. Runtime projection provides trace-level conformance evidence, not a total refinement proof of the TypeScript implementation. It also does not show that twelve agents outperform a single formal-methods agent.
