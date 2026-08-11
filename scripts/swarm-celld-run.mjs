import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join, resolve } from "node:path";
import {
  deploy,
  getJson,
  pollJson,
  requireCommand,
  root,
  run,
  sleep,
  startCelld,
  startMinio,
  stopChild,
  stopMinio,
  waitForHttp,
} from "./celld-proof-support.mjs";
import { BENCHMARK as MOCK_BENCHMARK } from "../examples/cellular-agent-swarm/artifact-benchmark.mjs";
import { BENCHMARK as LIVE_BENCHMARK } from "../examples/cellular-agent-swarm/artifact-task.mjs";
import { inspectSandboxImage } from "../examples/cellular-agent-swarm/artifact-sandbox.mjs";
import {
  PROMPT_VERSION,
  RESPONSES_PROTOCOL,
  TOOL_SCHEMA_SHA256,
  TOOL_SCHEMA_VERSION,
} from "../examples/cellular-agent-swarm/openai-responses.mjs";

const celldBin = process.env.CELLD_BIN ?? "celld";
const runtimeMode = process.env.SWARM_RUNTIME_MODE === "openai" ? "openai" : "mock";
const liveMode = runtimeMode === "openai";
const BENCHMARK = liveMode ? LIVE_BENCHMARK : MOCK_BENCHMARK;
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const runId = `celld-swarm${liveMode ? "-openai" : ""}-${timestamp}-${process.pid}`;
const experimentId = runId;
const evidenceLevel = liveMode ? "celld-experiment" : "celld-smoke-mock-services";
const rows = boundedInteger(process.env.SWARM_ROWS, liveMode ? 2 : 4, 1, 12);
const columns = boundedInteger(process.env.SWARM_COLUMNS, liveMode ? 2 : 4, 1, 12);
const generations = boundedInteger(process.env.SWARM_GENERATIONS, liveMode ? 2 : 3, 1, 20);
const creditsPerCell = boundedInteger(process.env.SWARM_CREDITS_PER_CELL, 24, 1, 10_000);
const maxModelTurns = boundedInteger(process.env.SWARM_MAX_MODEL_TURNS, 4, 1, 8);
const maxToolCalls = boundedInteger(process.env.SWARM_MAX_TOOL_CALLS, 3, 0, 7);
const qualityTargetMultiplier = liveMode
  ? optionalBoundedNumber(process.env.SWARM_QUALITY_TARGET_MULTIPLIER, 1, 20)
  : null;
const qualityTargetRecheckPairs = qualityTargetMultiplier === null
  ? 0
  : boundedInteger(process.env.SWARM_QUALITY_TARGET_RECHECK_PAIRS, 9, 3, 20);
const qualityTargetRequiredRatios = qualityTargetMultiplier === null
  ? 0
  : boundedInteger(
      process.env.SWARM_QUALITY_TARGET_REQUIRED_RATIOS,
      Math.max(1, qualityTargetRecheckPairs - 1),
      1,
      qualityTargetRecheckPairs,
    );
const qualityTargetBlockSize = qualityTargetMultiplier === null
  ? 0
  : boundedInteger(process.env.SWARM_QUALITY_TARGET_BLOCK_SIZE, 4, 1, 8);
const qualityTargetMaximumBaselineDrift = qualityTargetMultiplier === null
  ? null
  : boundedNumber(process.env.SWARM_QUALITY_TARGET_MAX_BASELINE_DRIFT, 1.15, 1, 2);
const condition = process.env.SWARM_CONDITION === "isolated" ? "isolated" : "local";
const dispatchConcurrency = boundedInteger(
  process.env.SWARM_DISPATCH_CONCURRENCY,
  liveMode ? 8 : 16,
  1,
  16,
);
const comparisonId = optionalIdentifier(process.env.SWARM_COMPARISON_ID);
const trialIndex = comparisonId === null
  ? null
  : boundedInteger(process.env.SWARM_TRIAL_INDEX, 1, 1, 10_000);
const conditionOrder = comparisonId === null
  ? null
  : optionalConditionOrder(process.env.SWARM_CONDITION_ORDER);
const sampleIntervalMs = boundedInteger(process.env.SWARM_RSS_INTERVAL_MS, 100, 20, 5_000);
const minioPort = boundedInteger(process.env.SWARM_MINIO_PORT, 19020, 1_024, 65_535);
const celldPort = boundedInteger(process.env.SWARM_CELLD_PORT, 18092, 1_024, 65_535);
const capabilityPort = boundedInteger(process.env.SWARM_CAPABILITY_PORT, 19120, 1_024, 65_535);
const modelGatewayPort = boundedInteger(process.env.SWARM_MODEL_GATEWAY_PORT, 19121, 1_024, 65_535);
const toolExecutorPort = boundedInteger(process.env.SWARM_TOOL_EXECUTOR_PORT, 19122, 1_024, 65_535);
const evaluatorPort = boundedInteger(process.env.SWARM_EVALUATOR_PORT, 19123, 1_024, 65_535);
const boardPort = boundedInteger(process.env.SWARM_BOARD_PORT, 19124, 1_024, 65_535);
const endpoint = `http://127.0.0.1:${minioPort}`;
const celldUrl = `http://127.0.0.1:${celldPort}`;
const capabilityUrl = `http://127.0.0.1:${capabilityPort}`;
const modelGatewayUrl = `http://127.0.0.1:${modelGatewayPort}`;
const toolExecutorUrl = `http://127.0.0.1:${toolExecutorPort}`;
const evaluatorUrl = `http://127.0.0.1:${evaluatorPort}`;
const boardUrl = liveMode ? `http://127.0.0.1:${boardPort}` : capabilityUrl;
const bucket = `protein-swarm-${process.pid}`;
const minioName = `protein-swarm-minio-${process.pid}`;
const credentials = {
  AWS_ACCESS_KEY_ID: "protein-swarm-smoke",
  AWS_SECRET_ACCESS_KEY: "protein-swarm-smoke-secret",
  AWS_REGION: "us-east-1",
};
const outputRoot = resolve(
  process.env.SWARM_RUN_ROOT ?? join(root, ".protein/cellular-agent-swarm/celld-runs"),
);
const outputDirectory = join(outputRoot, runId);
const processDirectory = join(outputDirectory, "processes");
const cellDirectory = join(outputDirectory, "cells");
const timelinePath = join(outputDirectory, "timeline.jsonl");
const rssPath = join(outputDirectory, "rss.jsonl");
const celldLogPath = join(processDirectory, "celld.log");
const capabilityLogPath = join(processDirectory, "capability.jsonl");
const capabilityStatePath = join(outputDirectory, "capability-state.json");
const artifactDirectory = join(outputDirectory, "artifacts");
const sandboxImage = process.env.SWARM_SANDBOX_IMAGE ?? "node:22-alpine";

let phase = "preflight";
let phaseStartedAt = performance.now();
let celld;
let capability;
let capabilityStdout;
let capabilityStderr;
let minioStarted = false;
let rssTimer;
let rssQueue = Promise.resolve();
let timelineQueue = Promise.resolve();
let peakCelldRssBytes = 0;
let rssSamples = 0;
let runError;
let duplicateEvent;
let conflictEvent;
let receiptConflict;
let restartRecoveryMs = null;
let capabilityStats;
let liveServiceStats;
let liveServiceSnapshots;
const liveServices = [];
let finalInspections = [];
let currentCelldInstance = 0;
let cleanupStarted = false;
const phaseDurationsMs = {};
const generationMetrics = [];
const generationFinalists = [];
let qualityTargetEvidence = null;
let seedScoreReference = null;
const startedAt = performance.now();
const startedWallTime = new Date().toISOString();
const seenJournal = new Set();
const cells = createCells();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (cleanupStarted) return;
    runError = new Error(`Interrupted by ${signal}`);
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

await mkdir(processDirectory, { recursive: true });
await mkdir(cellDirectory, { recursive: true });
await timeline("run.started", {
  evidenceLevel,
  runtimeMode,
  experimentId,
  condition,
  rows,
  columns,
  generations,
  qualityTargetMultiplier,
  qualityTargetRecheckPairs,
  qualityTargetRequiredRatios,
});

