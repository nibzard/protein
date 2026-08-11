# Cellular Agent Swarm

> The broader heterogeneous-compute direction is specified in
> [NEXT-CUBE.md](./NEXT-CUBE.md). The cube is not only an intelligence
> comparison; it is also a systems demonstration of durable agents escalating
> selected work into stronger execution environments.

## Idea

Build a cellular problem-solving system in which every celld cell contains a
durable AI agent and one candidate solution to a real task. Agents do not move
around a board or role-play artificial creatures. They use an LLM and bounded
tools to create, test, criticize, combine, and improve useful work.

The cellular structure limits what each agent can observe. An agent sees its
own candidate and a compact view of its neighbors' candidates, scores, and
evidence. Good ideas can spread through local interaction, competing approaches
can form clusters, and new approaches can appear independently.

The central experiment is:

> Can a population of locally communicating agents produce a better solution
> than one agent, or the same population working independently, under the same
> total model and tool budget?

This keeps the visual and emergent qualities of a cellular automaton while
using model intelligence for genuine problem solving.

## What a cell represents

One Protein cell is a persistent problem-solving identity. It owns:

- a reference to its current candidate artifact;
- the candidate's verified score and test evidence;
- a short strategy summary;
- remaining model and tool credits;
- the candidate's lineage;
- compact memories of previous attempts;
- its current generation and status.

The agent identity remains durable even when its current candidate is rejected.
"Death" applies to an unsuccessful candidate, not to the Protein cell itself.
The agent can adopt a neighbor's candidate and attempt a new improvement in the
next generation.

An illustrative state shape is:

```ts
interface CellularAgentState {
  candidateId: string;
  score: number;
  strategy: string;
  generation: number;
  credits: number;
  parentIds: string[];
  recentAttemptIds: string[];
  status: "ready" | "working" | "waiting" | "exhausted";
}
```

Large artifacts, repositories, test output, and model transcripts stay outside
the cell. State contains stable references and compact summaries.

## Agent behavior

On each generation, an agent receives:

- the task and acceptance criteria;
- its current candidate and verified results;
- summaries of neighboring candidates;
- its remaining budget;
- relevant feedback from previous attempts.

It chooses one bounded behavior:

```text
explore                         create an independent approach
improve(candidate)              refine an existing approach
combine(candidateA, candidateB) merge useful ideas from two approaches
test(candidate)                 seek stronger evidence about a claim
challenge(candidate)            find a counterexample or hidden weakness
adopt(candidate)                use a stronger neighbor as the new baseline
wait                            spend nothing this generation
```

These are meaningful tool-backed operations, not simulated movements. The LLM
does semantic work such as reasoning about code, identifying weaknesses,
choosing compatible ideas, or planning an experiment. Deterministic tools run
tests, calculate scores, enforce budgets, and validate artifacts.

An agent may make a proposal, but only the environment can assign a score.
Claims without test or evaluation evidence do not improve fitness.

## Generational loop

The first version can use a simple 2D grid with a Moore neighborhood: the eight
cells surrounding each cell.

```text
1. The board publishes generation N and each local neighborhood snapshot.
2. Relevant Protein cells wake and choose one behavior.
3. Model calls produce structured plans or candidate edits.
4. External executors create artifacts and run evaluations.
5. Results return to cells as durable events.
6. The board freezes verified scores and lineage for generation N.
7. Generation N + 1 begins when all cells finish or a deadline expires.
```

Late or failed agents receive no improvement for that generation. The board
does not need to wait forever. Because action intents and results are durable,
an executor crash can be recovered without losing the cell's history.

Locality should be a real information constraint. Agents may discover a remote
idea only after it propagates through neighboring cells. This makes diffusion,
clusters, independent discovery, and convergence observable rather than
scripted.

## Protein architecture

### Protein cells

Each agent is a named `ProteinAgent`. It receives generation, neighbor,
evaluation, and challenge events; records its strategy and lineage; commits
action intents; and can be evicted and restored by celld between useful
activations.

### Board service

A small deterministic board owns:

- cell coordinates and neighborhood membership;
- the current generation and deadline;
- immutable candidate-score snapshots;
- task-wide budgets;
- generation completion;
- the event stream used by the visualization.

The board coordinates the experiment but does not decide what agents should
try.

### External executors

