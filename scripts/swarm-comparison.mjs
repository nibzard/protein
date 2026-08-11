const CONDITIONS = ["local", "isolated"];
const RUN_CONTROL_FIELDS = [
  "celldVersion",
  "workerBundleSha256",
  "responsesProtocol",
  "model",
  "reasoningEffort",
  "promptVersion",
  "toolSchemaVersion",
  "toolSchemaSha256",
  "modelMaxOutputTokens",
  "providerStore",
  "benchmarkId",
  "evaluatorVersion",
  "sandboxImageId",
  "publicBenchmarkConcurrency",
  "hiddenBenchmarkConcurrency",
  "rows",
  "columns",
  "generations",
  "totalCredits",
  "maxModelTurns",
  "maxToolCalls",
  "dispatchConcurrency",
  "providerTimeoutMs",
  "providerMaximumAttempts",
];
const TARGET_CONTROL_FIELDS = [
  "protocol",
  "multiplier",
  "rechecksPerCandidate",
  "requiredPassingRatios",
  "requiredCorrectnessPasses",
  "blockSize",
  "maximumBaselineDriftRatio",
];

export function projectSwarmRun({
  summary,
  manifest,
  seed,
  serviceSnapshots = null,
  qualityTarget = null,
  summaryPath,
}) {
  const modelGateway = summary.services?.modelGateway ?? {};
  const toolExecutor = summary.services?.toolExecutor ?? {};
  const evaluator = summary.services?.evaluator ?? {};
  const budget = manifest.budget ?? {};
  const seedScore = finiteNumber(seed?.score);
  const bestScore = finiteNumber(summary.experiment?.bestScore);
  const gain = seedScore === null || bestScore === null ? null : bestScore - seedScore;
  const gainPct = seedScore === null || seedScore === 0 || gain === null
    ? null
    : (gain / seedScore) * 100;
  const generationMetrics = Array.isArray(summary.experiment?.generationMetrics)
    ? summary.experiment.generationMetrics
    : [];
  const discoveryCounters = generationMetrics.at(-1)?.cumulative ?? null;

  return {
    runId: summary.runId,
    status: summary.status,
    summaryPath,
    condition: summary.experiment?.condition ?? manifest.topology?.condition ?? null,
    celldVersion: summary.celld?.version ?? null,
    workerBundleSha256: manifest.source?.workerBundleSha256 ?? null,
    responsesProtocol: modelGateway.protocol ?? manifest.source?.modelGateway?.protocol ?? null,
    model: modelGateway.model ?? manifest.source?.modelGateway?.model ?? null,
    reasoningEffort: modelGateway.reasoningEffort ?? manifest.source?.modelGateway?.reasoningEffort ?? null,
    promptVersion: modelGateway.promptVersion ?? manifest.source?.modelGateway?.promptVersion ?? null,
    toolSchemaVersion: modelGateway.toolSchemaVersion ?? manifest.source?.modelGateway?.toolSchemaVersion ?? null,
    toolSchemaSha256: modelGateway.toolSchemaSha256 ?? manifest.source?.modelGateway?.toolSchemaSha256 ?? null,
    modelMaxOutputTokens: finiteNumber(modelGateway.maxOutputTokens) ?? null,
    providerStore: manifest.source?.modelGateway?.store ?? null,
    benchmarkId: manifest.source?.benchmarkId ?? toolExecutor.benchmark?.id ?? null,
    evaluatorVersion: manifest.source?.evaluatorVersion ?? evaluator.evaluatorVersion ?? null,
    sandboxImageId: manifest.source?.sandbox?.imageId ?? null,
    publicBenchmarkConcurrency: finiteNumber(toolExecutor.benchmarkConcurrency) ?? null,
    hiddenBenchmarkConcurrency: finiteNumber(evaluator.benchmarkConcurrency) ?? null,
    seedScore,
    bestScore,
    gain,
    gainPct: fixedOrNull(gainPct, 6),
    tokens: finiteNumber(modelGateway.usage?.totalTokens) ?? 0,
    inputTokens: finiteNumber(modelGateway.usage?.inputTokens) ?? 0,
    outputTokens: finiteNumber(modelGateway.usage?.outputTokens) ?? 0,
    reasoningTokens: finiteNumber(modelGateway.usage?.reasoningTokens) ?? 0,
    modelTurns: finiteNumber(modelGateway.completedActions) ?? 0,
    providerRetries: finiteNumber(modelGateway.providerRetries) ?? 0,
    ambiguousProviderAttempts: finiteNumber(modelGateway.ambiguousProviderAttempts) ?? 0,
    providerTimeoutMs: finiteNumber(modelGateway.providerTimeoutMs) ?? null,
    providerMaximumAttempts: finiteNumber(modelGateway.providerMaximumAttempts) ?? null,
    toolExecutions: finiteNumber(toolExecutor.completedActions) ?? 0,
    publicChecks: finiteNumber(toolExecutor.publicChecks) ?? 0,
    evaluations: finiteNumber(discoveryCounters?.evaluations) ?? finiteNumber(evaluator.completedActions) ?? 0,
    passedEvaluations: finiteNumber(discoveryCounters?.passedEvaluations) ??
      finiteNumber(evaluator.passedEvaluations) ?? 0,
    elapsedMs: finiteNumber(summary.elapsedMs) ?? 0,
    fallbacks: finiteNumber(summary.protein?.modelDecisionFallbacks) ?? 0,
    totalCredits: finiteNumber(budget.totalCredits) ?? 0,
    creditsSpent: Math.max(
      0,
      (finiteNumber(budget.totalCredits) ?? 0) - (finiteNumber(summary.experiment?.remainingCredits) ?? 0),
    ),
    rows: finiteNumber(summary.experiment?.rows) ?? null,
    columns: finiteNumber(summary.experiment?.columns) ?? null,
    generations: finiteNumber(summary.experiment?.generations) ?? null,
    maxModelTurns: finiteNumber(budget.maxModelTurnsPerCellGeneration) ?? null,
    maxToolCalls: finiteNumber(budget.maxToolCallsPerCellGeneration) ?? null,
    dispatchConcurrency: finiteNumber(budget.dispatchConcurrency) ?? null,
    generationMetrics: generationMetrics.length > 0
      ? generationMetrics.map((entry) => ({
          generation: entry.generation,
          bestScore: entry.bestScore,
          elapsedMs: entry.elapsedMs,
          submissions: entry.submissions,
        }))
      : [],
    target: qualityTargetProjection(qualityTarget, { summary, manifest }),
    lineage: lineageMetrics(serviceSnapshots, summary.experiment?.generations),
  };
}