try {
  requireCommand(celldBin, ["--version"]);
  requireCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (liveMode && (typeof process.env.OPENAI_API_KEY !== "string" || process.env.OPENAI_API_KEY.length === 0)) {
    throw new Error("OPENAI_API_KEY is required for SWARM_RUNTIME_MODE=openai");
  }
  if (liveMode && inspectSandboxImage(sandboxImage).imageId === null) {
    run("docker", ["pull", sandboxImage]);
  }
  const sandbox = liveMode ? inspectSandboxImage(sandboxImage) : null;
  const celldVersion = commandOutput(celldBin, ["--version"]).trim();
  const git = gitIdentity();

  setPhase("build");
  run("npm", ["run", "swarm:build"]);
  const workerBundlePath = join(root, "examples/cellular-agent-swarm/dist/worker.js");
  const workerBundleSha256 = sha256(await readFile(workerBundlePath));
  await writeJson(join(outputDirectory, "manifest.json"), {
    schemaVersion: 1,
    runId,
    experimentId,
    evidenceLevel,
    claimBoundary: liveMode
      ? "This is a live OpenAI Responses API, generated-code, isolated-evaluator vertical slice on celld. One small local-population pilot is not a comparison and does not establish that swarms outperform a single agent."
      : "This run proves Protein cells executed through celld with mock external capabilities. It is not an LLM or swarm-effectiveness experiment.",
    command: liveMode ? "npm run swarm:openai" : "npm run swarm:celld",
    startedAt: startedWallTime,
    runtime: {
      celld: celldVersion,
      node: process.version,
      platform: platform(),
      architecture: arch(),
      osRelease: release(),
    },
    source: {
      gitCommit: git.commit,
      dirty: git.dirty,
      workerBundleSha256,
      benchmarkId: BENCHMARK.id,
      evaluatorVersion: BENCHMARK.evaluatorVersion,
      ...(liveMode ? { sandbox } : {}),
      ...(liveMode ? {
        modelGateway: {
          provider: "OpenAI",
          api: "Responses",
          protocol: RESPONSES_PROTOCOL,
          model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
          reasoningEffort: process.env.OPENAI_REASONING_EFFORT ?? "low",
          promptVersion: PROMPT_VERSION,
          toolSchemaVersion: TOOL_SCHEMA_VERSION,
          toolSchemaSha256: TOOL_SCHEMA_SHA256,
          maxOutputTokens: boundedInteger(process.env.SWARM_MODEL_MAX_OUTPUT_TOKENS, 1_200, 256, 8_192),
          store: false,
          providerTimeoutMs: boundedInteger(process.env.SWARM_MODEL_TIMEOUT_MS, 60_000, 5_000, 120_000),
          providerMaximumAttempts: boundedInteger(process.env.SWARM_MODEL_MAX_ATTEMPTS, 1, 1, 5),
        },
      } : {}),
    },
    comparison: comparisonId === null ? null : {
      comparisonId,
      trialIndex,
      conditionOrder,
      objective: process.env.SWARM_COMPARISON_OBJECTIVE ?? "quality",
    },
    topology: { condition, rows, columns, cells: cells.map((cell) => cell.id) },
    budget: {
      generations,
      creditsPerCell,
      totalCredits: cells.length * creditsPerCell,
      ...(liveMode ? {
        maxModelTurnsPerCellGeneration: maxModelTurns,
        maxToolCallsPerCellGeneration: maxToolCalls,
        maximumModelTurns: cells.length * generations * maxModelTurns,
        dispatchConcurrency,
      } : {}),
    },
    qualityTarget: qualityTargetMultiplier === null ? null : {
      protocol: "protein-fixed-quality-recheck/v1",
      metric: "candidate_to_interleaved_baseline_score_ratio",
      multiplier: qualityTargetMultiplier,
      rechecksPerCandidate: qualityTargetRecheckPairs,
      requiredPassingRatios: qualityTargetRequiredRatios,
      requiredCorrectnessPasses: qualityTargetRecheckPairs,
      blockSize: qualityTargetBlockSize,
      maximumBaselineDriftRatio: qualityTargetMaximumBaselineDrift,
      selection: "every distinct non-seed candidate sent to hidden evaluation",
      decisionBoundary: "generation_settled",
      execution: "post-discovery serialized blocks with flanking baselines and balanced candidate order",
    },
    infrastructure: {
      bucket,
      endpoint,
      minioImage: "minio/minio:latest (unversioned smoke dependency)",
      minioClientImage: "minio/mc:latest (unversioned smoke dependency)",
      celldPort,
      capabilityPort,
      ...(liveMode ? { modelGatewayPort, toolExecutorPort, evaluatorPort, boardPort } : {}),
      celldTtlMs: 3_000,
      proteinEventActionLeaseMs: liveMode ? 90_000 : 3_000,
      celldFetchTimeoutSeconds: liveMode ? 90 : 10,
      celldHandlerBudgetSeconds: liveMode ? 120 : 30,
      rssSampleIntervalMs: sampleIntervalMs,
    },
  });

  setPhase("object-store");
  minioStarted = true;
  await startMinio({ name: minioName, port: minioPort, bucket, credentials });

  setPhase("deploy");
  deploy({
    celldBin,
    project: "examples/cellular-agent-swarm",
    bucket,
    endpoint,
    credentials,
  });

  setPhase(liveMode ? "live-services-start" : "capability-start");
  if (liveMode) await startLiveServices();
  else await startCapability();

  setPhase("celld-start");
  await startCelldInstance();

  const seed = liveMode
    ? await seedLiveExperiment()
    : await post(capabilityUrl + "/seed", { experimentId }, 200);
  let cellStates = Object.fromEntries(
    cells.map((cell) => [cell.id, {
      candidateId: seed.candidateId,
      strategy: seed.strategy,
      score: seed.score,
      credits: creditsPerCell,
      lastBehavior: "seed",
      lastEvidenceId: seed.evidenceId,
      lastArtifactRef: seed.artifactRef,
      lastEvaluationActionId: seed.evaluationActionId,
      generation: 0,
      status: "idle",
    }]),
  );
  await writeJson(join(outputDirectory, "seed.json"), seed);
  seedScoreReference = seed.score;
  const discoveryStartedAt = performance.now();
  const discoveryBaseline = liveMode ? await liveDiscoveryCounters() : null;

  for (let generation = 1; generation <= generations; generation += 1) {
    const generationStartedAt = performance.now();
    const acceptedAt = new Map();
    const cellLatencies = new Map();
    setPhase(`generation-${generation}-dispatch`);
    const snapshot = structuredClone(cellStates);
    const eventBodies = new Map();
    await mapConcurrent(cells, Math.min(dispatchConcurrency, cells.length), async (cell) => {
      const event = generationEvent(cell, generation, snapshot);
      eventBodies.set(cell.id, event);
      const accepted = await post(cellUrl(cell.id, "/events"), event, 202);
      acceptedAt.set(cell.id, performance.now());
      await timeline("generation.event.accepted", { cellId: cell.id, generation, accepted });
    });

    if (generation === 1) {
      const firstCell = cells[0];
      const originalEvent = eventBodies.get(firstCell.id);
      duplicateEvent = await post(cellUrl(firstCell.id, "/events"), originalEvent, 200);
      const conflictingEvent = structuredClone(originalEvent);
      conflictingEvent.payload.score += 1;
      conflictEvent = await postWithStatus(cellUrl(firstCell.id, "/events"), conflictingEvent);
      assert(conflictEvent.status === 400, `conflicting event returned ${conflictEvent.status}`);
      assert(duplicateEvent.duplicate === true, "duplicate event was not reported as duplicate");
      await timeline("event.identity.checked", { cellId: firstCell.id, duplicateEvent, conflictEvent });
    }

    setPhase(`generation-${generation}-settle`);
    const settled = await mapConcurrent(cells, Math.min(dispatchConcurrency, cells.length), async (cell) => {
      const value = await pollJson(
        cellUrl(cell.id, "/state"),
        (candidate) =>
          candidate?.state?.experimentId === experimentId &&
          candidate?.state?.generation === generation &&
          (candidate?.state?.status === "waiting" || candidate?.state?.status === "failed"),
        { attempts: 900, delayMs: 100 },
      );
      if (value.state.status === "failed") throw new Error(`${cell.id} failed generation ${generation}`);
      const latencyMs = performance.now() - acceptedAt.get(cell.id);
      cellLatencies.set(cell.id, latencyMs);
      await timeline("generation.cell.settled", {
        cellId: cell.id,
        generation,
        latencyMs: Number(latencyMs.toFixed(3)),
        behavior: value.state.lastBehavior,
      });
      return value;
    });
    cellStates = Object.fromEntries(settled.map((value) => [value.agent, value.state]));
    const inspections = await collectGeneration(generation);
    const receiver = await getJson(boardUrl + "/snapshot");
    const submissions = Object.values(receiver.submissions).filter(
      (entry) =>
        entry?.payload?.experimentId === experimentId &&
        entry?.payload?.generation === generation,
    );
    assert(submissions.length === cells.length, `generation ${generation} has ${submissions.length}/${cells.length} submissions`);
    const frozenSnapshot = liveMode
      ? await post(boardUrl + "/snapshots/freeze", {
          experimentId,
          generation,
          expectedAgents: cells.map((cell) => cell.id),
        }, 200)
      : null;
    if (frozenSnapshot !== null) cellStates = authoritativeStates(frozenSnapshot, generation);
    const finalist = frozenSnapshot === null ? null : generationFinalist(frozenSnapshot);
    if (finalist !== null) generationFinalists.push(finalist);
    const scores = settled.map((value) => value.state.score);
    const generationLatencyValues = [...cellLatencies.values()];
    const cumulative = liveMode
      ? await liveDiscoveryCost(discoveryBaseline, cellStates, discoveryStartedAt)
      : null;
    const generationMetric = {
      generation,
      elapsedMs: Number((performance.now() - generationStartedAt).toFixed(3)),
      cellLatencyMs: latencySummary(generationLatencyValues),
      submissions: submissions.length,
      bestScore: Math.max(...scores),
      ...(cumulative === null ? {} : { cumulative }),
    };
    generationMetrics.push(generationMetric);
    await writeJson(join(outputDirectory, `generation-${generation}.json`), {
      schemaVersion: 1,
      experimentId,
      generation,
      condition,
      cells: settled,
      submissions,
      frozenSnapshot,
      finalist,
      bestScore: Math.max(...scores),
      meanScore: Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length),
      runtime: generationMetric,
    });
    await timeline("generation.settled", {
      generation,
      submissions: submissions.length,
      bestScore: Math.max(...scores),
      actions: inspections.reduce((sum, inspection) => sum + inspection.actions.length, 0),
    });

    if (generation === 1) {
      const firstDecision = inspections[0].actions.find((action) =>
        action.kind === (liveMode ? "swarm.model.turn" : "swarm.decide")
      );
      assert(firstDecision !== undefined, "first cell has no decision action to test receiver conflicts");
      receiptConflict = await postWithStatus((liveMode ? modelGatewayUrl : capabilityUrl) + "/actions", {
        actionId: firstDecision.id,
        agent: cells[0].id,
        kind: firstDecision.kind,
        payload: { conflictProbe: true },
      }, { "idempotency-key": firstDecision.id });
      assert(receiptConflict.status === 409, `receiver conflict returned ${receiptConflict.status}`);

      setPhase("celld-restart");
      const beforeRestart = Object.fromEntries(settled.map((value) => [value.agent, value.state]));
      await writeJson(join(outputDirectory, "state-before-restart.json"), beforeRestart);
      await stopCelldInstance("before-restart");
      const recoveryStartedAt = performance.now();
      await startCelldInstance();
      const afterRestartValues = await mapConcurrent(cells, Math.min(dispatchConcurrency, cells.length), (cell) =>
        pollJson(
          cellUrl(cell.id, "/state"),
          (candidate) => candidate?.state?.generation === generation && candidate?.state?.status === "waiting",
          { attempts: 900, delayMs: 100 },
        ),
      );
      restartRecoveryMs = Number((performance.now() - recoveryStartedAt).toFixed(3));
      const afterRestart = Object.fromEntries(afterRestartValues.map((value) => [value.agent, value.state]));
      for (const cell of cells) {
        assert(
          canonicalJson(afterRestart[cell.id]) === canonicalJson(beforeRestart[cell.id]),
          `${cell.id} state changed across celld restart`,
        );
      }
      await writeJson(join(outputDirectory, "state-after-restart.json"), afterRestart);
      await timeline("celld.restart.recovered", { cells: cells.length, recoveryMs: restartRecoveryMs });
    }
  }

  if (qualityTargetMultiplier !== null) {
    setPhase("quality-target-recheck");
    qualityTargetEvidence = await measureQualityTarget(seed, generationFinalists, generationMetrics);
    await writeJson(join(outputDirectory, "quality-target.json"), qualityTargetEvidence);
    await timeline("quality_target.measured", {
      multiplier: qualityTargetMultiplier,
      recheckPairs: qualityTargetRecheckPairs,
      valid: qualityTargetEvidence.valid,
      reached: qualityTargetEvidence.firstReach !== null,
      firstReachedGeneration: qualityTargetEvidence.firstReach?.generation ?? null,
      measurementEvaluations: qualityTargetEvidence.measurement.evaluations,
    });
  }

  setPhase("collect-final-evidence");
  finalInspections = await collectFinal();
  if (liveMode) {
    liveServiceStats = {
      modelGateway: await getJson(modelGatewayUrl + "/stats"),
      toolExecutor: await getJson(toolExecutorUrl + "/stats"),
      evaluator: await getJson(evaluatorUrl + "/stats"),
      board: await getJson(boardUrl + "/stats"),
    };
    liveServiceSnapshots = {
      modelGateway: await getJson(modelGatewayUrl + "/snapshot"),
      toolExecutor: await getJson(toolExecutorUrl + "/snapshot"),
      evaluator: await getJson(evaluatorUrl + "/snapshot"),
      board: await getJson(boardUrl + "/snapshot"),
    };
  } else {
    capabilityStats = await getJson(capabilityUrl + "/stats");
  }
  validateFinalEvidence(finalInspections);
  if (liveMode) await writeJson(join(outputDirectory, "service-snapshots.json"), liveServiceSnapshots);
  else await writeJson(join(outputDirectory, "capability-snapshot.json"), await getJson(capabilityUrl + "/snapshot"));
  setPhase("completed");
} catch (error) {
  runError = error instanceof Error ? error : new Error(String(error));
  if (liveMode) {
    await writeJson(join(outputDirectory, "private-failure.json"), {
      phase,
      name: runError.name,
      message: runError.message,
      stack: runError.stack ?? null,
    });
  }
  await timeline("run.failed", {
    phase,
    error: liveMode ? "Live experiment failed; inspect the private run logs." : String(runError),
    ...(liveMode ? { errorSha256: sha256(String(runError)) } : {}),
  });
} finally {
  await cleanup();
  closePhase();
  const elapsedMs = Number((performance.now() - startedAt).toFixed(3));
  const actions = finalInspections.flatMap((inspection) => inspection.actions ?? []);
  const journals = finalInspections.flatMap((inspection) => inspection.journal ?? []);
  const finalStates = finalInspections.map((inspection) => inspection.state?.state).filter(Boolean);
  const actionLatencyValues = actions.map((action) => Math.max(0, action.updatedAt - action.createdAt));
  const celldLogSignals = await analyzeCelldLog();
  const serviceLogSignals = liveMode ? await analyzeLiveServiceLogs() : null;
  const modelDecisionFallbacks = journals.filter(
    (entry) => entry?.data?.phase === "model_decision_rejected",
  );
  const summary = {
    schemaVersion: 1,
    runId,
    experimentId,
    evidenceLevel,
    status: runError === undefined ? "passed" : "failed",
    failedPhase: runError === undefined ? null : phase,
    error: runError === undefined
      ? null
      : liveMode
        ? "Live experiment failed; inspect private-failure.json and process logs."
        : String(runError),
    startedAt: startedWallTime,
    completedAt: new Date().toISOString(),
    elapsedMs,
    celld: {
      version: commandOutput(celldBin, ["--version"]).trim(),
      instances: currentCelldInstance,
      restartRecoveryMs,
      rssSampling: platform() === "linux" ? "procfs-main-process" : "unsupported",
      rssSamples,
      peakRssMb: Number((peakCelldRssBytes / 1024 / 1024).toFixed(1)),
    },
    protein: {
      distinctCells: new Set(finalInspections.map((inspection) => inspection.state?.agent)).size,
      expectedCells: cells.length,
      journals: journals.length,
      actions: actions.length,
      actionsByStatus: countBy(actions, (action) => action.status),
      actionsByKind: countBy(actions, (action) => action.kind),
      redeliveries: actions.filter((action) => action.attempts > 1).length,
      actionLatencyMs: latencySummary(actionLatencyValues),
      modelDecisionFallbacks: modelDecisionFallbacks.length,
      modelDecisionFallbacksByFunction: countBy(
        modelDecisionFallbacks,
        (entry) => entry?.data?.functionName ?? "unknown",
      ),
      modelDecisionFallbacksByCategory: countBy(
        modelDecisionFallbacks,
        (entry) => entry?.data?.category ?? "unclassified",
      ),
    },
    experiment: {
      condition,
      rows,
      columns,
      generations,
      completedCells: finalStates.filter((state) => state.generation === generations && state.status === "waiting").length,
      bestScore: finalStates.length === 0 ? null : Math.max(...finalStates.map((state) => state.score)),
      remainingCredits: finalStates.reduce((sum, state) => sum + state.credits, 0),
      generationMetrics,
      qualityTarget: qualityTargetEvidence === null ? null : {
        protocol: qualityTargetEvidence.protocol,
        valid: qualityTargetEvidence.valid,
        multiplier: qualityTargetEvidence.target.multiplier,
        reached: qualityTargetEvidence.firstReach !== null,
        firstReachedGeneration: qualityTargetEvidence.firstReach?.generation ?? null,
        firstReach: qualityTargetEvidence.firstReach,
        measurementEvaluations: qualityTargetEvidence.measurement.evaluations,
        evidencePath: "quality-target.json",
      },
    },
    identityChecks: {
      duplicateEvent,
      conflictEvent,
      receiptConflict,
    },
    capabilities: capabilityStats ?? null,
    services: liveServiceStats ?? null,
    runtimeLogSignals: celldLogSignals,
    serviceLogSignals,
    phaseDurationsMs,
    artifacts: {
      directory: outputDirectory,
      manifest: "manifest.json",
      timeline: "timeline.jsonl",
      rss: "rss.jsonl",
      celldLog: "processes/celld.log",
      capabilityLog: liveMode ? null : "processes/capability.jsonl",
      serviceLogs: liveMode ? "processes/{model-gateway,tool-executor,evaluator,board}.jsonl" : null,
      serviceSnapshots: liveMode ? "service-snapshots.json" : null,
      qualityTarget: qualityTargetEvidence === null ? null : "quality-target.json",
      cells: "cells/",
    },
    claimBoundary: liveMode
      ? comparisonId === null
        ? "Passed means a small real OpenAI Responses API tool-calling population generated, sandboxed, independently evaluated, and durably submitted artifacts through celld. This single local 2-D pilot is not an equal-budget comparison, does not measure learning, and does not prove a swarm advantage."
        : "Passed means this condition completed as one component of a preregistered equal-budget paired comparison. Only the completed aggregate comparison may support a local-versus-isolated claim; it does not measure learning or establish general swarm superiority."
      : "Passed means the real celld/Protein lifecycle and restart path worked against deterministic mock capabilities. It does not measure LLM learning or prove that a swarm outperforms a baseline.",
  };
  await writeJson(join(outputDirectory, "summary.json"), summary);
  await writeJson(join(outputRoot, "latest.json"), {
    schemaVersion: 1,
    runId,
    status: summary.status,
    evidenceLevel,
    completedAt: summary.completedAt,
    summaryPath: join(outputDirectory, "summary.json"),
    outputDirectory,
  });
  await timeline("run.finished", { status: summary.status, elapsedMs });
  console.log(JSON.stringify(summary, null, 2));
  if (runError !== undefined) process.exitCode = 1;
}

