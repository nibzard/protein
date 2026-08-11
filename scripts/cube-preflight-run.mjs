import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deploy, getJson, pollJson, postJson, requireCommand, root, run, startCelld, startMinio, stopChild, stopMinio, waitForHttp } from "./celld-proof-support.mjs";

const suite = JSON.parse(await readFile(join(root, "examples/formal-protocol-swarm/cube-preflight.json"), "utf8"));
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const runId = `cube-preflight-${stamp}-${process.pid}`;
const output = resolve(process.env.PREFLIGHT_RUN_ROOT ?? join(root, ".protein/cube-preflight/runs"), runId);
await mkdir(output, { recursive: true });

const celldBin = process.env.CELLD_BIN ?? "celld";
const minioPort = Number(process.env.PREFLIGHT_MINIO_PORT ?? 19500);
const celldPort = Number(process.env.PREFLIGHT_CELLD_PORT ?? 19501);
const executorPort = Number(process.env.PREFLIGHT_EXECUTOR_PORT ?? 19502);
const bucket = `protein-preflight-${process.pid}`;
const minioName = `protein-preflight-minio-${process.pid}`;
const endpoint = `http://127.0.0.1:${minioPort}`;
const base = `http://127.0.0.1:${celldPort}`;
const credentials = { AWS_ACCESS_KEY_ID: "protein-preflight", AWS_SECRET_ACCESS_KEY: "protein-preflight-secret", AWS_REGION: "us-east-1" };
const columns = ["identity", "ambiguity", "receipts", "recovery"];
const groups = Object.fromEntries(columns.map((column) => [column, suite.mutations.filter((mutation) => mutation.column === column).map((mutation) => mutation.id)]));
let celld;
let executor;
let minio = false;
let executorLog = "";
const timeline = [];
const mark = (type, data = {}) => timeline.push({ at: new Date().toISOString(), type, ...data });