export function buildAttemptIntegrityAudit({
  attempt = null,
  comparisonId = null,
  summary = null,
  manifest = null,
  modelGatewayPrivateState = null,
  qualityTarget = null,
} = {}) {
  const summaryGateway = summary?.services?.modelGateway ?? null;
  const privateGatewayMetrics = modelGatewayPrivateState?.metrics ?? null;
  const targetBoundary = qualityTarget?.firstReach?.discovery ?? qualityTarget?.censoring?.boundary ?? null;
  const finalAmbiguitySources = [
    ["summary", summaryGateway?.ambiguousProviderAttempts],
    ["private_gateway_state", privateGatewayMetrics?.ambiguousProviderAttempts],
  ].flatMap(([source, value]) => {
    const count = finiteNumber(value);
    return count === null ? [] : [{ source, count }];
  });
  const targetAmbiguity = finiteNumber(targetBoundary?.ambiguousProviderAttempts);
  const ambiguitySources = [
    ...finalAmbiguitySources,
    ...(targetAmbiguity === null ? [] : [{ source: "target_ledger_boundary", count: targetAmbiguity }]),
  ];
  const ambiguousProviderAttempts = ambiguitySources.length === 0
    ? null
    : Math.max(...ambiguitySources.map((entry) => entry.count));
  const exhaustedTargetBlocks = exhaustedTargetBlockRetries(qualityTarget);
  const generationCount = finiteNumber(summary?.experiment?.generations);
  const settledGenerations = Array.isArray(summary?.experiment?.generationMetrics)
    ? new Set(summary.experiment.generationMetrics.map((entry) => finiteNumber(entry?.generation)))
    : new Set();
  const discoveryComplete = Number.isInteger(generationCount) && generationCount > 0 &&
    Array.from({ length: generationCount }, (_, index) => index + 1)
      .every((generation) => settledGenerations.has(generation));
  const postDiscoveryEvidence = qualityTarget !== null || discoveryComplete;
  const finalUsageSources = [
    ["summary", summaryGateway?.usage?.totalTokens],
    ["private_gateway_state", privateGatewayMetrics?.usage?.totalTokens],
  ].flatMap(([source, value]) => {
    const totalTokens = finiteNumber(value);
    return totalTokens === null ? [] : [{ source, totalTokens }];
  });
  const providerEvidenceSources = [
    ["summary", summaryGateway],
    ["private_gateway_state", privateGatewayMetrics],
  ].flatMap(([source, gateway]) => {
    const providerRequests = finiteNumber(gateway?.providerRequests);
    const totalTokens = finiteNumber(gateway?.usage?.totalTokens);
    const ambiguityCount = finiteNumber(gateway?.ambiguousProviderAttempts);
    return providerRequests === null || totalTokens === null || ambiguityCount === null
      ? []
      : [{ source, providerRequests, totalTokens, ambiguousProviderAttempts: ambiguityCount }];
  });
  const assessed = summary !== null || manifest !== null ||
    modelGatewayPrivateState !== null || qualityTarget !== null;
  const expectedConditionOrder = Array.isArray(attempt?.order) && typeof attempt.order[0] === "string"
    ? `${attempt.order[0]}-first`
    : null;
  const identityChecks = [
    integrityIdentityCheck("summary.runId", summary?.runId, attempt?.runId),
    integrityIdentityCheck("manifest.runId", manifest?.runId, attempt?.runId),
    integrityIdentityCheck("manifest.experimentId", manifest?.experimentId, attempt?.runId),
    integrityIdentityCheck("summary.condition", summary?.experiment?.condition, attempt?.condition),
    integrityIdentityCheck("manifest.condition", manifest?.topology?.condition, attempt?.condition),
    integrityIdentityCheck("manifest.comparisonId", manifest?.comparison?.comparisonId, comparisonId),
    integrityIdentityCheck("manifest.trialIndex", manifest?.comparison?.trialIndex, attempt?.trial),
    integrityIdentityCheck("manifest.conditionOrder", manifest?.comparison?.conditionOrder, expectedConditionOrder),
  ].filter((check) => check !== null);
  const identityMismatches = identityChecks.filter((check) => check.equal === false);
  const reasons = [];
  if (!assessed) {
    reasons.push({
      code: "unassessed_attempt_integrity",
      detail: "The retained attempt has no run evidence from which to assess provider or target integrity.",
    });
  }
  if (identityMismatches.length > 0) {
    reasons.push({
      code: "attempt_identity_mismatch",
      detail: "The retained attempt record does not match the referenced run bundle identity.",
      mismatches: identityMismatches,
    });
  }
  if (ambiguousProviderAttempts !== null && ambiguousProviderAttempts > 0) {
    reasons.push({
      code: "ambiguous_provider_attempt",
      detail: `${ambiguousProviderAttempts} ambiguous provider attempt${ambiguousProviderAttempts === 1 ? "" : "s"} may have unrecorded token usage.`,
      ambiguousProviderAttempts,
      sources: ambiguitySources.filter((entry) => entry.count > 0),
    });
  }
  if (assessed && postDiscoveryEvidence && finalAmbiguitySources.length === 0) {
    reasons.push({
      code: "missing_ambiguity_evidence",
      detail: "The post-discovery attempt has no final authoritative ambiguous-provider-attempt counter.",
    });
  }
  if (assessed && postDiscoveryEvidence && finalUsageSources.length === 0) {
    reasons.push({
      code: "missing_provider_usage",
      detail: "The post-discovery attempt has no final authoritative recorded Responses-token usage.",
    });
  }
  if (
    assessed &&
    providerEvidenceSources.length === 0 &&
    (!postDiscoveryEvidence || (finalAmbiguitySources.length > 0 && finalUsageSources.length > 0))
  ) {
    reasons.push({
      code: "missing_provider_evidence",
      detail: "The attempt lacks one authoritative record containing provider requests, recorded tokens, and ambiguous-attempt count.",
    });
  }
  if (exhaustedTargetBlocks.length > 0) {
    reasons.push({
      code: "exhausted_target_block_retry",
      detail: `${exhaustedTargetBlocks.length} target-measurement block${exhaustedTargetBlocks.length === 1 ? "" : "s"} failed baseline validation twice.`,
      exhaustedTargetBlocks,
    });
  } else if (qualityTarget?.valid === false) {
    reasons.push({
      code: "invalid_target_ledger",
      detail: "The retained target ledger is invalid and has no reconstructable exhausted-block reason.",
    });
  }

  return {
    protocol: "protein-comparison-attempt-integrity/v1",
    assessed,
    evidence: {
      summary: summary !== null,
      manifest: manifest !== null,
      privateGatewayState: modelGatewayPrivateState !== null,
      targetLedger: qualityTarget !== null,
    },
    identityChecks,
    postDiscoveryEvidence,
    ambiguityAssessed: finalAmbiguitySources.length > 0,
    ambiguousProviderAttempts,
    providerUsageAssessed: finalUsageSources.length > 0,
    recordedResponsesTokens: finalUsageSources.length === 0
      ? null
      : Math.max(...finalUsageSources.map((entry) => entry.totalTokens)),
    providerEvidenceAssessed: providerEvidenceSources.length > 0,
    providerEvidenceSources,
    exhaustedTargetBlocks,
    validForPair: reasons.length === 0,
    reasons,
  };
}

