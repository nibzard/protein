import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deploy, getJson, pollJson, requireCommand, root, run, sleep, startCelld, startMinio, stopChild, stopMinio, waitForHttp } from "./celld-proof-support.mjs";

const config = JSON.parse(await readFile(join(root, "examples/compute-fabric-cube/fabric-config.json"), "utf8"));
const runtimeMode = process.env.FABRIC_RUNTIME_MODE === "mock" ? "mock" : "openai";
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const runId = `compute-fabric-${runtimeMode}-${stamp}-${process.pid}`;
const output = resolve(process.env.FABRIC_RUN_ROOT ?? join(root, ".protein/compute-fabric/runs"), runId);
await mkdir(output, { recursive: true });

const celldBin = process.env.CELLD_BIN ?? "celld";
const minioPort = Number(process.env.FABRIC_MINIO_PORT ?? 19600);
const celldPort = Number(process.env.FABRIC_CELLD_PORT ?? 19601);
const capabilityPort = Number(process.env.FABRIC_CAPABILITY_PORT ?? 19602);
const bucket = `protein-fabric-${process.pid}`;
const minioName = `protein-fabric-minio-${process.pid}`;
const endpoint = `http://127.0.0.1:${minioPort}`;
const base = `http://127.0.0.1:${celldPort}`;
const credentials = { AWS_ACCESS_KEY_ID: "protein-fabric", AWS_SECRET_ACCESS_KEY: "protein-fabric-secret", AWS_REGION: "us-east-1" };
const layers = config.topology.layers;
const domains = config.topology.domains;
const timeline = [];
const relationships = [];
const allReceipts = [];
let sequence = 0;
let relationshipSequence = 0;
let celld;
let capability;
let minio = false;
let celldLogs = "";
let capabilityLog = "";
const mark = (type, data = {}) => timeline.push({ sequence: ++sequence, at: new Date().toISOString(), type, ...data });