try {
  requireCommand(celldBin, ["--version"]);
  requireCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  const solver = runSolver();
  if (!solver.complete || solver.acceptedRepairs.length !== suite.mutations.length) throw new Error("frozen solver oracle is incomplete");
  mark("run.started", { runId, suiteId: suite.id, mutations: suite.mutations.length, conditions: ["solver-only", "centralized", "layered"], callsPerLiveCondition: suite.budgets.callsPerCondition });

  run("npm", ["run", "example:build"]);
  await startMinio({ name: minioName, port: minioPort, bucket, credentials });
  minio = true;
  deploy({ celldBin, project: "examples/repo-agent", bucket, endpoint, credentials });
  executor = spawn(process.execPath, [join(root, "examples/formal-protocol-swarm/preflight-executor.mjs")], { cwd: root, env: { ...process.env, PREFLIGHT_EXECUTOR_PORT: String(executorPort), PREFLIGHT_RUN_DIR: output, PREFLIGHT_MAX_OUTPUT_TOKENS: String(suite.budgets.maxOutputTokensPerCall), OPENAI_MODEL: suite.model }, stdio: ["ignore", "pipe", "pipe"] });
  executor.stdout.on("data", (chunk) => (executorLog += chunk));
  executor.stderr.on("data", (chunk) => (executorLog += chunk));
  await waitForHttp(`http://127.0.0.1:${executorPort}/stats`);
  const start = () => startCelld({ celldBin, bucket, endpoint, credentials, port: celldPort, ttlMs: 3000, variables: { EXECUTOR_URL: `http://127.0.0.1:${executorPort}`, PROTEIN_LEASE_MS: "120000" }, fetchTimeoutSeconds: 130, handlerBudgetSeconds: 150 });
  celld = await start();

  const centralAgent = `${runId}-centralized`;
  const centralExplorations = [];
  for (const column of columns) centralExplorations.push(await runCell(centralAgent, `central-explore-${column}`, { condition: "centralized", phase: "explore", column, mutationIds: groups[column] }));
  const centralSyntheses = [];
  for (const column of columns) centralSyntheses.push(await runCell(centralAgent, `central-synthesize-${column}`, { condition: "centralized", phase: "synthesize", column, mutationIds: groups[column], explorations: centralExplorations.map(artifactSummary) }));
  const centralRepairs = centralSyntheses.flatMap((result) => result.repairs);
  const centralChecks = [];
  for (const column of columns) centralChecks.push(await runCell(centralAgent, `central-check-${column}`, { condition: "centralized", phase: "check", column, mutationIds: groups[column], repairs: centralRepairs.filter((repair) => groups[column].includes(repair.mutation_id)) }));
  const centralized = conditionResult("centralized", centralExplorations, centralSyntheses, centralChecks);
  mark("condition.completed", { condition: "centralized", calls: 12, accepted: centralized.acceptedMutations });

  const before = await getJson(`${base}/agents/${centralAgent}/state`);
  await celld.cleanup();
  const restartStarted = performance.now();
  celld = await start();
  const after = await pollJson(`${base}/agents/${centralAgent}/state`, (value) => value.state.completedRuns === 12);
  const restartRecoveryMs = Number((performance.now() - restartStarted).toFixed(2));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("centralized durable state changed across restart");
  mark("celld.restart.recovered", { cells: 1, completedRuns: 12, restartRecoveryMs });

  const layeredExplorations = await Promise.all(columns.map((column) => runCell(layeredAgent(column, "explore"), `layered-explore-${column}`, { condition: "layered", phase: "explore", column, mutationIds: groups[column] })));
  const layeredSyntheses = await Promise.all(columns.map((column, index) => runCell(layeredAgent(column, "synthesize"), `layered-synthesize-${column}`, { condition: "layered", phase: "synthesize", column, mutationIds: groups[column], explorations: [layeredExplorations[index], layeredExplorations[(index + 1) % columns.length], layeredExplorations[(index + columns.length - 1) % columns.length]].map(artifactSummary) })));
  const layeredChecks = await Promise.all(columns.map((column, index) => runCell(layeredAgent(column, "check"), `layered-check-${column}`, { condition: "layered", phase: "check", column, mutationIds: groups[column], repairs: layeredSyntheses[index].repairs })));
  const layered = conditionResult("layered", layeredExplorations, layeredSyntheses, layeredChecks);
  mark("condition.completed", { condition: "layered", calls: 12, accepted: layered.acceptedMutations });

  const causalNeighborArtifacts = findCausalNeighborArtifacts(layeredExplorations, layeredSyntheses);
  const crossColumnIntegrationConflicts = findCrossColumnConflicts(layeredSyntheses);
  const gateChecks = {
    centralizedMissesMutation: centralized.acceptedMutations < suite.mutations.length,
    layeredBeatsCentralized: layered.acceptedMutations > centralized.acceptedMutations,
    causalNeighborArtifact: causalNeighborArtifacts.length > 0,
    crossColumnIntegrationConflict: crossColumnIntegrationConflicts.length > 0,
    solverEnumerationAtLeastMs: solver.durationMs >= suite.cubeGate.solverEnumerationAtLeastMs,
  };
  const reasons = Object.entries(gateChecks).filter(([, passed]) => passed).map(([name]) => name);
  const cubeJustified = reasons.length > 0;
  const stats = await getJson(`http://127.0.0.1:${executorPort}/stats`);
  if (stats.byCondition.centralized.calls !== suite.budgets.callsPerCondition || stats.byCondition.layered.calls !== suite.budgets.callsPerCondition) throw new Error(`call budget mismatch: ${JSON.stringify(stats.byCondition)}`);
  mark("gate.applied", { cubeJustified, reasons });
  mark("run.finished", { status: "passed", decision: cubeJustified ? "proceed-to-cube" : "stop-before-cube" });

  const summary = {
    schemaVersion: 1,
    runId,
    status: "passed",
    suiteId: suite.id,
    model: suite.model,
    claimBoundary: "This is one frozen nine-mutation preflight. It compares bounded conditions but does not establish general swarm superiority or learning.",
    budgets: suite.budgets,
    solverOnly: solver,
    centralized,
    layered,
    coordinationEvidence: { causalNeighborArtifacts, crossColumnIntegrationConflicts },
    durability: { centralizedRunsRecovered: after.state.completedRuns, restartRecoveryMs },
    provider: stats,
    cubeGate: { thresholdMs: suite.cubeGate.solverEnumerationAtLeastMs, checks: gateChecks, reasons, justified: cubeJustified, action: cubeJustified ? "build-and-run-3x3x3" : "do-not-build-3x3x3" },
    timeline,
  };
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(output, "timeline.jsonl"), timeline.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await writeFile(join(output, "executor.log"), executorLog);
  await writeFile(join(output, "LEARNINGS.md"), learnings(summary));
  console.log(JSON.stringify({ output, status: summary.status, solverMs: solver.durationMs, centralized: { accepted: centralized.acceptedMutations, calls: centralized.providerCalls, tokens: centralized.totalTokens }, layered: { accepted: layered.acceptedMutations, calls: layered.providerCalls, tokens: layered.totalTokens }, coordinationEvidence: summary.coordinationEvidence, cubeGate: summary.cubeGate }, null, 2));
  if (cubeJustified) throw new Error(`The precommitted gate justified a cube (${reasons.join(", ")}); this preflight intentionally stops before changing the experiment geometry.`);
} finally {
  if (celld) await celld.cleanup();
  if (executor) await stopChild(executor);
  if (minio) stopMinio(minioName);
}