export function buildFixedQualityComparisonSummary({
  comparisonId,
  startedAt,
  completedAt,
  config,
  trials,
  attempts = [],
  calibration = null,
}) {
  const normalizedAttempts = Array.isArray(attempts) ? attempts : [];
  const normalizedTrials = trials.map((trial) => summarizeFixedQualityTrial(
    trial,
    config,
    trialAttemptIntegrity(trial, normalizedAttempts),
  ));
  const attemptIntegrity = aggregateAttemptIntegrity(normalizedTrials);
  const allPairsValid = normalizedTrials.every((trial) => trial.valid);
  const controlChecks = normalizedTrials.flatMap((trial) => trial.controlChecks);
  const equalBudgetVerified = controlChecks.length > 0 && controlChecks.every((check) => check.equal);
  const globalControls = globalControlAudit(normalizedTrials, config);
  const validPairs = normalizedTrials.filter((trial) => trial.valid);
  const bothReached = validPairs.filter((trial) => trial.fixedQuality.outcome === "both_reached");
  const localOnly = validPairs.filter((trial) => trial.fixedQuality.outcome === "local_only");
  const isolatedOnly = validPairs.filter((trial) => trial.fixedQuality.outcome === "isolated_only");
  const neitherReached = validPairs.filter((trial) => trial.fixedQuality.outcome === "neither_reached");
  const localReached = validPairs.filter((trial) => trial.conditions.local.target.reached).length;
  const isolatedReached = validPairs.filter((trial) => trial.conditions.isolated.target.reached).length;
  const primaryDeltas = bothReached.map((trial) => trial.fixedQuality.localVsIsolatedPct.responsesTokens);
  const localWins = validPairs.filter((trial) => trial.fixedQuality.primaryOutcome === "local").length;
  const isolatedWins = validPairs.filter((trial) => trial.fixedQuality.primaryOutcome === "isolated").length;
  const ties = validPairs.filter((trial) => trial.fixedQuality.primaryOutcome === "tie").length;
  const nonTies = localWins + isolatedWins;
  const localExactP = nonTies === 0 ? 1 : binomialUpperTail(localWins, nonTies);
  const isolatedExactP = nonTies === 0 ? 1 : binomialUpperTail(isolatedWins, nonTies);
  const distributions = Object.fromEntries([
    "responsesTokens",
    "modelTurns",
    "toolExecutions",
    "publicChecks",
    "evaluations",
    "creditsSpent",
    "elapsedMs",
  ].map((metric) => [
    metric,
    costDistribution(
      bothReached.map((trial) => trial.fixedQuality.localVsIsolatedPct[metric]),
      config.bootstrapSamples,
      `${config.bootstrapSeed}:${metric}`,
    ),
  ]));
  const tokenDistribution = distributions.responsesTokens;
  const noAmbiguousUsage = !attemptIntegrity.reasons.some((reason) =>
    reason.code === "ambiguous_provider_attempt"
  );
  const conclusion = fixedQualityConclusion({
    configuredPairs: config.trials,
    validPairs: validPairs.length,
    allPairsValid,
    equalBudgetVerified,
    globalControlsVerified: globalControls.verified,
    comparablePairs: bothReached.length,
    minimumComparablePairs: config.minimumComparablePairs,
    localReached,
    isolatedReached,
    localWins,
    isolatedWins,
    localExactP,
    isolatedExactP,
    alpha: config.alpha,
    meaningfulCostDeltaPct: config.meaningfulCostDeltaPct,
    tokenDistribution,
    noAmbiguousUsage,
    attemptIntegrity,
  });

  return {
    schemaVersion: 2,
    comparisonId,
    status: allPairsValid && equalBudgetVerified && globalControls.verified &&
      validPairs.length === config.trials
      ? "passed"
      : "incomplete",
    evidenceLevel: "celld-comparison",
    startedAt,
    completedAt,
    config,
    calibration,
    trials: normalizedTrials,
    attempts: normalizedAttempts,
    aggregate: {
      pairs: config.trials,
      validPairs: validPairs.length,
      equalBudgetVerified,
      globalControlsVerified: globalControls.verified,
      globalControls,
      fixedQuality: {
        targetMultiplier: config.qualityTargetMultiplier,
        attainment: {
          local: { reached: localReached, total: validPairs.length, ratePct: percentage(localReached, validPairs.length) },
          isolated: { reached: isolatedReached, total: validPairs.length, ratePct: percentage(isolatedReached, validPairs.length) },
          pairs: {
            bothReached: bothReached.length,
            localOnly: localOnly.length,
            isolatedOnly: isolatedOnly.length,
            neitherReached: neitherReached.length,
            invalid: normalizedTrials.length - validPairs.length,
          },
        },
        comparablePairs: bothReached.length,
        localWins,
        isolatedWins,
        ties,
        exactOneSidedSignTest: {
          nonTiedPairs: nonTies,
          localWins,
          isolatedWins,
          pValue: fixedOrNull(localExactP, 8),
          alpha: config.alpha,
          local: {
            wins: localWins,
            pValue: fixedOrNull(localExactP, 8),
          },
          isolated: {
            wins: isolatedWins,
            pValue: fixedOrNull(isolatedExactP, 8),
          },
        },
        localVsIsolatedPct: distributions,
        noAmbiguousUsage,
        attemptIntegrity,
        conclusion,
      },
      qualityExploration: qualityAggregate(validPairs),
    },
    claimBoundary:
      "This preregistered systems experiment estimates recorded discovery cost to one fixed verified-quality target under one task and frozen Luna protocol. Non-reaching conditions are censored, recheck cost is excluded from discovery cost, and the result does not establish learning or general swarm superiority.",
    artifacts: {
      manifest: "manifest.json",
      summary: "summary.json",
      attempts: "attempts/",
      benchmarkCalibration: calibration === null ? null : "benchmark-calibration.json",
      frozenControls: "frozen-controls.json",
      runTargetLedgers: "celld-runs/<run-id>/quality-target.json",
    },
  };
}

export function buildComparisonSummary({
  comparisonId,
  startedAt,
  completedAt,
  config,
  trials,
  attempts = [],
  calibration = null,
}) {
  const threshold = finiteNumber(config.meaningfulThresholdPct) ?? 5;
  const normalizedTrials = trials.map((trial) => summarizeTrial(trial, threshold));
  const completedPairs = normalizedTrials.filter((trial) => trial.complete);
  const budgetChecks = normalizedTrials.flatMap((trial) => trial.budgetChecks);
  const equalBudgetVerified = budgetChecks.length > 0 && budgetChecks.every((check) => check.equal);
  const localRuns = completedPairs.map((trial) => trial.conditions.local);
  const isolatedRuns = completedPairs.map((trial) => trial.conditions.isolated);
  const pairedUplifts = completedPairs.map((trial) => trial.uplift.percentPoints);
  const localWins = completedPairs.filter((trial) => trial.outcome === "local").length;
  const isolatedWins = completedPairs.filter((trial) => trial.outcome === "isolated").length;
  const ties = completedPairs.filter((trial) => trial.outcome === "tie").length;
  const efficiency = pairedEfficiency(completedPairs);
  const allRunsPassed = normalizedTrials.every((trial) => trial.complete);
  const pairedMedian = median(pairedUplifts);
  const conclusion = comparisonConclusion({
    allRunsPassed,
    equalBudgetVerified,
    completedPairs: completedPairs.length,
    configuredPairs: config.trials,
    localWins,
    isolatedWins,
    pairedMedian,
    threshold,
  });

  return {
    schemaVersion: 1,
    comparisonId,
    status: allRunsPassed && equalBudgetVerified && completedPairs.length === config.trials
      ? "passed"
      : "incomplete",
    evidenceLevel: "celld-comparison",
    startedAt,
    completedAt,
    config,
    calibration,
    trials: normalizedTrials,
    attempts,
    aggregate: {
      pairs: config.trials,
      passedPairs: completedPairs.length,
      equalBudgetVerified,
      localWins,
      isolatedWins,
      ties,
      pairedUpliftPct: {
        values: pairedUplifts.map((value) => fixedOrNull(value, 6)),
        median: fixedOrNull(pairedMedian, 6),
        minimum: fixedOrNull(pairedUplifts.length === 0 ? null : Math.min(...pairedUplifts), 6),
        maximum: fixedOrNull(pairedUplifts.length === 0 ? null : Math.max(...pairedUplifts), 6),
      },
      local: aggregateCondition(localRuns),
      isolated: aggregateCondition(isolatedRuns),
      efficiency,
      conclusion,
    },
    claimBoundary:
      "This exploratory paired comparison measures two Protein topologies under the recorded Luna model, tool, benchmark, and budget controls. Three pairs can reveal a repeatable observed effect, but do not establish learning, statistical significance, or general swarm superiority.",
    artifacts: {
      manifest: "manifest.json",
      summary: "summary.json",
      attempts: "attempts/",
      benchmarkCalibration: calibration === null ? null : "benchmark-calibration.json",
    },
  };
}

