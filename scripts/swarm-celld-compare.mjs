import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildComparisonSummary,
  buildFixedQualityComparisonSummary,
  comparisonControlFingerprint,
  CONDITIONS,
  projectSwarmRun,
} from "./swarm-comparison.mjs";
import { runArtifactSandbox } from "../examples/cellular-agent-swarm/artifact-sandbox.mjs";
import {
  BASELINE_SOURCE,
  PUBLIC_CASES,
} from "../examples/cellular-agent-swarm/artifact-task.mjs";
import {
  PROMPT_VERSION,
  RESPONSES_PROTOCOL,
  TOOL_SCHEMA_SHA256,
  TOOL_SCHEMA_VERSION,
} from "../examples/cellular-agent-swarm/openai-responses.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = join(workspace, "scripts/swarm-celld-run.mjs");
const runsRoot = resolve(
  process.env.SWARM_RUN_ROOT ?? join(workspace, ".protein/cellular-agent-swarm/celld-runs"),
);
const comparisonsRoot = resolve(
  process.env.SWARM_COMPARISON_ROOT ?? join(workspace, ".protein/cellular-agent-swarm/comparisons"),
);
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const objective = process.env.SWARM_COMPARISON_OBJECTIVE === "cost_to_fixed_verified_quality"
  ? "cost_to_fixed_verified_quality"
  : "best_verified_quality";