async function startCapability() {
  capabilityStdout = createWriteStream(join(processDirectory, "capability.stdout.log"), { flags: "a" });
  capabilityStderr = createWriteStream(join(processDirectory, "capability.stderr.log"), { flags: "a" });
  capability = spawn(
    process.execPath,
    [join(root, "examples/cellular-agent-swarm/capability-server.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        SWARM_CAPABILITY_PORT: String(capabilityPort),
        SWARM_CAPABILITY_STATE: capabilityStatePath,
        SWARM_ARTIFACT_DIR: artifactDirectory,
        SWARM_CAPABILITY_LOG: capabilityLogPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  capability.stdout.pipe(capabilityStdout);
  capability.stderr.pipe(capabilityStderr);
  await waitForHttp(capabilityUrl + "/health");
  await timeline("capability.started", { pid: capability.pid, url: capabilityUrl });
}

async function startLiveServices() {
  const common = {
    SWARM_ARTIFACT_DIR: artifactDirectory,
    SWARM_SANDBOX_IMAGE: sandboxImage,
  };
  await startLiveService({
    name: "tool-executor",
    file: "artifact-executor-server.mjs",
    healthUrl: toolExecutorUrl + "/health",
    environment: {
      ...common,
      SWARM_TOOL_EXECUTOR_PORT: String(toolExecutorPort),
      SWARM_TOOL_EXECUTOR_STATE: join(outputDirectory, "tool-executor-state.json"),
      SWARM_TOOL_EXECUTOR_LOG: join(processDirectory, "tool-executor.jsonl"),
    },
  });
  await startLiveService({
    name: "evaluator",
    file: "artifact-evaluator-server.mjs",
    healthUrl: evaluatorUrl + "/health",
    environment: {
      ...common,
      SWARM_EVALUATOR_PORT: String(evaluatorPort),
      SWARM_EVALUATOR_STATE: join(outputDirectory, "evaluator-state.json"),
      SWARM_EVALUATOR_LOG: join(processDirectory, "evaluator.jsonl"),
    },
  });
  await startLiveService({
    name: "board",
    file: "board-server.mjs",
    healthUrl: boardUrl + "/health",
    environment: {
      SWARM_BOARD_PORT: String(boardPort),
      SWARM_BOARD_STATE: join(outputDirectory, "board-state.json"),
      SWARM_BOARD_LOG: join(processDirectory, "board.jsonl"),
      SWARM_EVALUATOR_URL: evaluatorUrl,
    },
  });
  await startLiveService({
    name: "model-gateway",
    file: "model-gateway-server.mjs",
    healthUrl: modelGatewayUrl + "/health",
    providerAccess: true,
    environment: {
      SWARM_MODEL_GATEWAY_PORT: String(modelGatewayPort),
      SWARM_MODEL_GATEWAY_STATE: join(outputDirectory, "model-gateway-private-state.json"),
      SWARM_MODEL_GATEWAY_LOG: join(processDirectory, "model-gateway.jsonl"),
      OPENAI_REASONING_EFFORT: process.env.OPENAI_REASONING_EFFORT ?? "low",
      SWARM_MODEL_MAX_OUTPUT_TOKENS: process.env.SWARM_MODEL_MAX_OUTPUT_TOKENS ?? "1200",
      SWARM_MODEL_TIMEOUT_MS: process.env.SWARM_MODEL_TIMEOUT_MS ?? "60000",
      SWARM_MODEL_MAX_ATTEMPTS: process.env.SWARM_MODEL_MAX_ATTEMPTS ?? "1",
    },
  });
  await timeline("live.services.started", {
    services: Object.fromEntries(liveServices.map((entry) => [entry.name, { pid: entry.child.pid, healthUrl: entry.healthUrl }])),
  });
}

async function seedLiveExperiment() {
  const executorSeed = await post(toolExecutorUrl + "/seed", { experimentId }, 200);
  const evaluationActionId = `swarm:${experimentId}:seed:evaluate`;
  const candidate = await post(evaluatorUrl + "/actions", {
    actionId: evaluationActionId,
    agent: "board",
    kind: "swarm.evaluate",
    payload: {
      experimentId,
      generation: 0,
      candidateId: executorSeed.candidateId,
      candidateRef: executorSeed.candidateRef,
      behavior: "seed",
      strategy: executorSeed.strategy,
      rationale: "Versioned trusted baseline.",
      parentCandidateIds: [],
    },
  }, 200, { "idempotency-key": evaluationActionId });
  const seed = await post(boardUrl + "/seed", { experimentId, candidate }, 200);
  await writeJson(join(outputDirectory, "seed-public-evidence.json"), executorSeed.publicEvidence);
  await timeline("live.seed.verified", {
    candidateId: seed.candidateId,
    evidenceId: seed.evidenceId,
    score: seed.score,
    evaluationActionId: seed.evaluationActionId,
  });
  return seed;
}

async function startLiveService({ name, file, healthUrl, environment, providerAccess = false }) {
  const stdout = createWriteStream(join(processDirectory, `${name}.stdout.log`), { flags: "a" });
  const stderr = createWriteStream(join(processDirectory, `${name}.stderr.log`), { flags: "a" });
  const child = spawn(process.execPath, [join(root, "examples/cellular-agent-swarm", file)], {
    cwd: root,
    env: childEnvironment(environment, providerAccess),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const entry = { name, child, stdout, stderr, healthUrl };
  liveServices.push(entry);
  await waitForHttp(healthUrl, { attempts: 300, delayMs: 100 });
  if (child.exitCode !== null) throw new Error(`${name} exited during startup with code ${child.exitCode}`);
}

function childEnvironment(extra, providerAccess) {
  const environment = { ...process.env, ...extra };
  if (!providerAccess) {
    for (const key of ["OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "OPENAI_BASE_URL"]) {
      delete environment[key];
    }
  }
  return environment;
}

async function startCelldInstance() {
  currentCelldInstance += 1;
  celld = await startCelld({
    celldBin,
    bucket,
    endpoint,
    credentials,
    port: celldPort,
    ttlMs: 3_000,
    fetchTimeoutSeconds: liveMode ? 90 : 10,
    handlerBudgetSeconds: liveMode ? 120 : 30,
    environment: liveMode ? {
      OPENAI_API_KEY: "",
      OPENAI_ORG_ID: "",
      OPENAI_PROJECT_ID: "",
    } : {},
    variables: liveMode ? {
      EXECUTOR_URL: toolExecutorUrl,
      MODEL_GATEWAY_URL: modelGatewayUrl,
      TOOL_EXECUTOR_URL: toolExecutorUrl,
      EVALUATOR_URL: evaluatorUrl,
      BOARD_URL: boardUrl,
      PROTEIN_LEASE_MS: "90000",
    } : {
      EXECUTOR_URL: capabilityUrl,
      BOARD_URL: capabilityUrl,
      PROTEIN_LEASE_MS: "3000",
    },
  });
  startRssSampler();
  await timeline("celld.started", {
    instance: currentCelldInstance,
    pid: celld.child.pid,
    url: celldUrl,
  });
}

async function stopCelldInstance(reason) {
  if (celld === undefined) return;
  stopRssSampler();
  const current = celld;
  celld = undefined;
  await current.cleanup();
  const output = current.output();
  await appendFile(
    celldLogPath,
    `\n=== celld instance ${currentCelldInstance} · ${reason} ===\n${output}\n`,
  );
  await timeline("celld.stopped", { instance: currentCelldInstance, reason, outputBytes: output.length });
}

function startRssSampler() {
  stopRssSampler();
  rssTimer = setInterval(() => sampleRss(celld?.child?.pid), sampleIntervalMs);
  sampleRss(celld?.child?.pid);
}

function stopRssSampler() {
  if (rssTimer !== undefined) clearInterval(rssTimer);
  rssTimer = undefined;
}

function sampleRss(pid) {
  if (pid === undefined || platform() !== "linux") return;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rssMatch = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    const highWaterMatch = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
    if (rssMatch?.[1] === undefined) return;
    const rssBytes = Number(rssMatch[1]) * 1024;
    peakCelldRssBytes = Math.max(peakCelldRssBytes, rssBytes);
    rssSamples += 1;
    const sample = envelope("celld.rss", {
      source: "celld",
      component: "celld-main-process",
      instance: currentCelldInstance,
      pid,
      phase,
      rssBytes,
      highWaterBytes: highWaterMatch?.[1] === undefined ? null : Number(highWaterMatch[1]) * 1024,
    });
    rssQueue = rssQueue.then(() => appendFile(rssPath, `${JSON.stringify(sample)}\n`));
  } catch {}
}

function generationEvent(cell, generation, states) {
  const current = states[cell.id];
  const visibleCells = condition === "local"
    ? cells.filter((other) => Math.abs(other.row - cell.row) <= 1 && Math.abs(other.column - cell.column) <= 1)
    : [cell];
  const neighborhood = visibleCells.map((visible) => candidateView(states[visible.id]));
  return {
    id: `swarm:${experimentId}:${cell.id}:g${generation}:opened`,
    type: "swarm.generation.opened",
    payload: {
      experimentId,
      generation,
      condition,
      candidateId: current.candidateId,
      strategy: current.strategy,
      score: current.score,
      evidenceId: current.lastEvidenceId,
      artifactRef: current.lastArtifactRef,
      ...(typeof current.lastEvaluationActionId === "string"
        ? { evaluationActionId: current.lastEvaluationActionId }
        : {}),
      credits: current.credits,
      task: {
        id: BENCHMARK.id,
        prompt: BENCHMARK.prompt,
        publicChecks: BENCHMARK.publicChecks,
        evaluatorVersion: BENCHMARK.evaluatorVersion,
        ...(liveMode ? {
          agentProtocol: "protein-openai-responses-tools/v1",
          maxModelTurns,
          maxToolCalls,
          artifactContract: "javascript-esm-export-solve-values/v1",
          scoreReference: {
            kind: "within_run_verified_seed_multiple",
            seedScore: seedScoreReference,
          },
        } : {}),
      },
      neighborhood,
    },
  };
}

function candidateView(state) {
  return {
    candidateId: state.candidateId,
    strategy: state.strategy,
    score: state.score,
    evidenceId: state.lastEvidenceId,
    artifactRef: state.lastArtifactRef,
    evaluationActionId: state.lastEvaluationActionId ?? null,
    behavior: state.lastBehavior ?? "seed",
  };
}

function authoritativeStates(snapshot, generation) {
  const states = {};
  assert(snapshot?.experimentId === experimentId, "board snapshot has the wrong experiment");
  assert(snapshot?.generation === generation, "board snapshot has the wrong generation");
  for (const [agent, cell] of Object.entries(snapshot?.cells ?? {})) {
    assert(cells.some((candidate) => candidate.id === agent), "board snapshot has an unknown agent");
    assert(cell !== null && typeof cell === "object", `${agent} board snapshot has no cell state`);
    assert(typeof cell.credits === "number", `${agent} board snapshot has no credit balance`);
    states[agent] = {
      candidateId: cell.candidateId,
      strategy: cell.strategy,
      score: cell.score,
      credits: cell.credits,
      lastBehavior: cell.behavior,
      lastEvidenceId: cell.evidenceId,
      lastArtifactRef: cell.artifactRef,
      lastEvaluationActionId: cell.evaluationActionId,
      generation,
      status: "waiting",
    };
  }
  assert(Object.keys(states).length === cells.length, "board snapshot did not contain every cell");
  return states;
}

function publicJournalEntry(entry) {
  if (entry === null || typeof entry !== "object") return { redacted: true };
  const sourceData = entry.data !== null && typeof entry.data === "object" && !Array.isArray(entry.data)
    ? entry.data
    : {};
  const data = {};
  const safeScalars = [
    "phase", "reason", "receivedGeneration", "currentGeneration", "expectedActionId",
    "attempt", "revision", "type", "kind", "safety", "generation", "protocol", "turn",
    "functionName", "modelTurn", "toolTurn", "behavior", "candidateId", "score", "status",
    "category",
    "accepted", "agent", "experimentId", "receivedAt", "submissionId", "evidenceId",
    "publicPass", "hiddenPass", "evaluationActionId", "toolName", "responseId", "model",
    "providerRequestId", "clientRequestId", "promptVersion", "promptSha256",
    "toolSchemaVersion", "toolSchemaSha256", "executorActionId",
  ];
  for (const key of safeScalars) {
    const value = sourceData[key];
    if (["string", "number", "boolean"].includes(typeof value) || value === null) data[key] = value;
  }
  if (typeof sourceData.callId === "string") data.callIdSha256 = sha256(sourceData.callId);
  if (sourceData.functionCall !== null && typeof sourceData.functionCall === "object") {
    data.functionCall = {
      name: typeof sourceData.functionCall.name === "string" ? sourceData.functionCall.name : null,
      callIdSha256: typeof sourceData.functionCall.callId === "string"
        ? sha256(sourceData.functionCall.callId)
        : null,
      argumentsSha256: typeof sourceData.functionCall.arguments === "string"
        ? sha256(sourceData.functionCall.arguments)
        : null,
    };
  }
  if (sourceData.usage !== null && typeof sourceData.usage === "object") {
    data.usage = Object.fromEntries(
      ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"]
        .filter((key) => typeof sourceData.usage[key] === "number")
        .map((key) => [key, sourceData.usage[key]]),
    );
  }
  if (sourceData.benchmark !== null && typeof sourceData.benchmark === "object") {
    data.benchmark = Object.fromEntries(
      ["inputItems", "rounds", "medianMs", "minMs", "throughputItemsPerMs"]
        .filter((key) => typeof sourceData.benchmark[key] === "number")
        .map((key) => [key, sourceData.benchmark[key]]),
    );
  }
  return {
    sequence: entry.sequence,
    kind: entry.kind,
    eventId: entry.eventId,
    runId: entry.runId,
    actionId: entry.actionId,
    data,
    createdAt: entry.createdAt,
    redacted: true,
  };
}

async function collectGeneration(generation) {
  return mapConcurrent(cells, Math.min(16, cells.length), async (cell) => {
    const [state, actionsResult, journalResult] = await Promise.all([
      getJson(cellUrl(cell.id, "/state")),
      getJson(cellUrl(cell.id, "/actions?limit=100")),
      getJson(cellUrl(cell.id, "/journal?limit=500")),
    ]);
    const inspection = { state, actions: actionsResult.actions, journal: journalResult.journal };
    await writeJson(join(cellDirectory, cell.id, `generation-${generation}.json`), inspection);
    for (const entry of inspection.journal) {
      const key = `${cell.id}:${entry.sequence}`;
      if (seenJournal.has(key)) continue;
      seenJournal.add(key);
      await timeline("protein.journal", {
        cellId: cell.id,
        entry: liveMode ? publicJournalEntry(entry) : entry,
      });
    }
    return inspection;
  });
}

async function collectFinal() {
  const inspections = await collectGeneration(generations);
  for (let index = 0; index < inspections.length; index += 1) {
    await writeJson(join(cellDirectory, cells[index].id, "final-state.json"), inspections[index].state);
    await writeJson(join(cellDirectory, cells[index].id, "actions.json"), { actions: inspections[index].actions });
    await writeJson(join(cellDirectory, cells[index].id, "journal.json"), { journal: inspections[index].journal });
  }
  return inspections;
}

function validateFinalEvidence(inspections) {
  assert(inspections.length === cells.length, "not all cells were inspected");
  const names = new Set();
  for (const inspection of inspections) {
    names.add(inspection.state.agent);
    assert(inspection.state.state.experimentId === experimentId, `${inspection.state.agent} has the wrong experiment`);
    assert(inspection.state.state.generation === generations, `${inspection.state.agent} did not reach the last generation`);
    assert(inspection.state.state.status === "waiting", `${inspection.state.agent} is not waiting`);
    assert(inspection.actions.length >= generations * 2, `${inspection.state.agent} has too few durable actions`);
    assert(inspection.actions.every((action) => action.status === "delivered"), `${inspection.state.agent} has an undelivered action`);
    assert(inspection.journal.some((entry) => entry.kind === "action.delivered"), `${inspection.state.agent} has no delivered-action journal evidence`);
    assert(inspection.journal.length < 500, `${inspection.state.agent} journal inspection may be truncated`);
  }
  assert(names.size === cells.length, `expected ${cells.length} independent cell identities, found ${names.size}`);
}

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  stopRssSampler();
  await stopCelldInstance(runError === undefined ? "completed" : "failed");
  await rssQueue;
  if (liveMode) {
    await Promise.all(liveServices.map((entry) => stopChild(entry.child)));
    for (const entry of liveServices) {
      entry.stdout.end();
      entry.stderr.end();
    }
  } else {
    await stopChild(capability);
    capability = undefined;
    capabilityStdout?.end();
    capabilityStderr?.end();
  }
  if (minioStarted) {
    minioStarted = false;
    stopMinio(minioName);
  }
  await timelineQueue;
}

function setPhase(nextPhase) {
  closePhase();
  phase = nextPhase;
  phaseStartedAt = performance.now();
  void timeline("phase.changed", { phase: nextPhase });
}

function closePhase() {
  const duration = performance.now() - phaseStartedAt;
  phaseDurationsMs[phase] = Number(((phaseDurationsMs[phase] ?? 0) + duration).toFixed(3));
  phaseStartedAt = performance.now();
}

function timeline(kind, data) {
  const entry = envelope(kind, data);
  timelineQueue = timelineQueue.then(() => appendFile(timelinePath, `${JSON.stringify(entry)}\n`));
  return timelineQueue;
}

function envelope(kind, data) {
  return {
    schemaVersion: 1,
    runId,
    observedAt: new Date().toISOString(),
    elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
    kind,
    phase,
    ...data,
  };
}

function cellUrl(cellId, suffix) {
  return `${celldUrl}/cells/${encodeURIComponent(cellId)}${suffix}`;
}

async function post(url, body, expectedStatus, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const value = text.length === 0 ? null : JSON.parse(text);
  if (response.status !== expectedStatus) {
    throw new Error(`POST ${url} returned ${response.status}, expected ${expectedStatus}: ${text}`);
  }
  return value;
}

async function postWithStatus(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : JSON.parse(text),
  };
}

async function writeJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

function createCells() {
  const result = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      result.push({
        id: `${runId}-r${String(row).padStart(2, "0")}c${String(column).padStart(2, "0")}`,
        row,
        column,
      });
    }
  }
  return result;
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(values[index], index);
      }
    }),
  );
  return results;
}