function qualityTargetProjection(value, { summary, manifest }) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const firstReach = value.firstReach && typeof value.firstReach === "object" ? value.firstReach : null;
  const censoring = value.censoring && typeof value.censoring === "object" ? value.censoring : null;
  const boundary = firstReach?.discovery ?? censoring?.boundary ?? null;
  const generations = finiteNumber(summary.experiment?.generations);
  const projectedTarget = {
    protocol: value.protocol ?? null,
    multiplier: finiteNumber(value.target?.multiplier),
    rechecksPerCandidate: finiteNumber(value.target?.rechecksPerCandidate),
    requiredPassingRatios: finiteNumber(value.target?.requiredPassingRatios),
    requiredCorrectnessPasses: finiteNumber(value.target?.requiredCorrectnessPasses),
    blockSize: finiteNumber(value.target?.blockSize),
    maximumBaselineDriftRatio: finiteNumber(value.target?.maximumBaselineDriftRatio),
  };
  const validationErrors = [];
  if (value.experimentId !== summary.experimentId || value.condition !== summary.experiment?.condition) {
    validationErrors.push("target ledger identity does not match the run");
  }
  if (projectedTarget.protocol !== manifest.qualityTarget?.protocol) {
    validationErrors.push("target protocol does not match the run manifest");
  }
  for (const field of TARGET_CONTROL_FIELDS.filter((field) => field !== "protocol")) {
    if (projectedTarget[field] !== manifest.qualityTarget?.[field]) {
      validationErrors.push(`target ${field} does not match the run manifest`);
    }
  }
  if (!strictDiscoveryBoundary(boundary)) {
    validationErrors.push("target discovery boundary is incomplete");
  }
  if (firstReach !== null) {
    if (censoring !== null) validationErrors.push("target ledger has both reach and censor records");
    if (
      !Number.isInteger(firstReach.generation) ||
      firstReach.generation < 1 ||
      firstReach.generation > generations
    ) validationErrors.push("target reach generation is outside the configured run");
    const reachedCandidate = Array.isArray(value.panel?.candidates)
      ? value.panel.candidates.find((candidate) => candidate?.candidateId === firstReach.candidateId)
      : null;
    if (
      reachedCandidate?.qualifies !== true ||
      reachedCandidate.firstEvaluatedGeneration !== firstReach.generation
    ) validationErrors.push("target reach does not reconcile to a qualifying panel candidate");
  } else if (
    censoring === null ||
    censoring.reason !== "generation_cap" ||
    censoring.generation !== generations
  ) {
    validationErrors.push("target non-reach lacks the configured generation-cap censor record");
  }
  if (
    value.panel?.audit?.valid !== true ||
    !Array.isArray(value.panel?.candidates) ||
    value.panel?.distinctCandidates !== value.panel.candidates.length
  ) validationErrors.push("target candidate-panel audit is missing or inconsistent");
  if (
    !Number.isInteger(value.measurement?.evaluations) ||
    value.measurement.evaluations < 0 ||
    finiteNumber(value.measurement?.elapsedMs) === null ||
    value.measurement?.includedInDiscoveryCost !== false
  ) validationErrors.push("target measurement accounting is incomplete");
  const structurallyValid = validationErrors.length === 0;
  return {
    ...projectedTarget,
    valid: value.valid === true && structurallyValid,
    reached: firstReach !== null,
    state: value.valid !== true || !structurallyValid
      ? "invalid"
      : firstReach === null ? "not_reached" : "reached",
    validationErrors,
    firstReachedGeneration: finiteNumber(firstReach?.generation),
    candidateId: firstReach?.candidateId ?? null,
    medianRatio: finiteNumber(firstReach?.medianRatio),
    passingRatios: finiteNumber(firstReach?.passingRatios),
    boundary: boundary && typeof boundary === "object" ? boundary : null,
    censoring,
    panelCandidates: finiteNumber(value.panel?.distinctCandidates) ?? 0,
    qualifyingCandidates: Array.isArray(value.panel?.candidates)
      ? value.panel.candidates.filter((candidate) => candidate?.qualifies === true).length
      : 0,
    measurementEvaluations: finiteNumber(value.measurement?.evaluations) ?? 0,
    measurementElapsedMs: finiteNumber(value.measurement?.elapsedMs) ?? 0,
    invalidBlockAttempts: finiteNumber(value.measurement?.invalidBlockAttempts) ?? 0,
  };
}

function strictDiscoveryBoundary(boundary) {
  if (boundary === null || typeof boundary !== "object" || Array.isArray(boundary)) return false;
  return [
    "responsesTokens",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "modelTurns",
    "providerRequests",
    "providerRetries",
    "ambiguousProviderAttempts",
    "toolExecutions",
    "publicChecks",
    "evaluations",
    "passedEvaluations",
    "creditsSpent",
    "elapsedMs",
  ].every((field) => finiteNumber(boundary[field]) !== null && boundary[field] >= 0);
}

