import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const runDirectory = resolve(process.argv[2] ?? ".protein/compute-fabric/runs/compute-fabric-openai-20260811071417338-2078129");
const summary = JSON.parse(await readFile(join(runDirectory, "summary.json"), "utf8"));
const failures = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (!condition) failures.push(message); };

check(summary.status === "passed", "run did not pass");
check(summary.runtimeMode === "openai", "run was not live OpenAI mode");
check(summary.metrics.durableIdentities === 27, "missing durable identities");
check(summary.receipts.length === summary.metrics.receipts, "receipt count mismatch");
check(summary.receipts.every((receipt) => receipt.receiptId && receipt.capabilityId && receipt.resource && receipt.completedAt), "incomplete receipt");
check(new Set(summary.receipts.map((receipt) => receipt.receiptId)).size === summary.receipts.length, "duplicate receipt identity");
check(new Set(summary.receipts.map((receipt) => receipt.capabilityId)).size === summary.receipts.length, "duplicate capability identity");
check(["cell", "model", "bounded", "sandbox"].every((tier) => summary.metrics.computeByTier[tier] > 0), "not all compute tiers were used");
check(summary.metrics.modelCalls <= summary.budgets.maxModelCalls, "model call budget exceeded");
check(summary.receipts.filter((receipt) => receipt.tier === "model").every((receipt) => receipt.provider?.responseId && receipt.provider?.model === "gpt-5.6-luna"), "model receipt lacks provider evidence");
check(summary.metrics.capabilityRequests - summary.metrics.capabilityJobs === 1, "expected one reconciled duplicate capability dispatch");
check(summary.metrics.terminatedSandboxAttempts === 1, "sandbox termination fault not observed exactly once");
check(summary.metrics.deniedCapabilities === 1, "bounded-tier denial not observed exactly once");
check(summary.faultEvidence.celldRestart.durablePrefixPreserved === true, "durable prefix was not preserved");
check(summary.faultEvidence.celldRestart.outstandingActions === 5, "restart did not cover five outstanding actions");
check(summary.conflict.detected && summary.conflict.candidates.length === 2, "integration conflict evidence missing");
check(summary.conflict.candidates.every((candidate) => candidate.hiddenPass), "conflict candidate lacked hidden-test evidence");
check(summary.conflict.candidates.some((candidate) => candidate.artifactId === summary.conflict.selectedArtifactId), "resolver selected an unknown artifact");
check(Object.keys(summary.selectedArtifacts).length === 4 && Object.values(summary.selectedArtifacts).every((candidate) => candidate.hiddenPass), "four passing accepted tasks were not preserved");

const nodes = new Map(summary.provenance.nodes.map((node) => [node.artifactId, node]));
const release = summary.provenance.nodes.find((node) => String(node.artifactId).includes("artifact:release:r12"));
check(release !== undefined, "release provenance node missing");
const reachable = new Set();
if (release) visit(release.artifactId);
for (const candidate of Object.values(summary.selectedArtifacts)) {
  check(reachable.has(candidate.artifactId), `selected candidate ${candidate.artifactId} is not reachable from release`);
  check(reachable.has(candidate.evaluationArtifactId), `evaluation ${candidate.evaluationArtifactId} is not reachable from release`);
}

const result = { schemaVersion: 1, runId: summary.runId, audit: "protein-compute-fabric-evidence/v1", passed: failures.length === 0, checks, failures, replay: { releaseArtifactId: release?.artifactId ?? null, reachableArtifacts: reachable.size, selectedTasks: Object.keys(summary.selectedArtifacts) } };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;

function visit(artifactId) {
  if (reachable.has(artifactId)) return;
  const node = nodes.get(artifactId);
  if (!node) return;
  reachable.add(artifactId);
  for (const parent of node.parentArtifactIds) visit(parent);
}