function countBy(values, key) {
  return Object.fromEntries(
    [...values.reduce((counts, value) => {
      const name = String(key(value));
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return counts;
    }, new Map())],
  );
}

function latencySummary(values) {
  if (values.length === 0) return { samples: 0, p50: 0, p95: 0, max: 0 };
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (ratio) => ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))];
  return {
    samples: ordered.length,
    p50: Number(percentile(0.5).toFixed(3)),
    p95: Number(percentile(0.95).toFixed(3)),
    max: Number(ordered.at(-1).toFixed(3)),
  };
}

async function liveDiscoveryCounters() {
  const [modelGateway, toolExecutor, evaluator] = await Promise.all([
    getJson(modelGatewayUrl + "/stats"),
    getJson(toolExecutorUrl + "/stats"),
    getJson(evaluatorUrl + "/stats"),
  ]);
  return {
    responsesTokens: requiredCounter(modelGateway.usage?.totalTokens, "modelGateway.usage.totalTokens"),
    inputTokens: requiredCounter(modelGateway.usage?.inputTokens, "modelGateway.usage.inputTokens"),
    outputTokens: requiredCounter(modelGateway.usage?.outputTokens, "modelGateway.usage.outputTokens"),
    reasoningTokens: requiredCounter(modelGateway.usage?.reasoningTokens, "modelGateway.usage.reasoningTokens"),
    modelTurns: requiredCounter(modelGateway.completedActions, "modelGateway.completedActions"),
    providerRequests: requiredCounter(modelGateway.providerRequests, "modelGateway.providerRequests"),
    providerRetries: requiredCounter(modelGateway.providerRetries, "modelGateway.providerRetries"),
    ambiguousProviderAttempts: requiredCounter(
      modelGateway.ambiguousProviderAttempts,
      "modelGateway.ambiguousProviderAttempts",
    ),
    toolExecutions: requiredCounter(toolExecutor.completedActions, "toolExecutor.completedActions"),
    publicChecks: requiredCounter(toolExecutor.publicChecks, "toolExecutor.publicChecks"),
    evaluations: requiredCounter(evaluator.completedActions, "evaluator.completedActions"),
    passedEvaluations: requiredCounter(evaluator.passedEvaluations, "evaluator.passedEvaluations"),
  };
}

