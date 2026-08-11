# Cellular Agent Swarm

> **Status: celld smoke, live vertical slice, paired Luna comparison, and a
> scripted browser scenario.** The repeatable smoke path uses mock
> capabilities. The live paths use the OpenAI Responses API, a containerized
> artifact executor, a separate hidden evaluator, and a receipt board. The
> small vertical slice is integration evidence. `swarm:compare` retains the
> exploratory quality comparison; `swarm:cost-target` runs the stricter fixed
> verified-quality cost protocol.

This example will test whether a population of durable, locally connected
agents can improve a real artifact more effectively than one agent or the same
population working independently, under the same total budget.

The canonical concept is [Cellular Agent Swarm](../../CELLULAR-AGENT-SWARM.md).
This directory turns that concept into an implementation-ready outline without
prematurely designing a general multi-agent framework.

## Run the deterministic celld smoke path

```sh
CELLD_BIN=/path/to/celld npm run swarm:celld
```

The command requires Docker and a celld v0.1.0-compatible binary. It:

1. builds and deploys `SwarmCell` to a fresh MinIO-backed celld instance;
2. starts a deterministic external capability service;
3. activates 16 independently named Protein cells;
4. drives three frozen local-neighborhood generations through
   `generation.opened → decide → materialize/adopt → submit → waiting`;
5. verifies event deduplication, event conflict detection, and receiver receipt
   conflicts;
6. restarts celld after generation one and verifies all cell state survives;
7. collects per-cell state, actions, journals, code artifacts, evaluator
   evidence, process logs, request latency, action latency, recovery time, and
   celld RSS.

Every invocation creates an evidence directory:

```text
.protein/cellular-agent-swarm/celld-runs/<run-id>/
├── manifest.json
├── summary.json
├── timeline.jsonl
├── rss.jsonl
├── generation-*.json
├── artifacts/
├── cells/<cell-id>/{final-state,actions,journal}.json
└── processes/{celld,capability}.log
```

`.protein/cellular-agent-swarm/celld-runs/latest.json` points to the most recent
run, whether it passed or failed.

Start with `summary.json`. It reports the celld version and Worker hash,
distinct cell count, actions by kind and status, retry count, action and
generation latency, RSS peak, restart recovery time, and warning/error signals
parsed from celld logs. Raw records remain available for audit.

For a live run, the directory also contains private gateway replay state, raw
per-cell journals, candidate artifacts, and, on failure, a
`private-failure.json`. Treat the complete run directory as local audit data,
not as a shareable report. The report APIs expose the manifest, summary,
redacted cell projection and service metrics, and a sanitized timeline; call
IDs and arguments are hashed, while source, tool outputs, rationales, raw
errors, credentials, and hidden case details remain outside that projection.

The population, generation count, ports, and condition can be changed with
`SWARM_ROWS`, `SWARM_COLUMNS`, `SWARM_GENERATIONS`, `SWARM_MINIO_PORT`,
`SWARM_CELLD_PORT`, `SWARM_CAPABILITY_PORT`, and
`SWARM_CONDITION=local|isolated`.

## Run the live OpenAI vertical slice

The live path requires Docker, a celld v0.1.0-compatible binary, outbound
access to the OpenAI API, and an API key supplied through the process
environment. Do not put the key in a command, config file, evidence bundle, or
shell history. One interactive Bash pattern is:

```sh
read -rsp "OpenAI API key: " OPENAI_API_KEY
export OPENAI_API_KEY
echo
CELLD_BIN=/path/to/celld npm run swarm:openai
unset OPENAI_API_KEY
```

In automation, inject `OPENAI_API_KEY` from the platform's secret store. The
runner checks that the variable exists but never prints its value. The default
live pilot runs a local 2 x 2 population for two generations. It starts:

- real named `SwarmCell` actors on celld;
- a raw OpenAI Responses model gateway;
- a containerized public-tool executor with no network and bounded resources;
- a separate evaluator that alone imports hidden cases;
- a deterministic receipt board that verifies evaluator evidence before
  accepting a candidate.

Useful live settings are:

| Variable | Purpose | Default |
|---|---|---|
| `OPENAI_API_KEY` | Required credential; keep it out of files and logs. | none |
| `OPENAI_MODEL` | Responses API model identifier recorded with the run. | `gpt-5.6-luna` |
| `OPENAI_BASE_URL` | Responses-compatible API base URL. | `https://api.openai.com/v1` |
| `OPENAI_REASONING_EFFORT` | Requested reasoning effort. | `low` |
| `SWARM_MODEL_MAX_OUTPUT_TOKENS` | Per-response output ceiling. | `1200` |
| `SWARM_MODEL_TIMEOUT_MS` | Per-request provider timeout. | `60000` |
| `SWARM_MODEL_MAX_ATTEMPTS` | Provider attempts per model action; values above one may duplicate ambiguous work. | `1` |
| `SWARM_MAX_MODEL_TURNS` | Model turns allowed per cell and generation. | `4` |
| `SWARM_MAX_TOOL_CALLS` | Non-terminal tool calls allowed per cell and generation. | `3` |
| `SWARM_SANDBOX_IMAGE` | Container image used for generated source. | `node:22-alpine` |
| `SWARM_ROWS`, `SWARM_COLUMNS` | Pilot topology dimensions. | `2`, `2` |
| `SWARM_GENERATIONS` | Pilot generations. | `2` |
| `SWARM_CONDITION` | `local` or `isolated` observation topology. | `local` |

The OpenAI request and replay contract is documented in
[MODEL-GATEWAY.md](./docs/MODEL-GATEWAY.md). The gateway uses raw Responses
items rather than an agent SDK: strict flat function tools, `store: false`,
encrypted reasoning items, exactly one function call per turn, and an exact
`call_id`-linked output on the next turn. The live default makes one provider
attempt per action; increasing it enables bounded retries but can duplicate
work or billing after an ambiguous timeout.

## Run the paired Luna comparison

`swarm:compare` runs three matched pairs of local and isolated populations by
default. Each condition uses 16 cells for four generations with the same Luna
model, reasoning setting, task, evaluator, configured credit ceiling, turn
ceiling, tool ceiling, and provider controls. Trial order alternates to reduce
an obvious order bias. It is a live, potentially costly command.

```sh
read -rsp "OpenAI API key: " OPENAI_API_KEY
export OPENAI_API_KEY
echo
CELLD_BIN=/path/to/celld npm run swarm:compare
unset OPENAI_API_KEY
```

The command first checks three benchmark baselines, then runs every configured
pair without manual steering. A condition is rerun only after an operational
failure; passing score outcomes are never retried. Every attempt remains in the
comparison bundle. The runner verifies equal **configured ceilings**, not equal
consumption, and reports tokens, turns, tools, evaluations, credits, fallbacks,
and elapsed time separately.

Comparison bundles are stored under:

```text
.protein/cellular-agent-swarm/comparisons/<comparison-id>/
├── manifest.json
├── summary.json
└── attempts/
```

`npm run swarm:compare:rebuild` reconstructs the derived latest comparison
summary from immutable run evidence without making model calls. The active task
and evaluator are frozen as `sorted-unique-int32/v3` and
`protein-swarm-evaluator/v3`; see [BENCHMARK-V3.md](./docs/BENCHMARK-V3.md).

The first completed three-pair run found one local win, one isolated win, and
one tie on the preregistered seed-relative quality endpoint. Its median paired
effect was -1.33 percentage points, so the truthful primary conclusion is that
no repeatable neighbor-exchange advantage was observed. As a secondary
descriptive result, local used fewer recorded Responses tokens, model turns,
tool calls, evaluations, and elapsed time in all three matched pairs. This is
consistent with reuse and earlier convergence in these runs; it is not evidence
of learning, statistical significance, or general swarm superiority.

That immutable comparison records prompt `protein-swarm-code-agent/v2` and tool
schema `protein-swarm-tools/v2`. Its fallback audit motivated the current
prompt v4 / tool-schema v3 protocol. Tool schema v3 removes strategy and
lineage identifier echoing from `finalize_candidate`; prompt v4 expresses
frozen-observation scores as multiples of each run's seed. Every run records the
prompt version, tool-schema version and hash, Worker bundle hash, sandbox image,
benchmark concurrency, and other matched controls so results from different
protocol generations are not silently combined.

Across the six v2 runs, 164 of 1,102 model turns (14.88%) were safely converted
to durable `wait` outcomes after semantic validation. Most were protocol
friction rather than infrastructure failures: 77 invalid lineage-parent echoes,
60 attempts to finalize without a same-generation checked draft, 22 exact
strategy-label mismatches, and five malformed candidate IDs. All 96 cells still
settled every generation; the fallback does not mean the model self-corrected.