function runSolver() {
  const result = spawnSync(process.env.PROTEIN_SMT_PYTHON ?? join(root, ".protein/tools/z3-venv/bin/python"), [join(root, "examples/formal-protocol-swarm/preflight_solver.py")], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`preflight solver failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
function layeredAgent(column, phase) { return `${runId}-layered-${column}-${phase}`; }
async function runCell(agent, id, spec) { await postJson(`${base}/agents/${encodeURIComponent(agent)}/runs`, { id, goal: { repository: "protein/frozen-protocol-preflight", task: JSON.stringify(spec) } }, 202); const runResult = await pollJson(`${base}/agents/${encodeURIComponent(agent)}/runs/${id}`, (value) => value.status === "completed" || value.status === "failed", { attempts: 1800, delayMs: 100 }); if (runResult.status !== "completed") throw new Error(`${agent}/${id} failed: ${runResult.error}`); return runResult.result; }
function artifactSummary(result) { return { artifactId: result.artifactId, column: result.column, findings: result.findings }; }
function conditionResult(condition, explorations, syntheses, checks) { const evaluations = syntheses.flatMap((result) => result.evaluations); return { condition, agents: new Set([...explorations, ...syntheses, ...checks].map((result) => result.agent)).size, providerCalls: [...explorations, ...syntheses, ...checks].reduce((sum, result) => sum + result.providerCalls, 0), totalTokens: [...explorations, ...syntheses, ...checks].reduce((sum, result) => sum + (result.usage?.total_tokens ?? 0), 0), acceptedMutations: new Set(evaluations.filter((entry) => entry.accepted).map((entry) => entry.mutation_id)).size, totalMutations: suite.mutations.length, evaluations, checkerAgreement: checks.flatMap((result) => result.authoritativeEvaluations).filter((entry) => entry.accepted).length, artifacts: { explorations: explorations.map(artifactSummary), syntheses: syntheses.map((result) => ({ artifactId: result.artifactId, column: result.column, repairs: result.repairs, integrationConflicts: result.integrationConflicts })), checks: checks.map((result) => ({ column: result.column, review: result.review, authoritativeEvaluations: result.authoritativeEvaluations })) } }; }
function findCausalNeighborArtifacts(explorations, syntheses) { const byId = new Map(explorations.map((result) => [result.artifactId, result])); const evidence = []; for (const synthesis of syntheses) for (const repair of synthesis.repairs) { const local = explorations.find((result) => result.column === synthesis.column); const localChoice = local?.findings.find((finding) => finding.mutation_id === repair.mutation_id)?.recommended_patch_id; for (const sourceId of repair.source_artifact_ids) { const source = byId.get(sourceId); const neighborChoice = source?.findings.find((finding) => finding.mutation_id === repair.mutation_id)?.recommended_patch_id; if (source && source.column !== synthesis.column && neighborChoice === repair.patch_id && localChoice !== repair.patch_id) evidence.push({ mutationId: repair.mutation_id, synthesisColumn: synthesis.column, neighborColumn: source.column, sourceArtifactId: sourceId }); } } return evidence; }
function findCrossColumnConflicts(syntheses) { const choices = new Map(); const conflicts = []; for (const synthesis of syntheses) for (const repair of synthesis.repairs) { const previous = choices.get(repair.mutation_id); if (previous && previous.patchId !== repair.patch_id && previous.column !== synthesis.column) conflicts.push({ mutationId: repair.mutation_id, first: previous, second: { column: synthesis.column, patchId: repair.patch_id } }); else choices.set(repair.mutation_id, { column: synthesis.column, patchId: repair.patch_id }); } return conflicts; }
function learnings(summary) { return `# Cube preflight learnings\n\nRun: \`${summary.runId}\`\n\n- The complete bounded repair space took ${summary.solverOnly.durationMs} ms to enumerate and yielded ${summary.solverOnly.acceptedRepairs.length}/${suite.mutations.length} unique accepted repairs.\n- The equal-budget centralized Luna condition solved ${summary.centralized.acceptedMutations}/${suite.mutations.length} mutations in ${summary.centralized.providerCalls} calls and ${summary.centralized.totalTokens} tokens.\n- The layered Protein condition solved ${summary.layered.acceptedMutations}/${suite.mutations.length} mutations in ${summary.layered.providerCalls} calls and ${summary.layered.totalTokens} tokens.\n- Authoritative causal neighbor artifacts: ${summary.coordinationEvidence.causalNeighborArtifacts.length}. Cross-column integration conflicts: ${summary.coordinationEvidence.crossColumnIntegrationConflicts.length}.\n- Precommitted cube decision: **${summary.cubeGate.justified ? "proceed" : "stop"}** (${summary.cubeGate.reasons.join(", ") || "no gate condition fired"}).\n\nThis result measures one frozen finite suite. It does not imply that spatial multi-agent organization is useless; it says this task is ${summary.cubeGate.justified ? "sufficiently demanding to justify" : "too decomposable and cheaply enumerable to justify"} a 27-cell follow-up.\n`; }