async function liveDiscoveryCost(baseline, states, discoveryStartedAt) {
  const current = await liveDiscoveryCounters();
  const difference = (key) => Math.max(0, current[key] - baseline[key]);
  return {
    responsesTokens: difference("responsesTokens"),
    inputTokens: difference("inputTokens"),
    outputTokens: difference("outputTokens"),
    reasoningTokens: difference("reasoningTokens"),
    modelTurns: difference("modelTurns"),
    providerRequests: difference("providerRequests"),
    providerRetries: difference("providerRetries"),
    ambiguousProviderAttempts: difference("ambiguousProviderAttempts"),
    toolExecutions: difference("toolExecutions"),
    publicChecks: difference("publicChecks"),
    evaluations: difference("evaluations"),
    passedEvaluations: difference("passedEvaluations"),
    creditsSpent: Math.max(
      0,
      cells.length * creditsPerCell - Object.values(states).reduce(
        (total, state) => total + finiteCounter(state?.credits),
        0,
      ),
    ),
    elapsedMs: Number((performance.now() - discoveryStartedAt).toFixed(3)),
  };
}

function generationFinalist(snapshot) {
  const candidates = Object.entries(snapshot?.cells ?? {})
    .filter(([, candidate]) =>
      candidate !== null &&
      typeof candidate === "object" &&
      typeof candidate.candidateId === "string" &&
      typeof candidate.artifactRef === "string" &&
      typeof candidate.strategy === "string" &&
      Number.isFinite(candidate.score)
    )
    .sort(([leftAgent, left], [rightAgent, right]) =>
      right.score - left.score || leftAgent.localeCompare(rightAgent)
    );
  if (candidates.length === 0) return null;
  const [agent, candidate] = candidates[0];
  return {
    generation: snapshot.generation,
    agent,
    candidateId: candidate.candidateId,
    artifactRef: candidate.artifactRef,
    strategy: candidate.strategy,
    originalScore: candidate.score,
    originalEvidenceId: candidate.evidenceId ?? null,
    originalEvaluationActionId: candidate.evaluationActionId ?? null,
  };
}