The 5-point outcome band is a decision rule, not an equivalence margin.
Repeated measurements of identical candidate hashes showed score variation
larger than that band, and isolated runs performed more evaluations, creating a
different best-of-many opportunity. More repetitions and tighter benchmark
noise controls are required before making a quality claim.

## Run the fixed-quality cost experiment

`swarm:cost-target` asks the narrower next question: at one fixed,
independently reverified quality target, does local exchange reach that target
with fewer recorded Responses tokens than isolated cells? The default command
runs ten matched 4×4, four-generation pairs on `gpt-5.6-luna` and is a live,
potentially expensive experiment.

```sh
read -rsp "OpenAI API key: " OPENAI_API_KEY
export OPENAI_API_KEY
echo
CELLD_BIN=/path/to/celld npm run swarm:cost-target
unset OPENAI_API_KEY
```

Discovery finishes before measurement. Every distinct evaluated non-seed
candidate receives nine fresh hidden rechecks in serialized blocks bracketed
by fresh seed baselines. A candidate must pass correctness 9/9 times and clear
3× the interleaved baseline in at least 8/9 ratios. Measurement work is
reported but excluded from discovery cost. Non-reaching conditions are
right-censored, never assigned a zero or cap cost, and only both-reaching pairs
enter continuous paired-cost summaries.

The first passing run freezes a control fingerprint; every later run must
match it and the preregistered manifest. All condition attempts and block
attempts remain in the evidence. The exact design, censoring rule, sign test,
bootstrap interval, and permitted claim are frozen in
[COST-TO-TARGET.md](./docs/COST-TO-TARGET.md). The completed Luna pilot,
including its incomplete confirmatory status and descriptive findings, is in
[COST-TO-TARGET-RESULT.md](./docs/COST-TO-TARGET-RESULT.md).

## Evidence levels

| Level | What runs | Valid claim |
|---|---|---|
| `scripted-simulation` | One Node process and authored scenario tables. | UI and contract preview only. |
| `celld-smoke-mock-services` | Real celld, real named Protein cells, deterministic external capabilities, real source artifacts and in-process checks. | The Protein lifecycle ran and recovered on celld under the recorded conditions. |
| `celld-experiment` | Real model gateway, containerized public executor, separate hidden evaluator, and receipt board on the celld path. | The live vertical slice ran under its recorded configuration. This label alone does not mean the comparison protocol has been completed. |

`npm run swarm:celld` produces the second level. It performs real code checks
and writes content-addressed artifacts, but strategy selection is deterministic
and the evaluator is not isolated from the capability service. It therefore
does not demonstrate useful autonomous reasoning.

`npm run swarm:openai` produces the third evidence shape for one small pilot.
It demonstrates the live model/tool/evaluator integration, durable per-cell
action flow, and evidence plumbing. It does **not** run repeated sequential,
isolated, and local conditions under a frozen equal budget. Its result cannot
support a claim that local exchange helped, that the population learned, or
that a swarm outperformed one agent.

## Read the latest celld evidence

```sh
npm run swarm:dev
```

After at least one `swarm:celld` or `swarm:openai` run, open
<http://127.0.0.1:8788/celld.html>. The page is a read-only projection over
`latest.json` and its referenced run directory. It shows recovered cell states,
durable action metrics, generation timing, restart recovery, memory samples,
runtime warnings, milestones, and the captured celld log tail. Its JSON sources
are available under `/api/celld/latest`. After `swarm:compare`, the same page
leads with the paired verdict, trial variation, spend, and lineage. The derived
comparison JSON is available under `/api/celld/comparison/latest`.

The root page at <http://127.0.0.1:8788/> is the legacy UI marked
`SCRIPTED NODE SCENARIO`. It does not invoke celld, the Worker, Protein cells,
an LLM, or the artifact evaluator. Its scores and comparisons are authored
fixtures rather than experiment results.

`npm run swarm:build` only compiles the Worker; it does not deploy or execute
it. `worker.ts` exposes `/state`, `/actions`, and `/journal` for evidence
collection and uses reconcilable external actions with stable IDs.

## First demonstration