function summarizeFixedQualityTrial(trial, config, attemptIntegrity) {
  const local = trial.conditions?.local ?? null;
  const isolated = trial.conditions?.isolated ?? null;
  const operationallyComplete = local?.status === "passed" && isolated?.status === "passed";
  const controlChecks = operationallyComplete
    ? [
        ...equalBudgetChecks(local, isolated),
        ...equalFields(local?.target, isolated?.target, [
          "protocol",
          "multiplier",
          "rechecksPerCandidate",
          "requiredPassingRatios",
          "requiredCorrectnessPasses",
          "blockSize",
          "maximumBaselineDriftRatio",
        ], "target."),
      ]
    : [];
  const targetValid = local?.target?.valid === true && isolated?.target?.valid === true;
  const valid = operationallyComplete && targetValid &&
    hasCompleteCostBoundary(local.target) && hasCompleteCostBoundary(isolated.target) &&
    attemptIntegrity.validForPair;
  const localReached = local?.target?.reached === true;
  const isolatedReached = isolated?.target?.reached === true;
  const outcome = !valid
    ? "invalid"
    : localReached && isolatedReached
      ? "both_reached"
      : localReached
        ? "local_only"
        : isolatedReached
          ? "isolated_only"
          : "neither_reached";
  const costComparable = outcome === "both_reached";
  const metrics = [
    "responsesTokens",
    "modelTurns",
    "toolExecutions",
    "publicChecks",
    "evaluations",
    "creditsSpent",
    "elapsedMs",
  ];
  const deltas = Object.fromEntries(metrics.map((metric) => [
    metric,
    costComparable
      ? fixedOrNull(relativeDifference(local.target.boundary?.[metric], isolated.target.boundary?.[metric]), 8)
      : null,
  ]));
  let primaryOutcome = "tie";
  let primaryReason = outcome === "neither_reached" ? "neither_reached" : "within_cost_band";
  let censoringComparison = null;
  if (outcome === "local_only" || outcome === "isolated_only") {
    const winner = outcome === "local_only" ? "local" : "isolated";
    const reachedCost = finiteNumber((winner === "local" ? local : isolated).target.boundary?.responsesTokens);
    const otherCensorBoundary = finiteNumber((winner === "local" ? isolated : local).target.boundary?.responsesTokens);
    const winnerVsCensorPct = relativeDifference(reachedCost, otherCensorBoundary);
    const clearsMeaningfulBand = winnerVsCensorPct !== null &&
      winnerVsCensorPct <= -config.meaningfulCostDeltaPct;
    censoringComparison = {
      winner,
      reachedCost,
      otherCensorBoundary,
      winnerVsCensorPct: fixedOrNull(winnerVsCensorPct, 8),
      clearsMeaningfulBand,
    };
    if (clearsMeaningfulBand) {
      primaryOutcome = winner;
      primaryReason = "censor_boundary_dominance";
    } else {
      primaryReason = "censored_cost_indeterminate";
    }
  } else if (costComparable && deltas.responsesTokens !== null) {
    if (deltas.responsesTokens <= -config.meaningfulCostDeltaPct) primaryOutcome = "local";
    else if (deltas.responsesTokens >= config.meaningfulCostDeltaPct) primaryOutcome = "isolated";
    if (primaryOutcome !== "tie") primaryReason = "both_reached_cost";
  } else if (outcome === "invalid") {
    primaryReason = attemptIntegrity.validForPair
      ? "invalid_evidence"
      : "attempt_integrity_failure";
  }
  return {
    ...trial,
    complete: operationallyComplete,
    valid,
    controlChecks,
    attemptIntegrity,
    fixedQuality: {
      outcome,
      costComparable,
      primaryOutcome,
      primaryReason,
      censoringComparison,
      localVsIsolatedPct: deltas,
    },
  };
}

function trialAttemptIntegrity(trial, attempts) {
  const trialAttempts = attempts.filter((attempt) =>
    String(attempt?.trial) === String(trial?.trial)
  );
  const reasons = [];
  for (const attempt of trialAttempts) {
    const audit = attempt?.integrityAudit;
    if (audit === null || typeof audit !== "object" || Array.isArray(audit)) continue;
    const auditReasons = Array.isArray(audit.reasons) ? audit.reasons : [];
    for (const reason of auditReasons) {
      if (reason === null || typeof reason !== "object" || Array.isArray(reason)) continue;
      reasons.push({
        ...reason,
        trial: trial.trial,
        condition: attempt.condition ?? null,
        attempt: finiteNumber(attempt.attempt),
        runId: attempt.runId ?? null,
      });
    }
    if (audit.validForPair === false && auditReasons.length === 0) {
      reasons.push({
        trial: trial.trial,
        condition: attempt.condition ?? null,
        attempt: finiteNumber(attempt.attempt),
        runId: attempt.runId ?? null,
        code: "attempt_integrity_invalid",
        detail: "The retained attempt integrity audit marked this attempt invalid without a structured reason.",
      });
    }
    if (
      audit.assessed !== true &&
      !auditReasons.some((reason) => reason?.code === "unassessed_attempt_integrity")
    ) {
      reasons.push({
        trial: trial.trial,
        condition: attempt.condition ?? null,
        attempt: finiteNumber(attempt.attempt),
        runId: attempt.runId ?? null,
        code: "unassessed_attempt_integrity",
        detail: "The retained attempt integrity audit has no authoritative run evidence.",
      });
    }
  }

  for (const condition of CONDITIONS) {
    const selected = trial.conditions?.[condition];
    const count = finiteNumber(selected?.ambiguousProviderAttempts);
    if (count === null || count <= 0) continue;
    const selectedAttempt = trialAttempts.find((attempt) => attempt?.runId === selected?.runId) ?? null;
    const alreadyRecorded = reasons.some((reason) =>
      reason.code === "ambiguous_provider_attempt" &&
      (selected?.runId === null || selected?.runId === undefined || reason.runId === selected.runId)
    );
    if (!alreadyRecorded) {
      reasons.push({
        trial: trial.trial,
        condition,
        attempt: finiteNumber(selectedAttempt?.attempt),
        runId: selected?.runId ?? null,
        code: "ambiguous_provider_attempt",
        detail: `${count} ambiguous provider attempt${count === 1 ? "" : "s"} may have unrecorded token usage.`,
        ambiguousProviderAttempts: count,
        sources: [{ source: "selected_run_projection", count }],
      });
    }
  }

  const auditedAttempts = trialAttempts.filter((attempt) =>
    attempt?.integrityAudit !== null &&
    typeof attempt?.integrityAudit === "object" &&
    !Array.isArray(attempt.integrityAudit)
  );
  const auditEnforced = auditedAttempts.length > 0;
  if (auditEnforced && auditedAttempts.length !== trialAttempts.length) {
    for (const attempt of trialAttempts.filter((entry) => !auditedAttempts.includes(entry))) {
      reasons.push({
        trial: trial.trial,
        condition: attempt?.condition ?? null,
        attempt: finiteNumber(attempt?.attempt),
        runId: attempt?.runId ?? null,
        code: "missing_attempt_integrity_audit",
        detail: "A retained attempt is missing its integrity audit while audit enforcement is active for this pair.",
      });
    }
  }
  const uniqueReasons = deduplicateIntegrityReasons(reasons);
  return {
    protocol: "protein-comparison-pair-integrity/v1",
    attempts: trialAttempts.length,
    auditedAttempts: auditedAttempts.length,
    assessedAttempts: auditedAttempts.filter((attempt) => attempt.integrityAudit.assessed === true).length,
    auditEnforced,
    allAttemptsAudited: auditedAttempts.length === trialAttempts.length,
    validForPair: uniqueReasons.length === 0,
    reasons: uniqueReasons,
  };
}

function aggregateAttemptIntegrity(trials) {
  const reasons = trials.flatMap((trial) => trial.attemptIntegrity?.reasons ?? []);
  const reasonCounts = countBy(reasons, (reason) => reason.code ?? "unknown");
  const invalidAttemptKeys = new Set(reasons.map((reason) =>
    `${reason.trial}:${reason.condition ?? "unknown"}:${reason.attempt ?? "unknown"}:${reason.runId ?? "unknown"}`
  ));
  const auditEnforced = trials.some((trial) => trial.attemptIntegrity?.auditEnforced === true);
  const allAttemptsAudited = trials.every((trial) => trial.attemptIntegrity?.allAttemptsAudited === true);
  return {
    protocol: "protein-comparison-attempt-integrity/v1",
    attempts: sum(trials.map((trial) => trial.attemptIntegrity?.attempts ?? 0)),
    auditedAttempts: sum(trials.map((trial) => trial.attemptIntegrity?.auditedAttempts ?? 0)),
    assessedAttempts: sum(trials.map((trial) => trial.attemptIntegrity?.assessedAttempts ?? 0)),
    auditEnforced,
    allAttemptsAudited,
    invalidPairs: trials.filter((trial) => trial.attemptIntegrity?.validForPair === false).length,
    invalidAttempts: invalidAttemptKeys.size,
    validForClaim: reasons.length === 0 && (!auditEnforced || allAttemptsAudited),
    reasonCounts,
    reasons,
  };
}