async function measureQualityTarget(seed, finalists, metrics) {
  const measurementStartedAt = performance.now();
  const discoverySnapshot = await getJson(evaluatorUrl + "/snapshot");
  const panelSelection = targetCandidatePanel(discoverySnapshot, seed.candidateId, finalists);
  const panel = panelSelection.candidates;
  const observations = new Map(panel.map((candidate) => [candidate.candidateId, []]));
  const blockAttempts = [];
  let measurementEvaluations = 0;
  let measurementComplete = true;
  for (let repeat = 1; repeat <= qualityTargetRecheckPairs; repeat += 1) {
    const ordered = balancedCandidateOrder(panel, repeat);
    const blocks = chunked(ordered, qualityTargetBlockSize);
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const candidates = blocks[blockIndex];
      let accepted = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const measured = await measureTargetBlock({
          seed,
          candidates,
          repeat,
          blockIndex: blockIndex + 1,
          attempt,
        });
        measurementEvaluations += measured.evaluations;
        blockAttempts.push(measured);
        if (measured.baselineValid) {
          accepted = measured;
          break;
        }
      }
      if (accepted === null) {
        measurementComplete = false;
        continue;
      }
      for (const candidate of accepted.candidates) {
        observations.get(candidate.candidateId).push({
          repeat,
          block: blockIndex + 1,
          attempt: accepted.attempt,
          position: candidate.position,
          baselineBefore: accepted.baselineBefore,
          baselineAfter: accepted.baselineAfter,
          result: candidate.result,
          correctnessPass: candidate.result.publicPass === true && candidate.result.hiddenPass === true,
          ratio: candidate.result.hiddenPass === true
            ? fixedNumber(candidate.result.score / accepted.baselineGeometricMean, 8)
            : null,
        });
      }
    }
  }
  const candidates = panel.map((candidate) => {
    const repetitions = observations.get(candidate.candidateId);
    const complete = repetitions.length === qualityTargetRecheckPairs;
    const correctnessPasses = repetitions.filter((entry) => entry.correctnessPass).length;
    const ratios = repetitions.flatMap((entry) => entry.ratio === null ? [] : [entry.ratio]);
    const passingRatios = ratios.filter((ratio) => ratio >= qualityTargetMultiplier).length;
    return {
      ...candidate,
      repetitions,
      complete,
      correctnessPasses,
      passingRatios,
      medianRatio: fixedNumber(medianNumber(ratios), 8),
      minimumRatio: ratios.length === 0 ? null : fixedNumber(Math.min(...ratios), 8),
      maximumRatio: ratios.length === 0 ? null : fixedNumber(Math.max(...ratios), 8),
      qualifies: complete &&
        correctnessPasses === qualityTargetRecheckPairs &&
        passingRatios >= qualityTargetRequiredRatios,
    };
  });
  const qualifying = candidates
    .filter((candidate) => candidate.qualifies)
    .sort((left, right) =>
      left.firstEvaluatedGeneration - right.firstEvaluatedGeneration ||
      right.passingRatios - left.passingRatios ||
      right.medianRatio - left.medianRatio ||
      left.candidateId.localeCompare(right.candidateId)
    );
  const firstReached = qualifying[0] ?? null;
  const firstReachMetric = firstReached === null
    ? null
    : metrics.find((metric) => metric.generation === firstReached.firstEvaluatedGeneration) ?? null;
  const finalBoundary = metrics.at(-1)?.cumulative ?? null;
  const valid = measurementComplete &&
    panelSelection.audit.valid &&
    metrics.length === generations &&
    metrics.every((entry) => entry.cumulative !== null) &&
    (firstReached === null || firstReachMetric?.cumulative !== undefined);
  return {
    schemaVersion: 1,
    evidenceLevel,
    protocol: "protein-fixed-quality-recheck/v1",
    experimentId,
    condition,
    target: {
      metric: "candidate_to_interleaved_baseline_score_ratio",
      multiplier: qualityTargetMultiplier,
      comparator: ">=",
      rechecksPerCandidate: qualityTargetRecheckPairs,
      requiredPassingRatios: qualityTargetRequiredRatios,
      requiredCorrectnessPasses: qualityTargetRecheckPairs,
      blockSize: qualityTargetBlockSize,
      maximumBaselineDriftRatio: qualityTargetMaximumBaselineDrift,
      benchmarkId: BENCHMARK.id,
      evaluatorVersion: BENCHMARK.evaluatorVersion,
      decisionBoundary: "generation_settled",
    },
    valid,
    onlineGenerationFinalists: finalists,
    panel: {
      distinctCandidates: candidates.length,
      audit: panelSelection.audit,
      candidates,
    },
    blockAttempts,
    firstReach: firstReached === null ? null : {
      generation: firstReached.firstEvaluatedGeneration,
      candidateId: firstReached.candidateId,
      medianRatio: firstReached.medianRatio,
      passingRatios: firstReached.passingRatios,
      discovery: firstReachMetric?.cumulative ?? null,
    },
    censoring: firstReached === null ? {
      reason: "generation_cap",
      generation: generations,
      boundary: finalBoundary,
    } : null,
    measurement: {
      evaluations: measurementEvaluations,
      elapsedMs: Number((performance.now() - measurementStartedAt).toFixed(3)),
      execution: "serialized evaluator; candidate blocks bracketed by fresh baselines; deterministic order balanced by repetition",
      includedInDiscoveryCost: false,
      completedBlocks: blockAttempts.filter((entry) => entry.baselineValid).length,
      invalidBlockAttempts: blockAttempts.filter((entry) => !entry.baselineValid).length,
    },
  };
}

