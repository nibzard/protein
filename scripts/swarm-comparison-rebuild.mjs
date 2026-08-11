import { constants } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAttemptIntegrityAudit,
  buildComparisonSummary,
  buildFixedQualityComparisonSummary,
  projectSwarmRun,
} from "./swarm-comparison.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const comparisonsRoot = resolve(
  process.env.SWARM_COMPARISON_ROOT ?? join(workspace, ".protein/cellular-agent-swarm/comparisons"),
);
const runsRoot = resolve(
  process.env.SWARM_RUN_ROOT ?? join(workspace, ".protein/cellular-agent-swarm/celld-runs"),
);
const pointerPath = join(comparisonsRoot, "latest.json");
const pointer = await readJson(pointerPath);
const outputDirectory = safeChildPath(pointer.outputDirectory, comparisonsRoot);
const summaryPath = join(outputDirectory, "summary.json");
const preIntegrityAuditSummaryPath = join(outputDirectory, "summary.pre-integrity-audit.json");
const existing = await readJson(summaryPath);
if (existing.comparisonId !== pointer.comparisonId || existing.evidenceLevel !== "celld-comparison") {
  throw new Error("Latest comparison pointer and summary identity do not match");
}
const trials = await Promise.all(existing.trials.map(async (trial) => ({
  trial: trial.trial,
  order: trial.order,
  conditions: Object.fromEntries(await Promise.all(["local", "isolated"].map(async (condition) => {
    const prior = trial.conditions?.[condition];
    if (typeof prior?.summaryPath !== "string") return [condition, prior ?? null];
    const runSummaryPath = safeChildPath(prior.summaryPath, runsRoot);
    const runDirectory = dirname(runSummaryPath);
    const [summary, manifest, seed, serviceSnapshots, qualityTarget] = await Promise.all([
      readJson(runSummaryPath),
      readJson(join(runDirectory, "manifest.json")),
      readJsonIfPresent(join(runDirectory, "seed.json")),
      readJsonIfPresent(join(runDirectory, "service-snapshots.json")),
      readJsonIfPresent(join(runDirectory, "quality-target.json")),
    ]);
    return [condition, projectSwarmRun({
      summary,
      manifest,
      seed,
      serviceSnapshots,
      qualityTarget,
      summaryPath: runSummaryPath,
    })];
  }))),
})));

const builder = existing.config?.objective === "cost_to_fixed_verified_quality"
  ? buildFixedQualityComparisonSummary
  : buildComparisonSummary;
const attempts = existing.config?.objective === "cost_to_fixed_verified_quality"
  ? await Promise.all((Array.isArray(existing.attempts) ? existing.attempts : []).map(enrichAttemptIntegrity))
  : existing.attempts;
const rebuilt = builder({
  comparisonId: existing.comparisonId,
  startedAt: existing.startedAt,
  completedAt: existing.completedAt,
  config: existing.config,
  trials,
  attempts,
  calibration: existing.calibration,
});
if (existing.config?.objective === "cost_to_fixed_verified_quality") {
  rebuilt.artifacts.preIntegrityAuditSummary = "summary.pre-integrity-audit.json";
  await copyIfAbsent(summaryPath, preIntegrityAuditSummaryPath);
}
await writeFile(summaryPath, `${JSON.stringify(rebuilt, null, 2)}\n`);
await writeFile(pointerPath, `${JSON.stringify({
  ...pointer,
  status: rebuilt.status,
}, null, 2)}\n`);
console.log(JSON.stringify({
  comparisonId: rebuilt.comparisonId,
  status: rebuilt.status,
  conclusion: existing.config?.objective === "cost_to_fixed_verified_quality"
    ? rebuilt.aggregate.fixedQuality.conclusion.code
    : rebuilt.aggregate.conclusion.code,
  summaryPath,
}));

async function enrichAttemptIntegrity(attempt) {
  if (typeof attempt?.runId !== "string" || attempt.runId.length === 0) {
    return {
      ...attempt,
      integrityAudit: buildAttemptIntegrityAudit({
        attempt,
        comparisonId: existing.comparisonId,
      }),
    };
  }
  const runDirectory = safeChildPath(resolve(runsRoot, attempt.runId), runsRoot);
  const [summary, manifest, modelGatewayPrivateState, qualityTarget] = await Promise.all([
    readJsonIfPresent(join(runDirectory, "summary.json")),
    readJsonIfPresent(join(runDirectory, "manifest.json")),
    readJsonIfPresent(join(runDirectory, "model-gateway-private-state.json")),
    readJsonIfPresent(join(runDirectory, "quality-target.json")),
  ]);
  return {
    ...attempt,
    integrityAudit: buildAttemptIntegrityAudit({
      attempt,
      comparisonId: existing.comparisonId,
      summary,
      manifest,
      modelGatewayPrivateState,
      qualityTarget,
    }),
  };
}

function safeChildPath(value, parent) {
  if (typeof value !== "string") throw new Error("Comparison pointer has no outputDirectory");
  const path = resolve(value);
  if (path !== parent && !path.startsWith(`${parent}${sep}`)) {
    throw new Error("Comparison pointer escapes SWARM_COMPARISON_ROOT");
  }
  return path;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfPresent(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function copyIfAbsent(source, destination) {
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}