function deduplicateIntegrityReasons(reasons) {
  const seen = new Set();
  return reasons.filter((reason) => {
    const key = [reason.trial, reason.condition, reason.attempt, reason.runId, reason.code].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function integrityIdentityCheck(field, actual, expected) {
  if (actual === null || actual === undefined || expected === null || expected === undefined) return null;
  return {
    field,
    expected,
    actual,
    equal: String(actual) === String(expected),
  };
}

function exhaustedTargetBlockRetries(qualityTarget) {
  if (!Array.isArray(qualityTarget?.blockAttempts)) return [];
  const invalidByBlock = new Map();
  for (const entry of qualityTarget.blockAttempts) {
    if (entry?.baselineValid !== false) continue;
    const repeat = finiteNumber(entry.repeat);
    const block = finiteNumber(entry.block);
    const attempt = finiteNumber(entry.attempt);
    if (!Number.isInteger(repeat) || !Number.isInteger(block) || !Number.isInteger(attempt)) continue;
    const key = `${repeat}:${block}`;
    const attempts = invalidByBlock.get(key) ?? [];
    attempts.push({ attempt, baselineDriftRatio: finiteNumber(entry.baselineDriftRatio) });
    invalidByBlock.set(key, attempts);
  }
  return [...invalidByBlock.entries()].flatMap(([key, values]) => {
    const failedAttempts = [...new Set(values.map((entry) => entry.attempt))].sort((left, right) => left - right);
    if (failedAttempts.length < 2) return [];
    const [repeat, block] = key.split(":").map(Number);
    return [{
      repeat,
      block,
      failedAttempts,
      baselineDriftRatios: values
        .sort((left, right) => left.attempt - right.attempt)
        .map((entry) => entry.baselineDriftRatio),
    }];
  }).sort((left, right) => left.repeat - right.repeat || left.block - right.block);
}

function hasCompleteCostBoundary(target) {
  const boundary = target?.boundary;
  if (boundary === null || typeof boundary !== "object" || Array.isArray(boundary)) return false;
  return [
    "responsesTokens",
    "modelTurns",
    "toolExecutions",
    "publicChecks",
    "evaluations",
    "creditsSpent",
    "elapsedMs",
  ].every((field) => finiteNumber(boundary[field]) !== null && boundary[field] >= 0);
}

function equalFields(local, isolated, fields, prefix = "") {
  return fields.map((field) => {
    const localValue = local?.[field];
    const isolatedValue = isolated?.[field];
    return {
      field: `${prefix}${field}`,
      local: localValue,
      isolated: isolatedValue,
      equal: localValue !== null && localValue !== undefined &&
        isolatedValue !== null && isolatedValue !== undefined &&
        localValue === isolatedValue,
    };
  });
}

function costDistribution(values, bootstrapSamples = 10_000, bootstrapSeed = "protein-cost-target-v1") {
  const numbers = values.map(finiteNumber).filter((value) => value !== null);
  const base = distribution(numbers);
  const interval = numbers.length === 0
    ? null
    : bootstrapMedianInterval(numbers, bootstrapSamples, bootstrapSeed);
  return {
    ...base,
    directionCounts: {
      localLower: numbers.filter((value) => value < 0).length,
      isolatedLower: numbers.filter((value) => value > 0).length,
      equal: numbers.filter((value) => value === 0).length,
    },
    interval95: interval,
  };
}

function bootstrapMedianInterval(values, sampleCount, seedText) {
  const samples = Math.max(1, Math.floor(finiteNumber(sampleCount) ?? 10_000));
  let state = hashSeed(seedText);
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
  const medians = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const drawn = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]);
    medians.push(median(drawn));
  }
  medians.sort((left, right) => left - right);
  return {
    lower: fixedOrNull(percentileValue(medians, 0.025), 8),
    upper: fixedOrNull(percentileValue(medians, 0.975), 8),
    method: "paired_percentile_bootstrap_median",
    samples,
    seed: seedText,
  };
}

function hashSeed(value) {
  let hash = 2_166_136_261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash === 0 ? 1 : hash >>> 0;
}

function percentileValue(ordered, ratio) {
  if (ordered.length === 0) return null;
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.floor((ordered.length - 1) * ratio)))];
}

function binomialUpperTail(successes, trials) {
  let probability = 0;
  for (let success = successes; success <= trials; success += 1) {
    probability += combination(trials, success) * (0.5 ** trials);
  }
  return probability;
}

function combination(total, selected) {
  const smaller = Math.min(selected, total - selected);
  let value = 1;
  for (let index = 1; index <= smaller; index += 1) {
    value = (value * (total - smaller + index)) / index;
  }
  return value;
}

function fixedQualityConclusion({
  configuredPairs,
  validPairs,
  allPairsValid,
  equalBudgetVerified,
  globalControlsVerified,
  comparablePairs,
  minimumComparablePairs,
  localReached,
  isolatedReached,
  localWins,
  isolatedWins,
  localExactP,
  isolatedExactP,
  alpha,
  meaningfulCostDeltaPct,
  tokenDistribution,
  noAmbiguousUsage,
  attemptIntegrity,
}) {
  if (!noAmbiguousUsage) {
    return {
      code: "ambiguous_usage",
      headline: "The token-cost endpoint contains ambiguous provider usage.",
      detail: "A retained provider attempt may have consumed unrecorded tokens, so the affected pair and aggregate token-cost claim are invalid.",
    };
  }
  if (!allPairsValid || validPairs !== configuredPairs) {
    return {
      code: "incomplete",
      headline: "The fixed-quality comparison is incomplete.",
      detail: attemptIntegrity?.invalidPairs > 0
        ? `${attemptIntegrity.invalidPairs} planned pair${attemptIntegrity.invalidPairs === 1 ? "" : "s"} failed retained-attempt integrity; see the surfaced audit reasons.`
        : "At least one planned pair lacked valid operational or target-recheck evidence.",
    };
  }
  if (!equalBudgetVerified || !globalControlsVerified) {
    return {
      code: "invalid_control",
      headline: "The fixed-quality comparison failed its matched controls.",
      detail: "At least one required runtime, protocol, target, or configured-cap field was missing, unequal within a pair, or changed across the planned runs.",
    };
  }
  if (comparablePairs < minimumComparablePairs) {
    return {
      code: "insufficient_comparable_pairs",
      headline: "Too few pairs reached the quality target in both conditions.",
      detail: `${comparablePairs}/${configuredPairs} pairs support a paired cost-to-target calculation; censored pairs were not imputed.`,
    };
  }
  const medianTokens = tokenDistribution.median;
  const interval = tokenDistribution.interval95;
  const localSupported = localReached >= isolatedReached &&
    localWins > isolatedWins &&
    localExactP < alpha &&
    medianTokens !== null && medianTokens <= -meaningfulCostDeltaPct &&
    interval?.upper < 0;
  if (localSupported) {
    return {
      code: "lower_cost_supported",
      headline: "Local exchange reached the fixed quality target with lower recorded token cost.",
      detail: `Median paired Responses-token cost was ${fixedOrNull(Math.abs(medianTokens), 2)}% lower across ${comparablePairs} cost-comparable pairs; the one-sided sign-test p-value was ${fixedOrNull(localExactP, 6)}.`,
    };
  }
  const isolatedSupported = isolatedReached >= localReached &&
    isolatedWins > localWins &&
    isolatedExactP < alpha &&
    medianTokens !== null && medianTokens >= meaningfulCostDeltaPct &&
    interval?.lower > 0;
  if (isolatedSupported) {
    return {
      code: "higher_cost_supported",
      headline: "Local exchange required more recorded token cost at the fixed quality target.",
      detail: `Median paired Responses-token cost was ${fixedOrNull(medianTokens, 2)}% higher across ${comparablePairs} cost-comparable pairs; the isolated-direction one-sided sign-test p-value was ${fixedOrNull(isolatedExactP, 6)}.`,
    };
  }
  return {
    code: "inconclusive",
    headline: "The fixed-quality cost result is inconclusive.",
    detail: `The paired token result did not jointly clear the preregistered ${meaningfulCostDeltaPct}% cost band, exact sign test, and bootstrap direction checks.`,
  };
}