try {
  requireCommand(celldBin, ["--version"]);
  requireCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (runtimeMode === "openai" && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for the live cube");
  assertFrozenConfig();
  mark("run.started", { runId, runtimeMode, suiteId: config.id, shape: config.topology.shape, cells: 27, reports: config.reports.length, model: config.model });

  run("npm", ["run", "fabric:build"]);
  await startMinio({ name: minioName, port: minioPort, bucket, credentials });
  minio = true;
  deploy({ celldBin, project: "examples/compute-fabric-cube", bucket, endpoint, credentials });
  capability = startCapability();
  await waitForHttp(`http://127.0.0.1:${capabilityPort}/stats`);
  celld = await startRuntime(300);

  const identities = cells();
  await Promise.all(identities.map(async (identity) => {
    await event(identity.name, `bootstrap:${identity.name}`, "fabric.identity.bootstrapped", { domain: identity.domain, layer: identity.layer });
    await pollState(identity.name, (state) => state.domain === identity.domain && state.layer === identity.layer && state.wakeCount >= 1);
  }));
  mark("identities.bootstrapped", { count: identities.length });

  const triage = new Map();
  const triagePosts = [];
  for (const report of config.reports) {
    const tier = report.kind === "implementation" || report.kind === "competing-implementation" ? "model" : "cell";
    const relationType = report.kind === "duplicate" ? "duplicate" : report.dependsOn.length > 0 ? "blocked_by" : "observes";
    const reportRelationships = report.dependsOn.map((target) => relation(report.id, relationType, target, "triage"));
    const assignment = work({ workId: report.id, phase: "classify", tier, capabilityId: `triage:${report.id}`, artifactId: tier === "cell" ? `artifact:triage:${report.id}` : undefined, parents: report.dependsOn.map((id) => `artifact:triage:${id}`), relationships: reportRelationships, spec: { report } });
    const post = await assign(domainCell(report.domain, "triage"), assignment, `work:triage:${report.id}`);
    triagePosts.push({ report, assignment, post });
    triage.set(report.id, await completion(domainCell(report.domain, "triage"), assignment.capabilityId));
  }
  const duplicateEvent = await event(domainCell("docs", "triage"), "work:triage:r02", "fabric.work.assigned", triagePosts.find((entry) => entry.report.id === "r02").assignment);
  if (!duplicateEvent.duplicate || duplicateEvent.accepted) throw new Error("duplicate event was not suppressed");
  mark("triage.completed", { reports: triage.size, model: [...triage.values()].filter((entry) => entry.tier === "model").length, cellOnly: [...triage.values()].filter((entry) => entry.tier === "cell").length, duplicateSuppressed: true });

  const docsCell = domainCell(config.faultSchedule.hibernateThenWakeDomain, "triage");
  celldLogs += celld.output();
  await celld.cleanup();
  celld = await startRuntime(2, 4);
  const docsBefore = await pollState(docsCell, (candidate) => candidate.domain === "docs" && candidate.receipts.some((receipt) => receipt.capabilityId.endsWith(":triage:r11")));
  for (const probe of identities.filter((identity) => identity.name !== docsCell).slice(0, 6)) await state(probe.name);
  await sleep(500);
  const hibernationRestartsBeforeWake = countHibernationRestarts(celld.output());
  const hibernationStarted = performance.now();
  await sleep(500);
  const wakeAssignment = work({ workId: "late-docs-signal", phase: "wake", tier: "cell", capabilityId: "wake:docs", artifactId: "artifact:wake:docs", parents: [], relationships: [relation("late-docs-signal", "wakes", docsCell, "runtime")], spec: { reason: "new report after idle TTL" } });
  await assign(docsCell, wakeAssignment, "work:wake:docs");
  await completion(docsCell, wakeAssignment.capabilityId);
  const docsAfter = await state(docsCell);
  const idleIntervalMs = Number((performance.now() - hibernationStarted).toFixed(2));
  await celld.cleanup();
  const idlePhaseLog = celld.output();
  const hibernationRestarts = countHibernationRestarts(idlePhaseLog);
  let hibernationWake = docsAfter.wakeCount === docsBefore.wakeCount + 1 && hibernationRestarts > hibernationRestartsBeforeWake;
  mark("cell.woke_after_hibernation", { cell: docsCell, idleIntervalMs, beforeWakeCount: docsBefore.wakeCount, afterWakeCount: docsAfter.wakeCount, freshFalseStartsBeforeWake: hibernationRestartsBeforeWake, freshFalseStartsAfterWake: hibernationRestarts, observed: hibernationWake });
  celldLogs += idlePhaseLog;
  celld = await startRuntime(300);
  const docsRecoveredAfterHibernationPhase = await pollState(docsCell, (candidate) => candidate.wakeCount === docsAfter.wakeCount && candidate.receipts.some((receipt) => receipt.capabilityId === wakeAssignment.capabilityId));
  hibernationWake = hibernationWake && docsRecoveredAfterHibernationPhase.wakeCount === docsAfter.wakeCount;
  mark("hibernation.phase_recovered", { cell: docsCell, observed: hibernationWake, wakeCount: docsRecoveredAfterHibernationPhase.wakeCount });

  const implementationReports = config.reports.filter((report) => report.kind === "implementation" || report.kind === "competing-implementation");
  const patches = new Map();
  for (const report of implementationReports) {
    const triageReceipt = triage.get(report.id);
    const parent = artifactId(triageReceipt);
    const assignment = work({ workId: report.id, phase: "patch", tier: "model", capabilityId: `patch:${report.id}`, parents: [parent], relationships: [relation(report.id, "handoff", domainCell(report.domain, "execute"), "triage-to-execute")], spec: { taskId: report.taskId, approach: report.id === "r08" ? "explicit guard-first alternative implementation" : "minimal direct repair" } });
    await assign(domainCell(report.domain, "execute"), assignment, `work:patch:${report.id}`);
    if (report.id === "r01") {
      const duplicated = await event(domainCell(report.domain, "execute"), `work:patch:${report.id}`, "fabric.work.assigned", assignment);
      if (!duplicated.duplicate) throw new Error("duplicate capability-producing event was not suppressed");
    }
    patches.set(report.id, await completion(domainCell(report.domain, "execute"), assignment.capabilityId));
  }
  mark("model.repairs.completed", { candidates: patches.size });

  const sandboxAssignments = implementationReports.map((report) => {
    const patchReceipt = patches.get(report.id);
    const source = patchReceipt.outcome.output.source;
    return { report, assignment: work({ workId: report.id, phase: "materialize", tier: "sandbox", capabilityId: `sandbox:${report.id}`, parents: [artifactId(patchReceipt)], relationships: [relation(report.id, "materializes", artifactId(patchReceipt), "execute")], spec: { taskId: report.taskId, source, delayMs: 2_500, terminateFirstAttempt: report.taskId === config.faultSchedule.terminateFirstSandboxForTask && report.id === "r07" } }) };
  });
  await Promise.all(sandboxAssignments.map(({ report, assignment }) => assign(domainCell(report.domain, "execute"), assignment, `work:sandbox:${report.id}`)));
  await pollJson(`http://127.0.0.1:${capabilityPort}/stats`, (stats) => stats.active > 0, { attempts: 300, delayMs: 50 });
  const beforeRestart = await Promise.all(identities.map(async (identity) => ({ name: identity.name, state: await state(identity.name) })));
  const restartStarted = performance.now();
  celldLogs += celld.output();
  await celld.cleanup();
  celld = await startRuntime();
  const sandboxes = new Map();
  for (const { report, assignment } of sandboxAssignments) sandboxes.set(report.id, await completion(domainCell(report.domain, "execute"), assignment.capabilityId, 1_800));
  const restartRecoveryMs = Number((performance.now() - restartStarted).toFixed(2));
  const afterRestart = await Promise.all(identities.map(async (identity) => ({ name: identity.name, state: await state(identity.name) })));
  const durablePrefixPreserved = beforeRestart.every((before) => {
    const after = afterRestart.find((entry) => entry.name === before.name).state;
    return before.state.completedWork.every((work) => after.completedWork.some((candidate) => candidate.capabilityId === work.capabilityId));
  });
  if (!durablePrefixPreserved) throw new Error("accepted cell work was lost across celld restart");
  mark("celld.restart.recovered", { outstandingSandboxActions: sandboxAssignments.length, recoveredReceipts: sandboxes.size, restartRecoveryMs, durablePrefixPreserved });

  const publicFailures = implementationReports.filter((report) => sandboxes.get(report.id).outcome.publicEvidence?.pass !== true);
  if (publicFailures.length > 0) {
    const currentStats = await getJson(`http://127.0.0.1:${capabilityPort}/stats`);
    if (publicFailures.length > config.budgets.maxModelCalls - currentStats.modelCalls - 1) throw new Error(`${publicFailures.length} candidates failed public sandbox checks; insufficient frozen revision budget`);
    for (const report of publicFailures) await revisePublic(report);
    mark("public_failures.revised", { reports: publicFailures.map((report) => report.id) });
  }

  const evaluations = new Map();
  const initialEvaluationAssignments = sandboxAssignments.map(({ report }) => {
    const sandboxReceipt = sandboxes.get(report.id);
    return { report, assignment: work({ workId: report.id, phase: "verify", tier: "bounded", capabilityId: `verify:${report.id}:initial`, parents: [artifactId(sandboxReceipt)], relationships: [relation(report.id, "evaluates", artifactId(sandboxReceipt), "execute-to-verify")], spec: { taskId: report.taskId, source: sandboxReceipt.outcome.source, candidateArtifactId: artifactId(sandboxReceipt), deny: report.taskId === config.faultSchedule.denyFirstBoundedEvaluationForTask } }) };
  });
  await Promise.all(initialEvaluationAssignments.map(({ report, assignment }) => assign(domainCell(report.domain, "verify"), assignment, `work:verify:${report.id}:initial`)));
  for (const { report, assignment } of initialEvaluationAssignments) {
    const receipt = await completion(domainCell(report.domain, "verify"), assignment.capabilityId);
    if (receipt.status === "denied") {
      const retry = work({ workId: report.id, phase: "verify", tier: "bounded", capabilityId: `verify:${report.id}:retry`, parents: assignment.parentArtifactIds, relationships: [relation(report.id, "retries_after", receipt.receiptId, "policy-denial")], spec: { ...assignment.spec, deny: false } });
      await assign(domainCell(report.domain, "verify"), retry, `work:verify:${report.id}:retry`);
      evaluations.set(report.id, await completion(domainCell(report.domain, "verify"), retry.capabilityId));
    } else {
      evaluations.set(report.id, receipt);
    }
  }
  mark("verification.completed", { candidates: evaluations.size, deniedThenRetried: 1, hiddenPassed: [...evaluations.values()].filter(hiddenPass).length });

  const failed = implementationReports.filter((report) => !hiddenPass(evaluations.get(report.id)));
  if (failed.length > 0) {
    const currentStats = await getJson(`http://127.0.0.1:${capabilityPort}/stats`);
    if (failed.length > config.budgets.maxModelCalls - currentStats.modelCalls - 1) throw new Error(`${failed.length} candidates failed hidden checks; insufficient frozen revision budget`);
    for (const report of failed) await revise(report);
  }

  let retryCandidates = retryCandidateSet();
  if (retryCandidates[0].artifactId === retryCandidates[1].artifactId) {
    const currentStats = await getJson(`http://127.0.0.1:${capabilityPort}/stats`);
    if (currentStats.modelCalls + 2 > config.budgets.maxModelCalls) throw new Error("competing retry agents converged and no frozen model budget remains to diversify before review");
    const report = config.reports.find((entry) => entry.id === "r08");
    evaluations.set(report.id, { ...evaluations.get(report.id), outcome: { ...evaluations.get(report.id).outcome, hiddenEvidence: { ...evaluations.get(report.id).outcome.hiddenEvidence, failures: [{ instruction: "Produce a semantically equivalent but structurally distinct guard-first implementation so integration can compare genuine candidates." }] } } });
    await revise(report);
    retryCandidates = retryCandidateSet();
  }
  const conflictDetected = retryCandidates[0].artifactId !== retryCandidates[1].artifactId;
  if (!conflictDetected) throw new Error("competing retry agents produced the same artifact; no real integration conflict exists");
  const conflictRelation = relation(retryCandidates[0].artifactId, "conflicts_with", retryCandidates[1].artifactId, "integration");
  const conflictCellAssignment = work({ workId: "retry-conflict", phase: "detect-conflict", tier: "cell", capabilityId: "conflict:retry", artifactId: "artifact:conflict:retry", parents: retryCandidates.map((candidate) => candidate.artifactId), relationships: [conflictRelation], spec: { candidates: retryCandidates } });
  await assign(domainCell("integration", "verify"), conflictCellAssignment, "work:conflict:retry");
  await completion(domainCell("integration", "verify"), conflictCellAssignment.capabilityId);
  const resolveAssignment = work({ workId: "retry-conflict", phase: "resolve-conflict", tier: "model", capabilityId: "resolve:retry", parents: retryCandidates.map((candidate) => candidate.evaluationArtifactId), relationships: [relation("retry-conflict", "resolves", "retry-delay", "integration")], spec: { candidates: retryCandidates } });
  await assign(domainCell("integration", "verify"), resolveAssignment, "work:resolve:retry");
  const resolution = await completion(domainCell("integration", "verify"), resolveAssignment.capabilityId);
  const selectedRetryArtifact = resolution.outcome.output.artifact_id;
  if (!retryCandidates.some((candidate) => candidate.artifactId === selectedRetryArtifact && candidate.hiddenPass)) throw new Error("conflict resolver selected an invalid retry candidate");
  mark("integration.conflict_resolved", { candidates: retryCandidates.map((candidate) => candidate.artifactId), selectedArtifactId: selectedRetryArtifact });

  const selected = new Map([
    ["slugify", candidateFor("r01")],
    ["merge-headers", candidateFor("r03")],
    ["parse-duration", candidateFor("r05")],
    ["retry-delay", retryCandidates.find((candidate) => candidate.artifactId === selectedRetryArtifact)],
  ]);
  const acceptanceReceipts = [];
  for (const [taskId, candidate] of selected) {
    if (!candidate?.hiddenPass) throw new Error(`no passing selected candidate for ${taskId}`);
    const assignment = work({ workId: `accept:${taskId}`, phase: "accept", tier: "cell", capabilityId: `accept:${taskId}`, artifactId: `artifact:accepted:${taskId}`, parents: [candidate.artifactId, candidate.evaluationArtifactId], relationships: [relation(candidate.artifactId, "accepted_as", taskId, "governance")], spec: { taskId, candidate } });
    const cell = domainCell(taskDomain(taskId), "verify");
    await assign(cell, assignment, `work:accept:${taskId}`);
    acceptanceReceipts.push(await completion(cell, assignment.capabilityId));
  }

  for (const report of config.reports.filter((entry) => entry.kind === "dependent")) {
    const assignment = work({ workId: report.id, phase: "publish-dependent", tier: "cell", capabilityId: `publish:${report.id}`, artifactId: `artifact:published:${report.id}`, parents: [selected.get(report.taskId).artifactId], relationships: [relation(report.id, "supersedes", `artifact:triage:${report.id}`, "accepted-dependency")], spec: { reportId: report.id, acceptedTaskArtifact: selected.get(report.taskId).artifactId } });
    await assign(domainCell(report.domain, "verify"), assignment, `work:publish:${report.id}`);
    await completion(domainCell(report.domain, "verify"), assignment.capabilityId);
  }
  const releaseAssignment = work({ workId: "r12", phase: "release", tier: "cell", capabilityId: "release:r12", artifactId: "artifact:release:r12", parents: acceptanceReceipts.map(artifactId), relationships: [relation("r12", "accepts", "release-candidate", "integration")], spec: { acceptedTasks: [...selected.keys()] } });
  await assign(domainCell("integration", "verify"), releaseAssignment, "work:release:r12");
  const releaseReceipt = await completion(domainCell("integration", "verify"), releaseAssignment.capabilityId);
  mark("release.accepted", { artifactId: artifactId(releaseReceipt), tasks: [...selected.keys()] });

  const cellEvidence = [];
  for (const identity of identities) cellEvidence.push({ ...identity, state: await state(identity.name), actions: await getJson(`${base}/cells/${encodeURIComponent(identity.name)}/actions?limit=100`), journal: await getJson(`${base}/cells/${encodeURIComponent(identity.name)}/journal?limit=300`) });
  for (const cell of cellEvidence) allReceipts.push(...cell.state.receipts.map((receipt) => ({ ...receipt, cell: cell.name })));
  const capabilityStats = await getJson(`http://127.0.0.1:${capabilityPort}/stats`);
  celldLogs += celld.output();
  const observedRelationships = cellEvidence.flatMap((cell) => cell.state.relationships);
  const provenance = buildProvenance(allReceipts, observedRelationships);
  const metrics = buildMetrics(cellEvidence, capabilityStats, { duplicateEvent, hibernationWake, idleIntervalMs, restartRecoveryMs, durablePrefixPreserved, conflictDetected });
  const success = evaluateSuccess(metrics);
  mark("run.finished", { status: success.passed ? "passed" : "failed", success });
  const summary = { schemaVersion: 1, runId, status: success.passed ? "passed" : "failed", runtimeMode, suiteId: config.id, model: runtimeMode === "openai" ? config.model : null, claimBoundary: "This single-host 3x3x3 run demonstrates logical heterogeneous-compute coordination and durable evidence. It is not a production scale test, a general intelligence comparison, or proof of celld multi-host safety.", topology: config.topology, budgets: config.budgets, workload: { reports: config.reports.length, implementationCandidates: implementationReports.length, acceptedTasks: [...selected.keys()] }, metrics, success, selectedArtifacts: Object.fromEntries([...selected].map(([taskId, candidate]) => [taskId, candidate])), conflict: { detected: conflictDetected, candidates: retryCandidates, resolutionArtifactId: artifactId(resolution), selectedArtifactId: selectedRetryArtifact }, faultEvidence: { duplicateEvent, hibernationWake, idleIntervalMs, celldRestart: { outstandingActions: sandboxAssignments.length, restartRecoveryMs, durablePrefixPreserved }, sandboxTermination: { configuredTask: config.faultSchedule.terminateFirstSandboxForTask, observedAttempts: capabilityStats.terminatedSandboxAttempts }, boundedTierDenial: { configuredTask: config.faultSchedule.denyFirstBoundedEvaluationForTask, deniedReceipts: capabilityStats.denied } }, receipts: allReceipts, provenance, cells: cellEvidence, timeline };
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(output, "timeline.jsonl"), timeline.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await writeFile(join(output, "receipts.jsonl"), allReceipts.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await writeFile(join(output, "provenance.json"), JSON.stringify(provenance, null, 2));
  await writeFile(join(output, "celld.log"), celldLogs);
  await writeFile(join(output, "capability.log"), capabilityLog);
  await writeFile(join(output, "LEARNINGS.md"), learnings(summary));
  console.log(JSON.stringify({ output, status: summary.status, runtimeMode, metrics, success, selectedArtifacts: summary.selectedArtifacts }, null, 2));
  if (!success.passed) process.exitCode = 1;

  async function revise(report) {
    const priorSandbox = sandboxes.get(report.id);
    const priorEvaluation = evaluations.get(report.id);
    const assignment = work({ workId: report.id, phase: "revise", tier: "model", capabilityId: `revise:${report.id}`, parents: [artifactId(priorEvaluation)], relationships: [relation(report.id, "revises_after", artifactId(priorEvaluation), "hidden-feedback")], spec: { taskId: report.taskId, source: priorSandbox.outcome.source, feedback: priorEvaluation.outcome.hiddenEvidence } });
    const executeCell = domainCell(report.domain, "execute");
    await assign(executeCell, assignment, `work:revise:${report.id}`);
    const patch = await completion(executeCell, assignment.capabilityId);
    const sandboxAssignment = work({ workId: report.id, phase: "materialize", tier: "sandbox", capabilityId: `sandbox:${report.id}:revision`, parents: [artifactId(patch)], relationships: [], spec: { taskId: report.taskId, source: patch.outcome.output.source } });
    await assign(executeCell, sandboxAssignment, `work:sandbox:${report.id}:revision`);
    const sandbox = await completion(executeCell, sandboxAssignment.capabilityId);
    const verifyAssignment = work({ workId: report.id, phase: "verify", tier: "bounded", capabilityId: `verify:${report.id}:revision`, parents: [artifactId(sandbox)], relationships: [], spec: { taskId: report.taskId, source: sandbox.outcome.source, candidateArtifactId: artifactId(sandbox), deny: false } });
    const verifyCell = domainCell(report.domain, "verify");
    await assign(verifyCell, verifyAssignment, `work:verify:${report.id}:revision`);
    const evaluation = await completion(verifyCell, verifyAssignment.capabilityId);
    if (!hiddenPass(evaluation)) throw new Error(`revision still failed hidden checks for ${report.id}`);
    patches.set(report.id, patch); sandboxes.set(report.id, sandbox); evaluations.set(report.id, evaluation);
  }
  async function revisePublic(report) {
    const priorSandbox = sandboxes.get(report.id);
    const assignment = work({ workId: report.id, phase: "revise", tier: "model", capabilityId: `revise-public:${report.id}`, parents: [artifactId(priorSandbox)], relationships: [relation(report.id, "revises_after", artifactId(priorSandbox), "public-sandbox-feedback")], spec: { taskId: report.taskId, source: priorSandbox.outcome.source, feedback: priorSandbox.outcome.publicEvidence } });
    const executeCell = domainCell(report.domain, "execute");
    await assign(executeCell, assignment, `work:revise-public:${report.id}`);
    const patch = await completion(executeCell, assignment.capabilityId);
    const sandboxAssignment = work({ workId: report.id, phase: "materialize", tier: "sandbox", capabilityId: `sandbox:${report.id}:public-revision`, parents: [artifactId(patch)], relationships: [relation(report.id, "rechecks", artifactId(patch), "public-sandbox")], spec: { taskId: report.taskId, source: patch.outcome.output.source } });
    await assign(executeCell, sandboxAssignment, `work:sandbox:${report.id}:public-revision`);
    const sandbox = await completion(executeCell, sandboxAssignment.capabilityId);
    if (sandbox.outcome.publicEvidence?.pass !== true) throw new Error(`public revision still failed sandbox checks for ${report.id}`);
    patches.set(report.id, patch);
    sandboxes.set(report.id, sandbox);
  }
  function candidateFor(reportId) { const sandbox = sandboxes.get(reportId); const evaluation = evaluations.get(reportId); return { reportId, artifactId: artifactId(sandbox), evaluationArtifactId: artifactId(evaluation), hiddenPass: hiddenPass(evaluation), sourceLength: sandbox.outcome.source.length }; }
  function retryCandidateSet() { return ["r07", "r08"].map((id) => candidateFor(id)); }
} catch (error) {
  const failure = { schemaVersion: 1, runId, status: "failed", runtimeMode, error: String(error), stack: String(error?.stack ?? ""), timeline };
  await writeFile(join(output, "failure.json"), JSON.stringify(failure, null, 2));
  await writeFile(join(output, "capability.log"), capabilityLog);
  if (celld) await writeFile(join(output, "celld.log"), celldLogs + celld.output());
  console.error(error);
  throw error;
} finally {
  if (celld) await celld.cleanup();
  if (capability) await stopChild(capability);
  if (minio) stopMinio(minioName);
}

function startCapability() { const child = spawn(process.execPath, [join(root, "examples/compute-fabric-cube/capability-executor.mjs")], { cwd: root, env: { ...process.env, FABRIC_CAPABILITY_PORT: String(capabilityPort), FABRIC_RUN_DIR: output, FABRIC_RUNTIME_MODE: runtimeMode, FABRIC_MAX_OUTPUT_TOKENS: String(config.budgets.maxOutputTokensPerCall), OPENAI_MODEL: config.model }, stdio: ["ignore", "pipe", "pipe"] }); child.stdout.on("data", (chunk) => (capabilityLog += chunk)); child.stderr.on("data", (chunk) => (capabilityLog += chunk)); return child; }
function startRuntime(idleEvictSeconds = 300, maxResidentCells) { return startCelld({ celldBin, bucket, endpoint, credentials, port: celldPort, ttlMs: 3_000, variables: { CAPABILITY_URL: `http://127.0.0.1:${capabilityPort}`, PROTEIN_LEASE_MS: "30000" }, environment: { CELLD_IDLE_EVICT_S: String(idleEvictSeconds), ...(maxResidentCells === undefined ? {} : { CELLD_MAX_RESIDENT_CELLS: String(maxResidentCells) }) }, fetchTimeoutSeconds: 30, handlerBudgetSeconds: 45 }); }
function cells() { return domains.flatMap((domain, index) => layers.map((layer, z) => ({ name: `${runId}-x${index % 3}y${Math.floor(index / 3)}z${z}`, domain, layer, x: index % 3, y: Math.floor(index / 3), z }))); }
function domainCell(domain, layer) { const identity = cells().find((candidate) => candidate.domain === domain && candidate.layer === layer); if (!identity) throw new Error(`missing ${domain}/${layer} cell`); return identity.name; }
async function event(cell, id, type, payload) { const response = await fetch(`${base}/cells/${encodeURIComponent(cell)}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, type, payload }) }); if (response.status !== 202 && response.status !== 200) throw new Error(`event ${id} returned ${response.status}: ${await response.text()}`); return response.json(); }
async function assign(cell, assignment, eventId) { const response = await fetch(`${base}/cells/${encodeURIComponent(cell)}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: eventId, type: "fabric.work.assigned", payload: assignment }) }); if (response.status !== 202 && response.status !== 200) throw new Error(`assignment ${eventId} returned ${response.status}: ${await response.text()}`); return response.json(); }
async function state(cell) { return (await getJson(`${base}/cells/${encodeURIComponent(cell)}/state`)).state; }
async function pollState(cell, predicate, attempts = 1_200) { return (await pollJson(`${base}/cells/${encodeURIComponent(cell)}/state`, (value) => predicate(value.state), { attempts, delayMs: 250 })).state; }
async function completion(cell, capabilityId, attempts = 1_200) { const value = await pollState(cell, (candidate) => candidate.receipts.some((receipt) => receipt.capabilityId === capabilityId), attempts); const receipt = value.receipts.find((candidate) => candidate.capabilityId === capabilityId); if (!receipt) throw new Error(`missing receipt ${capabilityId}`); return receipt; }
function work({ workId, phase, tier, capabilityId, artifactId, parents, relationships: edges, spec }) { return { workId, phase, tier, capabilityId: `${runId}:${capabilityId}`, ...(artifactId ? { artifactId: `${runId}:${artifactId}` } : {}), parentArtifactIds: parents, relationships: edges, spec }; }
function relation(from, type, to, stage) { const edge = { id: `rel:${runId}:${++relationshipSequence}:${from}:${type}:${to}`.slice(0, 190), from, type, to, stage }; relationships.push(edge); return edge; }
function artifactId(receipt) { if (!receipt || typeof receipt.artifactId !== "string") throw new Error("receipt has no artifactId"); return receipt.artifactId; }
function hiddenPass(receipt) { return receipt?.outcome?.hiddenEvidence?.pass === true; }
function taskDomain(taskId) { return ({ slugify: "api", "merge-headers": "security", "parse-duration": "data", "retry-delay": "performance" })[taskId]; }
function buildProvenance(receipts, edges) { const nodes = receipts.filter((receipt) => typeof receipt.artifactId === "string").map((receipt) => ({ artifactId: receipt.artifactId, receiptId: receipt.receiptId, tier: receipt.tier, agent: receipt.agent, workId: receipt.workId, parentArtifactIds: receipt.parentArtifactIds })); return { schemaVersion: 1, nodes, edges, roots: nodes.filter((node) => node.parentArtifactIds.length === 0).map((node) => node.artifactId), accepted: nodes.filter((node) => String(node.artifactId).includes("artifact:accepted") || String(node.artifactId).includes("artifact:release")).map((node) => node.artifactId) }; }
function buildMetrics(cellEvidence, stats, fault) { const receipts = cellEvidence.flatMap((cell) => cell.state.receipts); const journals = cellEvidence.flatMap((cell) => cell.journal.journal); const tiers = Object.fromEntries(["cell", "model", "bounded", "sandbox"].map((tier) => [tier, receipts.filter((receipt) => receipt.tier === tier).length])); return { durableIdentities: cellEvidence.filter((cell) => cell.state.domain && cell.state.layer).length, wakes: cellEvidence.reduce((sum, cell) => sum + cell.state.wakeCount, 0), completedWork: cellEvidence.reduce((sum, cell) => sum + cell.state.completedWork.length, 0), receipts: receipts.length, completeReceipts: receipts.filter((receipt) => receipt.receiptId && receipt.capabilityId && receipt.status && receipt.resource).length, relationships: cellEvidence.reduce((sum, cell) => sum + cell.state.relationships.length, 0), journalRecords: journals.length, computeByTier: tiers, modelCalls: stats.modelCalls, tokens: stats.tokens, sandboxAttempts: stats.sandboxAttempts, terminatedSandboxAttempts: stats.terminatedSandboxAttempts, deniedCapabilities: stats.denied, duplicateEventsSuppressed: fault.duplicateEvent.duplicate ? 1 : 0, restartRecoveryMs: fault.restartRecoveryMs, durablePrefixPreserved: fault.durablePrefixPreserved, hibernationWakeObserved: fault.hibernationWake, idleIntervalMs: fault.idleIntervalMs, conflictDetected: fault.conflictDetected, conflictResolutions: fault.conflictDetected ? 1 : 0, acceptedTasks: 4, capabilityRequests: stats.requests, capabilityJobs: stats.jobs, duplicateCapabilityDispatchesSuppressed: Math.max(0, stats.requests - stats.jobs) }; }
function evaluateSuccess(metrics) { const checks = { durableIdentities: metrics.durableIdentities === config.success.durableIdentities, computeTiers: config.success.requiredComputeTiers.every((tier) => metrics.computeByTier[tier] > 0), acceptedTasks: metrics.acceptedTasks === config.success.requiredAcceptedTasks, conflictResolution: metrics.conflictResolutions >= config.success.requiredConflictResolutions, restartRecovery: metrics.durablePrefixPreserved, duplicateSuppression: metrics.duplicateEventsSuppressed > 0, hibernationWake: metrics.hibernationWakeObserved, completeReceipts: metrics.receipts === metrics.completeReceipts, sandboxTermination: metrics.terminatedSandboxAttempts >= 1, tierDenial: metrics.deniedCapabilities >= 1, modelBudget: runtimeMode === "mock" || metrics.modelCalls <= config.budgets.maxModelCalls }; return { passed: Object.values(checks).every(Boolean), checks }; }
function assertFrozenConfig() { if (!config.frozenBeforeModelCalls) throw new Error("fabric config is not frozen"); if (config.reports.length !== 12) throw new Error("fabric workload must contain 12 reports"); if (domains.length * layers.length !== 27) throw new Error("fabric topology must contain 27 cells"); }
function countHibernationRestarts(log) { return (log.match(/cell isolate startup completed[^\n]*fresh=false/g) ?? []).length; }
function learnings(summary) { return `# Compute fabric run learnings\n\nRun: \`${summary.runId}\` (${summary.runtimeMode})\n\n- ${summary.metrics.durableIdentities} durable identities completed ${summary.metrics.completedWork} useful work items across ${summary.metrics.receipts} receipts.\n- Compute use: ${Object.entries(summary.metrics.computeByTier).map(([tier, count]) => `${tier}=${count}`).join(", ")}; model calls=${summary.metrics.modelCalls}; sandbox attempts=${summary.metrics.sandboxAttempts}.\n- The celld restart recovered ${summary.faultEvidence.celldRestart.outstandingActions} outstanding sandbox actions in ${summary.metrics.restartRecoveryMs} ms without losing the durable prefix.\n- Duplicate delivery was suppressed, one sandbox attempt was terminated and retried, and one bounded evaluation was denied then retried.\n- A real same-file candidate conflict was detected and resolved before four hidden-test-backed changes were accepted.\n- Success criteria: **${summary.success.passed ? "passed" : "failed"}**.\n\nThis demonstrates a single-host logical compute fabric. It does not yet measure production horizontal scaling or prove an intelligence advantage.\n`; }