function targetCandidatePanel(snapshot, seedCandidateId, finalists) {
  const evidenceRecords = Object.values(snapshot?.evidence ?? {});
  const actionRecords = Object.values(snapshot?.actions ?? {});
  const expectedSeed = optionalMetricCounter(snapshot?.metrics?.evaluationsByPurpose?.seed, "seed evaluations");
  const expectedDiscovery = optionalMetricCounter(
    snapshot?.metrics?.evaluationsByPurpose?.agent_discovery,
    "agent discovery evaluations",
  );
  const seedEvidence = evidenceRecords.filter((evidence) => evidence?.purpose === "seed");
  const discoveryEvidence = evidenceRecords.filter((evidence) => evidence?.purpose === "agent_discovery");
  const seedActions = actionRecords.filter((action) => action?.purpose === "seed");
  const discoveryActions = actionRecords.filter((action) => action?.purpose === "agent_discovery");
  const unknownPurposes = [
    ...evidenceRecords.map((record) => record?.purpose),
    ...actionRecords.map((record) => record?.purpose),
  ].filter((purpose) => purpose !== "seed" && purpose !== "agent_discovery");
  if (unknownPurposes.length > 0) {
    throw new Error("Discovery evaluator snapshot contains an unknown or missing purpose");
  }
  if (
    expectedSeed !== 1 ||
    seedEvidence.length !== expectedSeed ||
    seedActions.length !== expectedSeed ||
    expectedDiscovery !== discoveryEvidence.length ||
    expectedDiscovery !== discoveryActions.length
  ) {
    throw new Error(
      `Discovery evaluator snapshot count mismatch: metrics ${expectedDiscovery}, evidence ${discoveryEvidence.length}, actions ${discoveryActions.length}`,
    );
  }
  const evidenceById = new Map(evidenceRecords.map((evidence) => [evidence?.evidenceId, evidence]));
  for (const action of [...seedActions, ...discoveryActions]) {
    const evidence = evidenceById.get(action?.evidenceId);
    if (
      action?.status !== "completed" ||
      typeof action.candidateId !== "string" ||
      typeof action.evidenceId !== "string" ||
      evidence === undefined ||
      evidence.candidateId !== action.candidateId ||
      evidence.purpose !== action.purpose
    ) {
      throw new Error("Discovery evaluator action is incomplete or does not reconcile to its evidence");
    }
  }
  if (seedEvidence[0]?.candidateId !== seedCandidateId) {
    throw new Error("Discovery evaluator seed evidence does not match the trusted seed");
  }
  const byCandidate = new Map();
  for (const evidence of discoveryEvidence) {
    if (
      evidence === null ||
      typeof evidence !== "object" ||
      typeof evidence.candidateId !== "string" ||
      typeof evidence.candidateRef !== "string" ||
      typeof evidence.evidenceId !== "string" ||
      typeof evidence.agent !== "string" ||
      typeof evidence.strategy !== "string" ||
      !Number.isInteger(evidence.generation) ||
      evidence.generation < 1 ||
      evidence.generation > generations
    ) {
      throw new Error("Discovery evaluator evidence is malformed");
    }
    if (evidence.candidateId === seedCandidateId) continue;
    const candidate = {
      candidateId: evidence.candidateId,
      artifactRef: evidence.candidateRef,
      strategy: typeof evidence.strategy === "string" ? evidence.strategy : "unrecorded strategy",
      firstEvaluatedGeneration: evidence.generation,
      discoveryAgent: evidence.agent ?? null,
      discoveryEvidenceId: evidence.evidenceId ?? null,
    };
    const prior = byCandidate.get(candidate.candidateId);
    if (
      prior === undefined ||
      candidate.firstEvaluatedGeneration < prior.firstEvaluatedGeneration ||
      (
        candidate.firstEvaluatedGeneration === prior.firstEvaluatedGeneration &&
        String(candidate.discoveryAgent).localeCompare(String(prior.discoveryAgent)) < 0
      )
    ) {
      byCandidate.set(candidate.candidateId, candidate);
    }
  }
  const candidates = [...byCandidate.values()].sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId)
  );
  const candidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
  const missingFinalists = finalists
    .filter((finalist) => finalist.candidateId !== seedCandidateId && !candidateIds.has(finalist.candidateId))
    .map((finalist) => ({ generation: finalist.generation, candidateId: finalist.candidateId }));
  if (missingFinalists.length > 0) {
    throw new Error(`Discovery finalist missing from target panel: ${missingFinalists[0].candidateId}`);
  }
  return {
    candidates,
    audit: {
      valid: true,
      expectedSeedEvaluations: expectedSeed,
      expectedDiscoveryEvaluations: expectedDiscovery,
      reconciledDiscoveryActions: discoveryActions.length,
      reconciledDiscoveryEvidence: discoveryEvidence.length,
      distinctCandidates: candidates.length,
      nonSeedFinalists: finalists.filter((finalist) => finalist.candidateId !== seedCandidateId).length,
      missingFinalists,
    },
  };
}