function qualityAggregate(trials) {
  const local = trials.map((trial) => trial.conditions.local);
  const isolated = trials.map((trial) => trial.conditions.isolated);
  return {
    local: aggregateCondition(local),
    isolated: aggregateCondition(isolated),
    pairedSeedRelativeGainPct: distribution(trials.map((trial) => {
      const left = finiteNumber(trial.conditions.local?.gainPct);
      const right = finiteNumber(trial.conditions.isolated?.gainPct);
      return left === null || right === null ? null : left - right;
    })),
    interpretation: "Exploratory only; the preregistered primary endpoint is recorded Responses tokens to the retrospectively verified target.",
  };
}

function percentage(numerator, denominator) {
  return denominator === 0 ? null : fixedOrNull((numerator / denominator) * 100, 3);
}

function pairedEfficiency(trials) {
  const metrics = [
    "tokens",
    "modelTurns",
    "toolExecutions",
    "evaluations",
    "creditsSpent",
    "elapsedMs",
    "fallbacks",
  ];
  return {
    interpretation: "Negative percentages mean local used less than its matched isolated run.",
    localVsIsolatedPct: Object.fromEntries(metrics.map((metric) => [
      metric,
      distribution(trials.map((trial) => relativeDifference(
        trial.conditions.local?.[metric],
        trial.conditions.isolated?.[metric],
      ))),
    ])),
  };
}

function relativeDifference(localValue, isolatedValue) {
  const local = finiteNumber(localValue);
  const isolated = finiteNumber(isolatedValue);
  if (local === null || isolated === null || isolated === 0) return null;
  return ((local - isolated) / isolated) * 100;
}

function summarizeTrial(trial, threshold) {
  const local = trial.conditions?.local ?? null;
  const isolated = trial.conditions?.isolated ?? null;
  const complete = local?.status === "passed" && isolated?.status === "passed";
  const localGain = finiteNumber(local?.gainPct);
  const isolatedGain = finiteNumber(isolated?.gainPct);
  const percentPoints = localGain === null || isolatedGain === null ? null : localGain - isolatedGain;
  const outcome = percentPoints === null || Math.abs(percentPoints) < threshold
    ? "tie"
    : percentPoints > 0 ? "local" : "isolated";
  const budgetChecks = complete ? equalBudgetChecks(local, isolated) : [];
  return {
    ...trial,
    complete,
    uplift: {
      absolute: finiteNumber(local?.gain) === null || finiteNumber(isolated?.gain) === null
        ? null
        : local.gain - isolated.gain,
      percentPoints: fixedOrNull(percentPoints, 6),
    },
    outcome,
    budgetChecks,
  };
}

function equalBudgetChecks(local, isolated) {
  return RUN_CONTROL_FIELDS.map((field) => {
    const localValue = local[field];
    const isolatedValue = isolated[field];
    return {
      field,
      local: localValue,
      isolated: isolatedValue,
      equal: localValue !== null && localValue !== undefined &&
        isolatedValue !== null && isolatedValue !== undefined &&
        localValue === isolatedValue,
    };
  });
}

export function comparisonControlFingerprint(run) {
  return Object.fromEntries([
    ...RUN_CONTROL_FIELDS.map((field) => [field, run?.[field] ?? null]),
    ...TARGET_CONTROL_FIELDS.map((field) => [`target.${field}`, run?.target?.[field] ?? null]),
  ]);
}

function globalControlAudit(trials, config) {
  const runs = trials.flatMap((trial) => CONDITIONS.map((condition) => trial.conditions?.[condition] ?? null));
  const fingerprints = runs.map(comparisonControlFingerprint);
  const reference = fingerprints[0] ?? null;
  const expectedRuns = config.trials * CONDITIONS.length;
  const fields = [...RUN_CONTROL_FIELDS, ...TARGET_CONTROL_FIELDS.map((field) => `target.${field}`)];
  const checks = fields.map((field) => {
    const values = fingerprints.map((fingerprint) => fingerprint[field]);
    const configured = configuredControlValue(field, config);
    const expected = configured.defined ? configured.value : reference?.[field] ?? null;
    return {
      field,
      expected,
      expectedSource: configured.defined ? "comparison_config" : "first_run_fingerprint",
      values,
      equal: runs.length === expectedRuns && expected !== null && expected !== undefined &&
        values.length === expectedRuns && values.every((value) => value === expected),
    };
  });
  return {
    protocol: "protein-comparison-control-fingerprint/v1",
    expectedRuns,
    observedRuns: runs.filter((run) => run !== null).length,
    reference,
    verified: checks.length > 0 && checks.every((check) => check.equal),
    checks,
  };
}

function configuredControlValue(field, config) {
  const configured = {
    responsesProtocol: config.responsesProtocol,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    promptVersion: config.promptVersion,
    toolSchemaVersion: config.toolSchemaVersion,
    toolSchemaSha256: config.toolSchemaSha256,
    modelMaxOutputTokens: config.modelMaxOutputTokens,
    providerStore: false,
    benchmarkId: config.benchmarkId,
    evaluatorVersion: config.evaluatorVersion,
    publicBenchmarkConcurrency: config.publicBenchmarkConcurrency,
    hiddenBenchmarkConcurrency: config.hiddenBenchmarkConcurrency,
    rows: config.rows,
    columns: config.columns,
    generations: config.generations,
    totalCredits: config.rows * config.columns * config.creditsPerCell,
    maxModelTurns: config.maxModelTurns,
    maxToolCalls: config.maxToolCalls,
    dispatchConcurrency: config.dispatchConcurrency,
    providerTimeoutMs: config.providerTimeoutMs,
    providerMaximumAttempts: config.providerMaximumAttempts,
    "target.protocol": config.qualityTargetProtocol,
    "target.multiplier": config.qualityTargetMultiplier,
    "target.rechecksPerCandidate": config.qualityTargetRechecks,
    "target.requiredPassingRatios": config.qualityTargetRequiredRatios,
    "target.requiredCorrectnessPasses": config.qualityTargetRechecks,
    "target.blockSize": config.qualityTargetBlockSize,
    "target.maximumBaselineDriftRatio": config.qualityTargetMaximumBaselineDrift,
  };
  return Object.hasOwn(configured, field) && configured[field] !== undefined
    ? { defined: true, value: configured[field] }
    : { defined: false, value: null };
}