Both celld paths use a small code-improvement task with a correct but
inefficient baseline. The mock path uses authored strategies and an in-process
smoke evaluator. The live path lets the model inspect visible artifacts and
generate source, runs public checks in a locked-down container, and sends only
finalized candidates to a separate hidden evaluator.

The mock smoke defaults to 4 x 4 cells and three generations. The live pilot
defaults to 2 x 2 cells and two generations to bound cost while exercising the
complete path. Each Protein cell owns one candidate reference, compact state,
lineage, and a fixed grant. Across bounded generations it may explore, improve,
challenge, adopt, or wait.

The broader experiment still needs to produce two things:

1. a real winning artifact with tests, measurements, and complete provenance;
2. credible evidence about whether local agent interaction helped.

## Responsibility map

| Part | Responsibility |
|---|---|
| Protein cell | Durable identity, compact private state, event/action lifecycle, candidate references, local memory, and recovery. |
| Board | Experiment configuration, topology, filtered neighborhood snapshots, generation deadlines, global budget accounting, and settlement. |
| Model gateway | Raw, stateless Responses tool loop, transcript continuity, action receipts, provider usage, and bounded retry records. |
| Artifact executor | Visible-candidate reads, generated-source storage, containerized public checks, and content-addressed draft references. |
| Evaluator | Separate authoritative correctness and performance results. Hidden inputs and case details never enter model or executor responses. |
| Projection/UI | Read-only grid, metrics, inspection, lineage, and journal replay. |

The board coordinates the experiment but does not choose strategies or rank
unverified model claims. Large artifacts and tool output remain outside Protein
cells.

## Planning documents

- [CONTRACTS.md](./docs/CONTRACTS.md) defines ownership, message families,
  stable identities, locality, generation settlement, and failure rules.
- [EXPERIMENT.md](./docs/EXPERIMENT.md) defines the comparison, fairness rules,
  metrics, reproducibility requirements, and success criteria.
- [MODEL-GATEWAY.md](./docs/MODEL-GATEWAY.md) defines the raw OpenAI Responses
  request, replay, receipt, ambiguity, usage, and redaction contract.
- [BENCHMARK-V3.md](./docs/BENCHMARK-V3.md) defines the active correctness
  gates, deterministic workload regimes, repeated-median timing, and score.
- [BUILD-PLAN.md](./docs/BUILD-PLAN.md) defines gated implementation milestones
  and the rule for extracting reusable framework code later.

Protein's implemented lifecycle remains authoritative; see
[RUNTIME.md](../../RUNTIME.md). Known celld safety boundaries remain in force;
see [PROOFS.md](../../PROOFS.md) and [QUESTIONS.md](../../QUESTIONS.md).

## Layout

```text
examples/cellular-agent-swarm/
├── README.md
├── artifact-benchmark.mjs
├── artifact-evaluator-server.mjs
├── artifact-executor-server.mjs
├── artifact-hidden.mjs
├── artifact-hidden-v2.mjs
├── artifact-hidden-v3.mjs
├── artifact-sandbox.mjs
├── artifact-task.mjs
├── artifact-task-v2.mjs
├── artifact-task-v3.mjs
├── artifact-workloads.mjs
├── board-server.mjs
├── capability-server.mjs
├── local-server.mjs
├── model-gateway-server.mjs
├── openai-responses.mjs
├── sandbox-runner.mjs
├── simulation.mjs
├── public/
├── docs/
│   ├── BUILD-PLAN.md
│   ├── CONTRACTS.md
│   ├── EXPERIMENT.md
│   └── MODEL-GATEWAY.md
├── worker.ts
└── wrangler.jsonc

scripts/
└── swarm-celld-run.mjs
```

The first implementation should stay inside this example. There should be no
new `framework` or `core` package until a second environment demonstrates that
an abstraction can be reused substantially unchanged.

## Current comparison boundary

The local-versus-isolated paired protocol, benchmark, correctness gate, budget
ceilings, effect rule, attempt retention, usage accounting, and dashboard are
implemented. It answers the narrower topology question under one task and one
small preregistered run. It does not yet include the sequential condition from
the broader research plan, and three pairs are too few for a general claim.

The next credible step is replication: freeze this implementation, reduce and
characterize evaluator noise, run substantially more matched pairs, and then
add the equal-cap sequential condition. Report all attempts and recorded usage;
do not promote a lower-consumption observation into an equal-quality claim.