const fixedQualityMode = objective === "cost_to_fixed_verified_quality";
const comparisonId = `celld-swarm-${fixedQualityMode ? "cost-target" : "comparison"}-${timestamp}-${process.pid}`;
const outputDirectory = join(comparisonsRoot, comparisonId);
const attemptDirectory = join(outputDirectory, "attempts");
const startedAt = new Date().toISOString();
const config = {
  responsesProtocol: RESPONSES_PROTOCOL,
  model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
  reasoningEffort: process.env.OPENAI_REASONING_EFFORT ?? "low",
  promptVersion: PROMPT_VERSION,
  toolSchemaVersion: TOOL_SCHEMA_VERSION,
  toolSchemaSha256: TOOL_SCHEMA_SHA256,
  modelMaxOutputTokens: boundedInteger(process.env.SWARM_MODEL_MAX_OUTPUT_TOKENS, 1_200, 256, 8_192),
  publicBenchmarkConcurrency: 1,
  hiddenBenchmarkConcurrency: 1,
  benchmarkId: process.env.SWARM_EXPECTED_BENCHMARK_ID ?? "sorted-unique-int32/v3",
  evaluatorVersion: process.env.SWARM_EXPECTED_EVALUATOR_VERSION ?? "protein-swarm-evaluator/v3",
  conditions: CONDITIONS,
  rows: boundedInteger(process.env.SWARM_ROWS, 4, 1, 12),
  columns: boundedInteger(process.env.SWARM_COLUMNS, 4, 1, 12),
  generations: boundedInteger(process.env.SWARM_GENERATIONS, 4, 1, 20),
  trials: boundedInteger(process.env.SWARM_TRIALS, fixedQualityMode ? 10 : 3, 1, 20),
  creditsPerCell: boundedInteger(process.env.SWARM_CREDITS_PER_CELL, 24, 1, 10_000),
  maxModelTurns: boundedInteger(process.env.SWARM_MAX_MODEL_TURNS, 4, 1, 8),
  maxToolCalls: boundedInteger(process.env.SWARM_MAX_TOOL_CALLS, 3, 0, 7),
  dispatchConcurrency: boundedInteger(process.env.SWARM_DISPATCH_CONCURRENCY, 8, 1, 16),
  providerTimeoutMs: boundedInteger(process.env.SWARM_MODEL_TIMEOUT_MS, 35_000, 5_000, 120_000),
  providerMaximumAttempts: boundedInteger(process.env.SWARM_MODEL_MAX_ATTEMPTS, fixedQualityMode ? 1 : 2, 1, 5),
  conditionMaximumAttempts: boundedInteger(process.env.SWARM_CONDITION_MAX_ATTEMPTS, 2, 1, 3),
  meaningfulThresholdPct: boundedNumber(process.env.SWARM_MEANINGFUL_THRESHOLD_PCT, 5, 0, 100),
  objective,
  ...(fixedQualityMode ? {
    primaryResource: "responsesTokens",
    qualityTargetProtocol: "protein-fixed-quality-recheck/v1",
    qualityTargetMultiplier: boundedNumber(process.env.SWARM_QUALITY_TARGET_MULTIPLIER, 3, 1, 20),
    qualityTargetRechecks: boundedInteger(process.env.SWARM_QUALITY_TARGET_RECHECK_PAIRS, 9, 3, 20),
    qualityTargetRequiredRatios: boundedInteger(process.env.SWARM_QUALITY_TARGET_REQUIRED_RATIOS, 8, 1, 20),
    qualityTargetBlockSize: boundedInteger(process.env.SWARM_QUALITY_TARGET_BLOCK_SIZE, 4, 1, 8),
    qualityTargetMaximumBaselineDrift: boundedNumber(process.env.SWARM_QUALITY_TARGET_MAX_BASELINE_DRIFT, 1.15, 1, 2),
    meaningfulCostDeltaPct: boundedNumber(process.env.SWARM_MEANINGFUL_COST_DELTA_PCT, 5, 0, 100),
    minimumComparablePairs: boundedInteger(process.env.SWARM_MINIMUM_COMPARABLE_PAIRS, 6, 1, 20),
    alpha: boundedNumber(process.env.SWARM_PRIMARY_ALPHA, 0.05, 0.001, 0.5),
    bootstrapSamples: boundedInteger(process.env.SWARM_BOOTSTRAP_SAMPLES, 10_000, 100, 100_000),
    bootstrapSeed: process.env.SWARM_BOOTSTRAP_SEED ?? "protein-cost-target-v1",
    calibrationRuns: boundedInteger(process.env.SWARM_CALIBRATION_RUNS, 9, 3, 30),
    calibrationMaximumRatio: boundedNumber(process.env.SWARM_CALIBRATION_MAX_RATIO, 1.15, 1, 2),
  } : { calibrationRuns: 3 }),
  order: "alternating",
};
const manifest = {
  schemaVersion: 1,
  comparisonId,
  evidenceLevel: "celld-comparison",
  preregisteredAt: startedAt,
  config,
  design: {
    question: fixedQualityMode
      ? "At a fixed independently verified quality target, does frozen Moore-neighborhood exchange discover a qualifying artifact with fewer recorded Luna tokens than isolated cells?"
      : "Does frozen Moore-neighborhood exchange improve verified work over isolated cells at the same configured budget?",
    primaryOutcome: fixedQualityMode
      ? "Recorded Responses total tokens through the full first settled generation containing a retrospectively qualifying candidate."
      : "Median paired difference in seed-relative best-score improvement, in percentage points.",
    outcomeThreshold: fixedQualityMode
      ? `Candidate must clear ${config.qualityTargetMultiplier}x baseline in ${config.qualityTargetRequiredRatios}/${config.qualityTargetRechecks} rechecks; paired token differences within ${config.meaningfulCostDeltaPct}% are ties.`
      : `Differences below ${config.meaningfulThresholdPct}% are treated as ties.`,
    runOrder: Array.from({ length: config.trials }, (_, index) => ({
      trial: index + 1,
      order: conditionOrder(index + 1),
    })),
    retryPolicy:
      "Retry only a condition whose evidence bundle failed operationally; never retry a passing run because of its score. Retain every attempt.",
    globalControlPolicy: fixedQualityMode
      ? "Freeze the first passing run's complete control fingerprint and require every later run to match it; configuration-bound fields must also equal this preregistration."
      : "Require every matched pair to share the recorded runtime, protocol, benchmark, topology-size, and budget controls.",
    calibrationPolicy: fixedQualityMode
      ? `Before model calls, measure the trusted baseline ${config.calibrationRuns} times. Abort if correctness fails or max/min exceeds ${config.calibrationMaximumRatio}.`
      : "Before model calls, measure the trusted baseline three times. Abort if its observed score range reaches the preregistered meaningful-effect threshold.",
    claimBoundary:
      fixedQualityMode
        ? "This preregistered systems experiment estimates recorded discovery cost to one fixed verified-quality target under one task and frozen Luna protocol. It does not establish learning or general swarm superiority."
        : "This is an exploratory three-pair systems experiment, not a significance test or evidence of learning or general swarm superiority.",
  },
};