function aggregateCondition(runs) {
  return {
    runs: runs.length,
    gainPct: distribution(runs.map((run) => run.gainPct)),
    bestScore: distribution(runs.map((run) => run.bestScore)),
    tokens: distribution(runs.map((run) => run.tokens)),
    elapsedMs: distribution(runs.map((run) => run.elapsedMs)),
    modelTurns: sum(runs.map((run) => run.modelTurns)),
    toolExecutions: sum(runs.map((run) => run.toolExecutions)),
    evaluations: sum(runs.map((run) => run.evaluations)),
    fallbacks: sum(runs.map((run) => run.fallbacks)),
    creditsSpent: sum(runs.map((run) => run.creditsSpent)),
    neighborDerivedImprovements: sum(runs.map((run) => run.lineage?.neighborDerivedImprovements ?? 0)),
  };
}

function comparisonConclusion({
  allRunsPassed,
  equalBudgetVerified,
  completedPairs,
  configuredPairs,
  localWins,
  isolatedWins,
  pairedMedian,
  threshold,
}) {
  if (!allRunsPassed || completedPairs !== configuredPairs) {
    return {
      code: "incomplete",
      headline: "The comparison is incomplete.",
      detail: "At least one preregistered condition did not produce a passing evidence bundle.",
    };
  }
  if (!equalBudgetVerified) {
    return {
      code: "invalid_control",
      headline: "The comparison failed its equal-budget control.",
      detail: "Local and isolated runs did not share every frozen model, benchmark, topology-size, and budget field.",
    };
  }
  if (localWins >= 2 && pairedMedian !== null && pairedMedian >= threshold) {
    return {
      code: "observed_local_advantage",
      headline: "Neighbor exchange helped in this exploratory comparison.",
      detail: `Local won ${localWins}/${completedPairs} pairs and its median seed-relative uplift exceeded isolated by ${fixedOrNull(pairedMedian, 3)} percentage points.`,
    };
  }
  if (isolatedWins >= 2 && pairedMedian !== null && pairedMedian <= -threshold) {
    return {
      code: "observed_isolated_advantage",
      headline: "Neighbor exchange hurt in this exploratory comparison.",
      detail: `Isolated won ${isolatedWins}/${completedPairs} pairs and its median seed-relative uplift exceeded local by ${fixedOrNull(Math.abs(pairedMedian), 3)} percentage points.`,
    };
  }
  return {
    code: "inconclusive",
    headline: "No repeatable neighbor-exchange advantage was observed.",
    detail: `The paired effect did not clear the preregistered ${threshold}% threshold in a consistent direction.`,
  };
}

function lineageMetrics(serviceSnapshots, finalGeneration) {
  const board = serviceSnapshots?.board;
  const evaluator = serviceSnapshots?.evaluator;
  const submissions = Object.values(board?.submissions ?? {})
    .map((record) => record?.result)
    .filter((record) => record && typeof record === "object");
  const evidence = Object.values(evaluator?.evidence ?? {})
    .filter((record) =>
      record &&
      typeof record === "object" &&
      !(typeof record.purpose === "string" && record.purpose.startsWith("quality_target_"))
    );
  const parentsByCandidate = new Map();
  for (const record of evidence) {
    const candidateId = record.candidateId;
    if (typeof candidateId !== "string") continue;
    parentsByCandidate.set(candidateId, Array.isArray(record.parentCandidateIds) ? record.parentCandidateIds : []);
  }
  const behaviors = countBy(submissions, (record) => record.behavior ?? "unknown");
  const priorCandidates = new Map();
  const candidateOwners = new Map();
  for (const record of submissions) {
    if (typeof record.agent !== "string" || !Number.isInteger(record.generation)) continue;
    priorCandidates.set(`${record.agent}:${record.generation}`, record.candidateId);
    const ownerKey = `${record.generation}:${record.candidateId}`;
    const owners = candidateOwners.get(ownerKey) ?? new Set();
    owners.add(record.agent);
    candidateOwners.set(ownerKey, owners);
  }
  const finalCandidates = new Set(
    submissions
      .filter((record) => record.generation === finalGeneration)
      .map((record) => record.candidateId)
      .filter((value) => typeof value === "string"),
  );
  let neighborDerivedImprovements = 0;
  for (const record of evidence) {
    const parents = Array.isArray(record.parentCandidateIds) ? record.parentCandidateIds : [];
    const agent = typeof record.agent === "string" ? record.agent : null;
    const ownPrevious = agent === null ? null : priorCandidates.get(`${agent}:${record.generation - 1}`);
    if (
      record.generation > 1 &&
      agent !== null &&
      parents.some((parent) => {
        if (parent === ownPrevious) return false;
        const owners = candidateOwners.get(`${record.generation - 1}:${parent}`);
        return owners !== undefined && [...owners].some((owner) => owner !== agent);
      })
    ) {
      neighborDerivedImprovements += 1;
    }
  }
  const depths = [...parentsByCandidate.keys()].map((candidateId) => lineageDepth(candidateId, parentsByCandidate));
  return {
    uniqueSubmittedCandidates: new Set(submissions.map((record) => record.candidateId)).size,
    finalDiversity: finalCandidates.size,
    adoptions: behaviors.adopt ?? 0,
    improvements: behaviors.improve ?? 0,
    challenges: behaviors.challenge ?? 0,
    waits: behaviors.wait ?? 0,
    neighborDerivedImprovements,
    maxDepth: depths.length === 0 ? 0 : Math.max(...depths),
    duplicateEvaluations: Math.max(0, evidence.length - new Set(evidence.map((record) => record.candidateId)).size),
  };
}

function lineageDepth(candidateId, parentsByCandidate, visiting = new Set()) {
  if (visiting.has(candidateId)) return 0;
  const parents = parentsByCandidate.get(candidateId) ?? [];
  if (parents.length === 0) return 0;
  const next = new Set(visiting);
  next.add(candidateId);
  return 1 + Math.max(0, ...parents.map((parent) => lineageDepth(parent, parentsByCandidate, next)));
}

function distribution(values) {
  const numbers = values.map(finiteNumber).filter((value) => value !== null);
  return {
    values: numbers,
    median: fixedOrNull(median(numbers), 6),
    minimum: fixedOrNull(numbers.length === 0 ? null : Math.min(...numbers), 6),
    maximum: fixedOrNull(numbers.length === 0 ? null : Math.max(...numbers), 6),
  };
}

function median(values) {
  const numbers = values.map(finiteNumber).filter((value) => value !== null).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 0 ? (numbers[middle - 1] + numbers[middle]) / 2 : numbers[middle];
}

function sum(values) {
  return values.map(finiteNumber).filter((value) => value !== null).reduce((total, value) => total + value, 0);
}

function countBy(values, key) {
  const result = {};
  for (const value of values) {
    const name = String(key(value));
    result[name] = (result[name] ?? 0) + 1;
  }
  return result;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fixedOrNull(value, digits) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

export { CONDITIONS };