function optionalMetricCounter(value, label) {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function balancedCandidateOrder(panel, repeat) {
  if (panel.length < 2) return [...panel];
  const offset = (repeat - 1) % panel.length;
  const rotated = [...panel.slice(offset), ...panel.slice(0, offset)];
  return repeat % 2 === 0 ? rotated.reverse() : rotated;
}

function chunked(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function measureTargetBlock({ seed, candidates, repeat, blockIndex, attempt }) {
  const prefix = `swarm:${experimentId}:quality-target:r${repeat}:b${blockIndex}:a${attempt}`;
  const baselineBefore = await targetReevaluation(seed, `${prefix}:baseline-pre`, "baseline");
  const measuredCandidates = [];
  for (let position = 0; position < candidates.length; position += 1) {
    const candidate = candidates[position];
    measuredCandidates.push({
      candidateId: candidate.candidateId,
      position: position + 1,
      result: await targetReevaluation(
        candidate,
        `${prefix}:candidate:${candidate.candidateId.slice(-16)}`,
        "candidate",
      ),
    });
  }
  const baselineAfter = await targetReevaluation(seed, `${prefix}:baseline-post`, "baseline");
  const baselineScoresValid = baselineBefore.hiddenPass === true &&
    baselineAfter.hiddenPass === true &&
    Number.isFinite(baselineBefore.score) && baselineBefore.score > 0 &&
    Number.isFinite(baselineAfter.score) && baselineAfter.score > 0;
  const baselineDriftRatio = baselineScoresValid
    ? Math.max(baselineBefore.score, baselineAfter.score) /
      Math.min(baselineBefore.score, baselineAfter.score)
    : null;
  const baselineValid = baselineScoresValid && baselineDriftRatio <= qualityTargetMaximumBaselineDrift;
  return {
    repeat,
    block: blockIndex,
    attempt,
    baselineBefore,
    candidates: measuredCandidates,
    baselineAfter,
    baselineDriftRatio: fixedNumber(baselineDriftRatio, 8),
    baselineGeometricMean: baselineValid
      ? Math.sqrt(baselineBefore.score * baselineAfter.score)
      : null,
    baselineValid,
    evaluations: candidates.length + 2,
  };
}

async function targetReevaluation(candidate, actionId, role) {
  const result = await post(evaluatorUrl + "/actions", {
    actionId,
    agent: "quality-target-controller",
    kind: "swarm.reevaluate",
    payload: {
      experimentId,
      generation: candidate.firstEvaluatedGeneration ?? 0,
      candidateId: candidate.candidateId,
      candidateRef: candidate.artifactRef,
      behavior: "recheck",
      strategy: candidate.strategy,
      rationale: `Preregistered fixed-quality ${role} recheck.`,
      parentCandidateIds: [],
      purpose: role === "baseline"
        ? "quality_target_baseline_recheck"
        : "quality_target_candidate_recheck",
    },
  }, 200, { "idempotency-key": actionId });
  return {
    actionId,
    evidenceId: result.evidenceId,
    candidateId: result.candidateId,
    score: result.score,
    publicPass: result.publicPass,
    hiddenPass: result.hiddenPass,
  };
}

function finiteCounter(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requiredCounter(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}

function medianNumber(values) {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function fixedNumber(value, digits) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

async function analyzeCelldLog() {
  try {
    const content = await readFile(celldLogPath, "utf8");
    const count = (pattern) => content.split("\n").filter((line) => pattern.test(line)).length;
    return {
      bytes: Buffer.byteLength(content),
      warnings: count(/\sWARN\s/),
      errors: count(/\sERROR\s/),
      peerOwnerUnreachable: count(/peer owner unreachable/),
      proteinCheckpoints: count(/"component":"protein\.swarm-cell"/),
    };
  } catch (error) {
    return { collectionError: String(error) };
  }
}

async function analyzeLiveServiceLogs() {
  const result = {};
  for (const name of ["model-gateway", "tool-executor", "evaluator", "board"]) {
    try {
      const [jsonl, stdout, stderr] = await Promise.all([
        readFile(join(processDirectory, `${name}.jsonl`), "utf8"),
        readFile(join(processDirectory, `${name}.stdout.log`), "utf8"),
        readFile(join(processDirectory, `${name}.stderr.log`), "utf8"),
      ]);
      const entries = jsonl.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      result[name] = {
        records: entries.length,
        failedRecords: entries.filter((entry) => String(entry.kind).endsWith(".failed")).length,
        http5xx: entries.filter((entry) => entry.kind === "http.request" && Number(entry.status) >= 500).length,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      };
    } catch (error) {
      result[name] = { collectionError: String(error) };
    }
  }
  return result;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function optionalBoundedNumber(value, minimum, maximum) {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected a number between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function optionalIdentifier(value) {
  if (value === undefined || value === "") return null;
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(value)) {
    throw new Error("SWARM_COMPARISON_ID must be a bounded identifier");
  }
  return value;
}

function optionalConditionOrder(value) {
  if (value === "local-first" || value === "isolated-first") return value;
  throw new Error("SWARM_CONDITION_ORDER must be local-first or isolated-first");
}

function gitIdentity() {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  return {
    commit: commit.status === 0 ? commit.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function assert(conditionValue, message) {
  if (!conditionValue) throw new Error(message);
}