if (fixedQualityMode && config.qualityTargetRequiredRatios > config.qualityTargetRechecks) {
  throw new Error("SWARM_QUALITY_TARGET_REQUIRED_RATIOS cannot exceed rechecks");
}
if (fixedQualityMode && config.minimumComparablePairs > config.trials) {
  throw new Error("SWARM_MINIMUM_COMPARABLE_PAIRS cannot exceed trials");
}

if (typeof process.env.OPENAI_API_KEY !== "string" || process.env.OPENAI_API_KEY.length === 0) {
  throw new Error("OPENAI_API_KEY is required for the live paired comparison");
}

let interrupted = false;
let activeChild = null;
let frozenControlFingerprint = null;
let terminalFailure = null;
await mkdir(attemptDirectory, { recursive: true });
await writeJson(join(outputDirectory, "manifest.json"), manifest);
const calibration = await calibrateBenchmark();
await writeJson(join(outputDirectory, "benchmark-calibration.json"), calibration);
if (!calibration.acceptable) {
  throw new Error(fixedQualityMode
    ? `Benchmark calibration max/min ${calibration.maximumToMinimumRatio} exceeds ${config.calibrationMaximumRatio}`
    : `Benchmark calibration range ${calibration.rangePct}% is not below the ${config.meaningfulThresholdPct}% effect threshold`);
}
await writeProgress([], []);

const trials = [];
const attempts = [];
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    activeChild?.kill(signal);
  });
}

for (
  let trialIndex = 1;
  trialIndex <= config.trials && !interrupted && terminalFailure === null;
  trialIndex += 1
) {
  const order = conditionOrder(trialIndex);
  const conditions = {};
  for (const condition of order) {
    const result = await runConditionWithRetries({ trialIndex, order, condition });
    conditions[condition] = result.projection;
    attempts.push(...result.attempts);
    await writeProgress(trials, attempts, { trial: trialIndex, order, conditions });
    if (result.terminalError !== null) terminalFailure = result.terminalError;
    if (interrupted || terminalFailure !== null) break;
  }
  trials.push({ trial: trialIndex, order, conditions });
  await writeProgress(trials, attempts);
}

const completedAt = new Date().toISOString();
const summary = (fixedQualityMode ? buildFixedQualityComparisonSummary : buildComparisonSummary)({
  comparisonId,
  startedAt,
  completedAt,
  config,
  trials,
  attempts,
  calibration,
});
await writeJson(join(outputDirectory, "summary.json"), summary);
await writeJson(join(comparisonsRoot, "latest.json"), {
  schemaVersion: 1,
  comparisonId,
  status: summary.status,
  completedAt,
  summaryPath: join(outputDirectory, "summary.json"),
  outputDirectory,
});
console.log(JSON.stringify(summary, null, 2));
if (summary.status !== "passed") process.exitCode = interrupted ? 130 : 1;

async function runConditionWithRetries({ trialIndex, order, condition }) {
  const conditionAttempts = [];
  let projection = null;
  let terminalError = null;
  for (
    let attempt = 1;
    attempt <= config.conditionMaximumAttempts && !interrupted;
    attempt += 1
  ) {
    try {
      const result = await runCondition({ trialIndex, order, condition, attempt });
      conditionAttempts.push(result.attempt);
      projection = result.projection;
      if (projection.status === "passed") break;
    } catch (error) {
      const visible = error instanceof Error ? error : new Error(String(error));
      const attemptRecord = visible.attemptRecord ?? {
        trial: trialIndex,
        condition,
        order,
        attempt,
        startedAt: null,
        completedAt: new Date().toISOString(),
        exitCode: null,
        runId: null,
        status: "operational_error",
        error: { name: visible.name, message: visible.message },
      };
      conditionAttempts.push(attemptRecord);
      console.log(JSON.stringify({
        kind: "comparison.condition.operational_error",
        comparisonId,
        trial: trialIndex,
        condition,
        attempt,
        error: attemptRecord.error,
        terminal: visible.conditionTerminal === true,
      }));
      if (visible.conditionTerminal === true) {
        terminalError = attemptRecord.error;
        break;
      }
    }
    if (interrupted) break;
    await writeProgress(trials, [...attempts, ...conditionAttempts], {
      trial: trialIndex,
      order,
      condition,
      attempts: conditionAttempts,
    });
  }
  return { projection, attempts: conditionAttempts, terminalError };
}