Executors own model calls, workspaces, code modification, test runs, benchmarks,
and artifact storage. Every operation accepts a globally namespaced identity
derived from deployment, cell class, cell identity, and local action ID as its
idempotency key and returns a stable artifact or evidence reference.

## Best initial task

The clearest first demo is code improvement with objective evaluation.

Give every cell the same small repository containing:

- a correct but inefficient implementation;
- public correctness tests;
- a performance benchmark;
- hidden edge-case tests;
- a fixed model, token, tool, and execution budget.

Agents attempt to improve the implementation without breaking correctness.
Some may invent independent algorithms, some may optimize a successful
neighbor, and others may challenge apparently fast solutions with new tests.

The final deliverable is an actual patch with tests and benchmark evidence.
The population's lineage explains where the winning ideas came from.

Other suitable environments include:

- cleaning and reconciling a messy dataset;
- finding and repairing security defects in a sandboxed program;
- optimizing a schedule under explicit constraints;
- building a cited brief from a fixed source corpus;
- improving a tool policy against a repeatable benchmark.

Tasks need objective or independently checkable scoring. Purely subjective
generation would make the visualization interesting but the experiment weak.

## Cooperation and competition

Agents cooperate by sharing candidates, tests, counterexamples, and successful
techniques. They compete because evaluation budgets are scarce and only
verified improvements survive and propagate.

Competition should concern solution quality rather than artificial hostility:

- two strategies compete on correctness, speed, or cost;
- a challenger gains value by exposing a false improvement;
- combining two lineages may outperform either parent;
- an agent can spend credits exploring or exploit a proven local strategy;
- premature convergence can allow a distant cluster to discover a better
  approach.

This gives the LLM a genuine explore-versus-exploit decision while keeping the
outcome grounded in external evidence.

## Visualization

The main view remains a cellular grid:

- color represents verified score;
- brightness represents recent activity;
- border color represents solution lineage or strategy family;
- pulses between cells represent adoption, combination, or challenges;
- a marker indicates the current best verified candidate;
- clicking a cell reveals its candidate, reasoning summary, tests, costs, and
  ancestry.

Supporting charts show:

- best and median score by generation;
- percentage of candidates passing all correctness tests;
- strategy diversity and convergence;
- model and executor cost;
- independent discoveries versus copied improvements;
- successful combinations and challenges;
- active, waiting, and exhausted cells.

A timeline scrubber should replay the experiment from projected Protein
journals, board events, capability receipts, and artifact provenance so a
viewer can watch an idea originate, spread, get challenged, and either survive
or disappear.

## Evaluation

Run three conditions with the same total model and executor budget:

1. one strong agent working sequentially;
2. many isolated agents with no neighbor communication;
3. the cellular swarm with local communication.

Compare:

- final verified score;
- time to first correct solution;
- time to best solution;
- cost per accepted improvement;
- invalid solutions rejected;
- useful tests or counterexamples discovered;
- diversity maintained over time;
- duplicate effort;
- recovery from interrupted executors;
- performance as the population grows.

This comparison determines whether local multi-agent behavior creates value or
merely creates more activity.

## Original minimal-demo proposal

The initial proposal was deliberately small:

- a 4 x 4 grid of 16 Protein cells;
- one code-optimization task;
- ten generations;
- four initial behaviors: explore, improve, challenge, and adopt;
- one model gateway and one sandboxed code executor;
- public and hidden tests;
- a grid view, score chart, and cell inspector;
- complete event and artifact replay.

The implemented smoke, live, and paired configurations subsequently used
different generation counts. Their measured settings and results are
authoritative in the example documentation linked below.

## Non-goals

The demo is not intended to model biology, simulate artificial personalities,
create an agent marketplace, or coordinate a fictional company. It is a
controlled experiment in whether durable, locally connected AI agents can
collectively improve a real artifact.

## Project implementation

The implementation lives in
[examples/cellular-agent-swarm](./examples/cellular-agent-swarm/README.md). It
includes a real celld/Protein runtime smoke test with deterministic external
capabilities, a separate scripted browser scenario, and completed model-backed
isolated-evaluator comparisons. Those comparisons did not establish a local
swarm advantage; see the
[fixed-quality result](./examples/cellular-agent-swarm/docs/COST-TO-TARGET-RESULT.md).
Repository-maintenance, formal-protocol, and compute-fabric environments now
provide additional extraction evidence. The current boundary is recorded in
[ARCHITECTURE.md](./ARCHITECTURE.md).