async function runCondition({ trialIndex, order, condition, attempt }) {
  const label = `trial-${String(trialIndex).padStart(2, "0")}-${condition}-attempt-${attempt}`;
  const stdoutPath = join(attemptDirectory, `${label}.stdout.log`);
  const stderrPath = join(attemptDirectory, `${label}.stderr.log`);
  const attemptStartedAt = new Date().toISOString();
  let exitCode = null;
  let discoveredRunId = null;
  try {
    const previousPointer = await readJsonIfPresent(join(runsRoot, "latest.json"));
  console.log(JSON.stringify({
    kind: "comparison.condition.started",
    comparisonId,
    trial: trialIndex,
    condition,
    attempt,
    order,
    startedAt: attemptStartedAt,
  }));
  const stdout = createWriteStream(stdoutPath, { flags: "a" });
  const stderr = createWriteStream(stderrPath, { flags: "a" });
  const child = spawn(process.execPath, [runnerPath], {
    cwd: workspace,
    env: {
      ...process.env,
      SWARM_RUNTIME_MODE: "openai",
      OPENAI_MODEL: config.model,
      OPENAI_REASONING_EFFORT: config.reasoningEffort,
      SWARM_CONDITION: condition,
      SWARM_ROWS: String(config.rows),
      SWARM_COLUMNS: String(config.columns),
      SWARM_GENERATIONS: String(config.generations),
      SWARM_CREDITS_PER_CELL: String(config.creditsPerCell),
      SWARM_MAX_MODEL_TURNS: String(config.maxModelTurns),
      SWARM_MAX_TOOL_CALLS: String(config.maxToolCalls),
      SWARM_DISPATCH_CONCURRENCY: String(config.dispatchConcurrency),
      SWARM_MODEL_TIMEOUT_MS: String(config.providerTimeoutMs),
      SWARM_MODEL_MAX_ATTEMPTS: String(config.providerMaximumAttempts),
      SWARM_MODEL_MAX_OUTPUT_TOKENS: String(config.modelMaxOutputTokens),
      SWARM_COMPARISON_ID: comparisonId,
      SWARM_COMPARISON_OBJECTIVE: config.objective,
      SWARM_TRIAL_INDEX: String(trialIndex),
      SWARM_CONDITION_ORDER: order[0] === "local" ? "local-first" : "isolated-first",
      ...(fixedQualityMode ? {
        SWARM_QUALITY_TARGET_MULTIPLIER: String(config.qualityTargetMultiplier),
        SWARM_QUALITY_TARGET_RECHECK_PAIRS: String(config.qualityTargetRechecks),
        SWARM_QUALITY_TARGET_REQUIRED_RATIOS: String(config.qualityTargetRequiredRatios),
        SWARM_QUALITY_TARGET_BLOCK_SIZE: String(config.qualityTargetBlockSize),
        SWARM_QUALITY_TARGET_MAX_BASELINE_DRIFT: String(config.qualityTargetMaximumBaselineDrift),
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChild = child;
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
    try {
      exitCode = await new Promise((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", resolveExit);
      });
    } finally {
      activeChild = null;
      stdout.end();
      stderr.end();
      await Promise.all([streamFinished(stdout), streamFinished(stderr)]);
    }

    const pointer = await readJsonIfPresent(join(runsRoot, "latest.json"));
    if (pointer === null || pointer.runId === previousPointer?.runId) {
      throw new Error(`${label} did not publish a new celld evidence bundle (exit ${exitCode})`);
    }
    discoveredRunId = pointer.runId ?? null;
    const runOutputDirectory = resolve(pointer.outputDirectory);
    if (runOutputDirectory !== runsRoot && !runOutputDirectory.startsWith(`${runsRoot}/`)) {
      throw new Error(`${label} published a run outside SWARM_RUN_ROOT`);
    }
    const [summary, manifest, seed, serviceSnapshots, qualityTarget] = await Promise.all([
      readJson(join(runOutputDirectory, "summary.json")),
      readJson(join(runOutputDirectory, "manifest.json")),
      readJsonIfPresent(join(runOutputDirectory, "seed.json")),
      readJsonIfPresent(join(runOutputDirectory, "service-snapshots.json")),
      readJsonIfPresent(join(runOutputDirectory, "quality-target.json")),
    ]);
    validateRunIdentity({ summary, manifest, trialIndex, order, condition });
    const projection = projectSwarmRun({
      summary,
      manifest,
      seed,
      serviceSnapshots,
      qualityTarget,
      summaryPath: join(runOutputDirectory, "summary.json"),
    });
    if (fixedQualityMode && projection.status === "passed") await freezeOrValidateControls(projection);
    const attemptRecord = {
      trial: trialIndex,
      condition,
      order,
      attempt,
      startedAt: attemptStartedAt,
      completedAt: new Date().toISOString(),
      exitCode,
      runId: summary.runId,
      status: summary.status,
      stdoutPath,
      stderrPath,
    };
    console.log(JSON.stringify({
      kind: "comparison.condition.finished",
      comparisonId,
      trial: trialIndex,
      condition,
      attempt,
      runId: summary.runId,
      status: summary.status,
      bestScore: projection.bestScore,
      gainPct: projection.gainPct,
      tokens: projection.tokens,
      fallbacks: projection.fallbacks,
    }));
    return { projection, attempt: attemptRecord };
  } catch (error) {
    const visible = error instanceof Error ? error : new Error(String(error));
    visible.attemptRecord = {
      trial: trialIndex,
      condition,
      order,
      attempt,
      startedAt: attemptStartedAt,
      completedAt: new Date().toISOString(),
      exitCode,
      runId: discoveredRunId,
      status: "operational_error",
      stdoutPath,
      stderrPath,
      error: { name: visible.name, message: visible.message },
    };
    throw visible;
  }
}

async function freezeOrValidateControls(projection) {
  const fingerprint = comparisonControlFingerprint(projection);
  const missing = Object.entries(fingerprint).filter(([, value]) => value === null || value === undefined);
  if (missing.length > 0) {
    throw terminalConditionError(
      `Run ${projection.runId} omitted frozen controls: ${missing.map(([field]) => field).join(", ")}`,
    );
  }
  if (frozenControlFingerprint === null) {
    frozenControlFingerprint = fingerprint;
    await writeJson(join(outputDirectory, "frozen-controls.json"), {
      schemaVersion: 1,
      protocol: "protein-comparison-control-fingerprint/v1",
      frozenAt: new Date().toISOString(),
      sourceRunId: projection.runId,
      fingerprint,
    });
    return;
  }
  const changed = Object.keys(fingerprint).filter((field) =>
    fingerprint[field] !== frozenControlFingerprint[field]
  );
  if (changed.length > 0) {
    throw terminalConditionError(`Run ${projection.runId} changed frozen controls: ${changed.join(", ")}`);
  }
}

function terminalConditionError(message) {
  const error = new Error(message);
  error.conditionTerminal = true;
  return error;
}

function validateRunIdentity({ summary, manifest, trialIndex, order, condition }) {
  if (summary.runId !== manifest.runId) throw new Error("Run summary and manifest IDs differ");
  if (manifest.comparison?.comparisonId !== comparisonId) throw new Error("Run has the wrong comparison ID");
  if (manifest.comparison?.trialIndex !== trialIndex) throw new Error("Run has the wrong trial index");
  if (manifest.comparison?.conditionOrder !== (order[0] === "local" ? "local-first" : "isolated-first")) {
    throw new Error("Run has the wrong condition order");
  }
  if (manifest.topology?.condition !== condition || summary.experiment?.condition !== condition) {
    throw new Error("Run has the wrong condition");
  }
  if (summary.status === "passed") {
    if (manifest.source?.benchmarkId !== config.benchmarkId) {
      throw new Error(`Expected benchmark ${config.benchmarkId}, received ${manifest.source?.benchmarkId}`);
    }
    if (manifest.source?.evaluatorVersion !== config.evaluatorVersion) {
      throw new Error(`Expected evaluator ${config.evaluatorVersion}, received ${manifest.source?.evaluatorVersion}`);
    }
    if (fixedQualityMode) {
      const expectedTarget = {
        protocol: config.qualityTargetProtocol,
        multiplier: config.qualityTargetMultiplier,
        rechecksPerCandidate: config.qualityTargetRechecks,
        requiredPassingRatios: config.qualityTargetRequiredRatios,
        requiredCorrectnessPasses: config.qualityTargetRechecks,
        blockSize: config.qualityTargetBlockSize,
        maximumBaselineDriftRatio: config.qualityTargetMaximumBaselineDrift,
      };
      for (const [field, expected] of Object.entries(expectedTarget)) {
        if (manifest.qualityTarget?.[field] !== expected) {
          throw new Error(`Run has the wrong fixed-quality ${field}`);
        }
      }
      if (summary.experiment?.qualityTarget === null) {
        throw new Error("Run did not publish fixed-quality evidence");
      }
    }
    const expectedRuntime = {
      responsesProtocol: [manifest.source?.modelGateway?.protocol, config.responsesProtocol],
      model: [manifest.source?.modelGateway?.model, config.model],
      reasoningEffort: [manifest.source?.modelGateway?.reasoningEffort, config.reasoningEffort],
      promptVersion: [manifest.source?.modelGateway?.promptVersion, config.promptVersion],
      toolSchemaVersion: [manifest.source?.modelGateway?.toolSchemaVersion, config.toolSchemaVersion],
      toolSchemaSha256: [manifest.source?.modelGateway?.toolSchemaSha256, config.toolSchemaSha256],
      providerTimeoutMs: [manifest.source?.modelGateway?.providerTimeoutMs, config.providerTimeoutMs],
      providerMaximumAttempts: [manifest.source?.modelGateway?.providerMaximumAttempts, config.providerMaximumAttempts],
      modelMaxOutputTokens: [summary.services?.modelGateway?.maxOutputTokens, config.modelMaxOutputTokens],
      rows: [manifest.topology?.rows, config.rows],
      columns: [manifest.topology?.columns, config.columns],
      generations: [manifest.budget?.generations, config.generations],
      creditsPerCell: [manifest.budget?.creditsPerCell, config.creditsPerCell],
      maxModelTurns: [manifest.budget?.maxModelTurnsPerCellGeneration, config.maxModelTurns],
      maxToolCalls: [manifest.budget?.maxToolCallsPerCellGeneration, config.maxToolCalls],
      dispatchConcurrency: [manifest.budget?.dispatchConcurrency, config.dispatchConcurrency],
    };
    for (const [field, [actual, expected]] of Object.entries(expectedRuntime)) {
      if (actual !== expected) throw new Error(`Run has the wrong configured ${field}`);
    }
  }
}

function conditionOrder(trialIndex) {
  return trialIndex % 2 === 1 ? ["local", "isolated"] : ["isolated", "local"];
}

async function calibrateBenchmark() {
  const measurements = [];
  for (let index = 0; index < config.calibrationRuns; index += 1) {
    const result = await runArtifactSandbox({
      source: BASELINE_SOURCE,
      cases: PUBLIC_CASES,
      benchmark: true,
    });
    const score = result.benchmark?.aggregate?.score;
    if (result.pass !== true || !Number.isFinite(score)) {
      throw new Error(`Benchmark calibration ${index + 1} failed its correctness or measurement gate`);
    }
    measurements.push({
      run: index + 1,
      score,
      regimes: result.benchmark.regimes.map((regime) => ({
        id: regime.id,
        medianMs: regime.medianMs,
        throughputItemsPerMs: regime.throughputItemsPerMs,
      })),
    });
  }
  const scores = measurements.map((measurement) => measurement.score).sort((left, right) => left - right);
  const medianScore = scores[Math.floor(scores.length / 2)];
  const rangePct = Number((((scores.at(-1) - scores[0]) / medianScore) * 100).toFixed(6));
  const maximumToMinimumRatio = Number((scores.at(-1) / scores[0]).toFixed(8));
  return {
    schemaVersion: 1,
    benchmarkId: config.benchmarkId,
    evaluatorVersion: config.evaluatorVersion,
    measuredAt: new Date().toISOString(),
    runs: measurements.length,
    scores,
    medianScore,
    rangePct,
    maximumToMinimumRatio,
    thresholdPct: config.meaningfulThresholdPct,
    acceptable: fixedQualityMode
      ? maximumToMinimumRatio <= config.calibrationMaximumRatio
      : rangePct < config.meaningfulThresholdPct,
    measurements,
  };
}

async function writeProgress(completedTrials, attemptRecords, activeTrial = null) {
  await writeJson(join(outputDirectory, "progress.json"), {
    schemaVersion: 1,
    comparisonId,
    status: interrupted ? "interrupted" : "running",
    updatedAt: new Date().toISOString(),
    config,
    completedTrials,
    attempts: attemptRecords,
    activeTrial,
  });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
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

function streamFinished(stream) {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolveStream, reject) => {
    stream.once("close", resolveStream);
    stream.once("error", reject);
  });
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
