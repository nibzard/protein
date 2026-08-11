const CONDITIONS = ["local", "isolated"];

export function comparisonView(payload, latestSummary = null) {
  const summary = object(payload?.summary);
  if (summary === null || summary.evidenceLevel !== "celld-comparison") {
    return unavailableComparison(latestSummary);
  }

  if (summary.config?.objective === "cost_to_fixed_verified_quality") {
    return fixedQualityComparisonView(payload, summary);
  }

  const trials = array(summary.trials).map(trialView).filter(Boolean);
  const aggregate = object(summary.aggregate) ?? {};
  const configuredTrials = finite(summary.config?.trials, trials.length);
  const pairs = finite(aggregate.pairs, trials.length);
  const passedPairs = finite(aggregate.passedPairs, trials.filter((trial) => trial.complete).length);
  const upliftRecord = object(aggregate.pairedUpliftPct);
  const uplift = nullableFinite(upliftRecord?.median ?? aggregate.pairedUpliftPct);
  const threshold = Math.max(0, finite(summary.config?.meaningfulThresholdPct, 0));
  const complete = summary.status === "passed"
    && pairs > 0
    && passedPairs === pairs
    && trials.length >= configuredTrials
    && aggregate.equalBudgetVerified !== false;
  const conclusion = object(aggregate.conclusion);
  const verdict = comparisonVerdict({ complete, uplift, threshold, conclusion: conclusion?.code });
  const recordedClaim = [string(conclusion?.headline, null), string(conclusion?.detail, null)].filter(Boolean).join(" ");
  const efficiency = efficiencyObservation(aggregate.efficiency);
  const totals = Object.fromEntries(CONDITIONS.map((condition) => [condition, totalCondition(trials, condition)]));
  const curves = Object.fromEntries(CONDITIONS.map((condition) => [condition, conditionCurve(trials, condition)]));
  const lineageRuns = array(payload?.lineage?.runs).map(lineageRunView).filter(Boolean);
  const lineageSummaries = trials.flatMap((trial) => CONDITIONS.flatMap((condition) => {
    const run = trial.conditions[condition];
    return run === null ? [] : [{ trial: trial.trial, condition, runId: run.runId, ...run.lineage }];
  }));

  return {
    available: true,
    mode: "quality",
    question: "Did neighbor exchange help?",
    observationLabel: "Secondary / descriptive",
    detailTitle: "Trial variation and spend",
    chartTitle: "Best verified score by generation",
    spendTitle: "Accounted spend",
    spendMeta: "all displayed trials",
    comparisonId: string(summary.comparisonId, "unidentified comparison"),
    status: string(summary.status, "unknown"),
    completedAt: summary.completedAt ?? null,
    complete,
    verdict: {
      ...verdict,
      claim: [recordedClaim || verdict.explanation, verdict.qualifier].filter(Boolean).join(" "),
      boundary: string(summary.claimBoundary, "Interpret this result only within the recorded paired configuration."),
    },
    efficiency,
    headlineFacts: [
      { label: "Matched pairs", value: `${passedPairs} / ${pairs}`, detail: `${configuredTrials} configured` },
      { label: "Median paired effect", value: uplift === null ? "—" : signedPercent(uplift), detail: upliftRangeDetail(upliftRecord, threshold) },
      { label: "Pair outcomes", value: `${finite(aggregate.localWins)}–${finite(aggregate.isolatedWins)}–${finite(aggregate.ties)}`, detail: "local · isolated · tie" },
      { label: "Budget control", value: aggregate.equalBudgetVerified === true ? "EQUAL CAPS" : "NOT VERIFIED", detail: `${string(summary.config?.model, "unrecorded")} · ${string(summary.config?.reasoningEffort, "unrecorded")} reasoning` },
    ],
    config: configView(summary.config),
    trials,
    totals,
    curves,
    lineageRuns,
    lineageSummaries,
    lineageErrors: array(payload?.lineage?.collectionErrors),
    variation: Object.fromEntries(CONDITIONS.map((condition) => [condition, scoreVariation(trials, condition)])),
  };
}

function fixedQualityComparisonView(payload, summary) {
  const trials = array(summary.trials).map(fixedQualityTrialView).filter(Boolean);
  const aggregate = object(summary.aggregate) ?? {};
  const fixedQuality = object(aggregate.fixedQuality) ?? {};
  const config = object(summary.config) ?? {};
  const configuredPairs = finite(config.trials, trials.length);
  const validPairs = finite(aggregate.validPairs, trials.filter((trial) => trial.valid).length);
  const integrity = fixedQualityIntegrity(
    fixedQuality.attemptIntegrity ?? aggregate.attemptIntegrity,
    trials,
    configuredPairs,
    validPairs,
  );
  const equalBudgetVerified = aggregate.equalBudgetVerified === true;
  const globalControlsVerified = aggregate.globalControlsVerified === true;
  const complete = summary.status === "passed"
    && configuredPairs > 0
    && validPairs === configuredPairs
    && trials.length >= configuredPairs
    && equalBudgetVerified
    && globalControlsVerified;
  const conclusion = object(fixedQuality.conclusion);
  const verdict = fixedQualityVerdict({ complete, code: conclusion?.code, integrity });
  const recordedClaim = [string(conclusion?.headline, null), string(conclusion?.detail, null)].filter(Boolean).join(" ");
  const attainment = fixedQualityAttainment(fixedQuality.attainment, configuredPairs);
  const resources = fixedQualityResources(fixedQuality.localVsIsolatedPct);
  const tokenDistribution = resources.find((resource) => resource.key === "responsesTokens")?.distribution ?? emptyCostDistribution();
  const signTests = fixedQualitySignTests(
    fixedQuality.exactOneSidedSignTests ?? fixedQuality.exactOneSidedSignTest,
    fixedQuality,
  );
  const signTest = {
    nonTiedPairs: signTests.local.nonTiedPairs,
    localWins: signTests.local.wins,
    pValue: signTests.local.pValue,
    alpha: signTests.local.alpha,
  };
  const target = fixedQualityTarget(config, trials);
  const comparablePairs = finite(fixedQuality.comparablePairs);
  const lineageRuns = array(payload?.lineage?.runs).map(lineageRunView).filter(Boolean);
  const lineageSummaries = trials.flatMap((trial) => CONDITIONS.flatMap((condition) => {
    const run = trial.conditions[condition];
    return run === null ? [] : [{ trial: trial.trial, condition, runId: run.runId, ...run.lineage }];
  }));

  return {
    available: true,
    mode: "fixed-quality",
    question: "Did local exchange reach verified quality with less compute?",
    observationLabel: "Attainment / censoring",
    detailTitle: "Target attainment and paired cost",
    chartTitle: "Paired Responses-token cost at target",
    spendTitle: "Median paired resource delta",
    spendMeta: complete ? "both-reached pairs only" : "valid both-reached pairs · descriptive only",
    comparisonId: string(summary.comparisonId, "unidentified comparison"),
    status: string(summary.status, "unknown"),
    completedAt: summary.completedAt ?? null,
    complete,
    verdict: {
      ...verdict,
      claim: [recordedClaim || verdict.explanation, verdict.qualifier].filter(Boolean).join(" "),
      boundary: target.definition,
    },
    efficiency: {
      available: true,
      text: fixedQualityCensoringCopy(attainment, integrity),
    },
    headlineFacts: fixedQualityHeadlineFacts({
      attainment,
      comparablePairs,
      configuredPairs,
      tokenDistribution,
      signTests,
      integrity,
      globalControlsVerified,
    }),
    config: fixedQualityConfigView(config, target),
    trials,
    totals: Object.fromEntries(CONDITIONS.map((condition) => [condition, totalCondition(trials, condition)])),
    curves: Object.fromEntries(CONDITIONS.map((condition) => [condition, conditionCurve(trials, condition)])),
    lineageRuns,
    lineageSummaries,
    lineageErrors: array(payload?.lineage?.collectionErrors),
    variation: Object.fromEntries(CONDITIONS.map((condition) => [condition, scoreVariation(trials, condition)])),
    fixedQuality: {
      target,
      attainment,
      comparablePairs,
      configuredPairs,
      resources,
      tokenDistribution,
      signTest,
      signTests,
      integrity,
      noAmbiguousUsage: fixedQuality.noAmbiguousUsage === true,
      globalControlsVerified,
    },
  };
}

function fixedQualityVerdict({ complete, code, integrity }) {
  if (!complete || code === "incomplete" || code === "invalid_control") {
    const integrityIncomplete = integrity.invalidPairs > 0;
    return {
      tone: "pending",
      label: code === "invalid_control"
        ? "MATCHED CONTROLS INVALID"
        : integrityIncomplete ? "CONFIRMATORY EVIDENCE INCOMPLETE" : "FIXED-QUALITY EVIDENCE INCOMPLETE",
      answer: integrityIncomplete ? "No confirmatory conclusion." : "Not answered yet.",
      explanation: integrityIncomplete
        ? `${number(integrity.invalidPairs)} of ${number(integrity.configuredPairs)} planned pair${integrity.configuredPairs === 1 ? "" : "s"} failed the all-attempt integrity audit.`
        : "At least one configured pair or frozen control is missing or invalid, so no cost-to-target conclusion is reported.",
      qualifier: integrityIncomplete
        ? `Descriptive results from ${number(integrity.validPairs)} valid pair${integrity.validPairs === 1 ? "" : "s"} remain visible below; they cannot repair the incomplete confirmatory evidence.`
        : undefined,
    };
  }
  if (code === "lower_cost_supported") {
    return {
      tone: "positive",
      label: "OBSERVED LOWER COST AT TARGET",
      answer: "Local reached the target with less recorded compute.",
      explanation: "The preregistered token endpoint cleared its cost band, exact sign test, and paired bootstrap direction checks.",
      qualifier: "Observed in this task and frozen configuration; this is not evidence of learning or general swarm superiority.",
    };
  }
  if (code === "higher_cost_supported") {
    return {
      tone: "negative",
      label: "OBSERVED HIGHER COST AT TARGET",
      answer: "Local required more recorded compute at the target.",
      explanation: "The preregistered token endpoint supported the isolated condition in this configuration.",
      qualifier: "Observed in this task and frozen configuration; this is not a general topology result.",
    };
  }
  if (code === "insufficient_comparable_pairs") {
    return {
      tone: "neutral",
      label: "TOO FEW COST-COMPARABLE PAIRS",
      answer: "The target did not yield enough paired cost observations.",
      explanation: "Both conditions must reach the target before their discovery costs can be compared.",
      qualifier: "One-sided and neither-reached pairs remain censored; they are not encoded as zero, ties, or capped cost.",
    };
  }
  if (code === "ambiguous_usage") {
    return {
      tone: "neutral",
      label: "TOKEN USAGE AMBIGUOUS",
      answer: "Recorded token cost cannot support a conclusion.",
      explanation: "At least one provider attempt may have consumed unrecorded tokens.",
      qualifier: "The target-attainment evidence remains visible, but the primary cost endpoint is withheld.",
    };
  }
  return {
    tone: "neutral",
    label: "FIXED-QUALITY COST RESULT INCONCLUSIVE",
    answer: "The cost advantage remains uncertain.",
    explanation: "The paired token evidence did not clear every preregistered decision check.",
    qualifier: "This is inconclusive, not evidence of equal cost or no topology effect.",
  };
}

function fixedQualityTrialView(value) {
  const trial = object(value);
  const base = trialView(value);
  if (trial === null || base === null) return null;
  const fixedQuality = object(trial.fixedQuality) ?? {};
  return {
    ...base,
    valid: trial.valid === true,
    equalBudget: array(trial.controlChecks).length > 0 && array(trial.controlChecks).every((check) => check?.equal === true),
    attemptIntegrity: attemptIntegrityView(trial.attemptIntegrity, trial.valid === true),
    fixedQuality: {
      outcome: fixedQualityOutcome(fixedQuality.outcome),
      costComparable: fixedQuality.costComparable === true,
      primaryOutcome: string(fixedQuality.primaryOutcome, "tie"),
      costAtTarget: Object.fromEntries(CONDITIONS.map((condition) => [
        condition,
        reachedTargetBoundary(base.conditions[condition]),
      ])),
      localVsIsolatedPct: Object.fromEntries([
        "responsesTokens",
        "modelTurns",
        "toolExecutions",
        "publicChecks",
        "evaluations",
        "creditsSpent",
        "elapsedMs",
      ].map((metric) => [metric, nullableFinite(fixedQuality.localVsIsolatedPct?.[metric])])),
    },
  };
}

function attemptIntegrityView(value, fallbackValid) {
  const audit = object(value);
  const reasons = array(audit?.reasons).map(integrityReasonView).filter(Boolean);
  return {
    recorded: audit !== null,
    protocol: string(audit?.protocol, null),
    attempts: finite(audit?.attempts),
    auditedAttempts: finite(audit?.auditedAttempts),
    assessedAttempts: finite(audit?.assessedAttempts),
    allAttemptsAudited: audit?.allAttemptsAudited === true,
    validForPair: audit === null ? fallbackValid : audit.validForPair === true,
    reasons,
  };
}

function integrityReasonView(value) {
  const reason = object(value);
  if (reason === null) return null;
  return {
    code: string(reason.code, "unrecorded_integrity_reason"),
    trial: nullableFinite(reason.trial),
    condition: string(reason.condition, null),
    attempt: nullableFinite(reason.attempt),
    runId: string(reason.runId, null),
    detail: string(reason.detail, string(reason.message, null)),
  };
}

function reachedTargetBoundary(run) {
  return run?.target?.valid === true && run.target.reached === true
    ? run.target.boundary
    : null;
}

function fixedQualityOutcome(value) {
  return ["both_reached", "local_only", "isolated_only", "neither_reached", "invalid"].includes(value)
    ? value
    : "invalid";
}

function fixedQualityAttainment(value, configuredPairs) {
  const attainment = object(value) ?? {};
  const pairCounts = object(attainment.pairs) ?? {};
  return {
    local: {
      reached: finite(attainment.local?.reached),
      total: finite(attainment.local?.total, configuredPairs),
      ratePct: nullableFinite(attainment.local?.ratePct),
    },
    isolated: {
      reached: finite(attainment.isolated?.reached),
      total: finite(attainment.isolated?.total, configuredPairs),
      ratePct: nullableFinite(attainment.isolated?.ratePct),
    },
    pairs: {
      bothReached: finite(pairCounts.bothReached),
      localOnly: finite(pairCounts.localOnly),
      isolatedOnly: finite(pairCounts.isolatedOnly),
      neitherReached: finite(pairCounts.neitherReached),
      invalid: finite(pairCounts.invalid),
    },
  };
}

function fixedQualityResources(value) {
  const distributions = object(value) ?? {};
  return [
    ["responsesTokens", "Responses tokens"],
    ["modelTurns", "Model turns"],
    ["toolExecutions", "Tool executions"],
    ["evaluations", "Evaluations"],
    ["elapsedMs", "Elapsed time"],
  ].map(([key, label]) => ({ key, label, distribution: costDistributionView(distributions[key]) }));
}

function costDistributionView(value) {
  const distribution = object(value) ?? {};
  const directionCounts = object(distribution.directionCounts) ?? {};
  const interval = object(distribution.interval95);
  return {
    values: array(distribution.values).map(nullableFinite).filter((entry) => entry !== null),
    median: nullableFinite(distribution.median),
    minimum: nullableFinite(distribution.minimum),
    maximum: nullableFinite(distribution.maximum),
    directionCounts: {
      localLower: finite(directionCounts.localLower),
      isolatedLower: finite(directionCounts.isolatedLower),
      equal: finite(directionCounts.equal),
    },
    interval95: interval === null ? null : {
      lower: nullableFinite(interval.lower),
      upper: nullableFinite(interval.upper),
      method: string(interval.method, "unrecorded"),
      samples: finite(interval.samples),
      seed: string(interval.seed, null),
    },
  };
}

function emptyCostDistribution() {
  return costDistributionView(null);
}

function fixedQualitySignTests(value, fixedQuality) {
  const signTest = object(value) ?? {};
  const nonTiedPairs = finite(signTest.nonTiedPairs);
  const alpha = nullableFinite(signTest.alpha);
  const localRecord = object(signTest.local);
  const isolatedRecord = object(signTest.isolated);
  const localWins = nullableFinite(localRecord?.wins ?? signTest.localWins);
  const isolatedWins = nullableFinite(isolatedRecord?.wins ?? signTest.isolatedWins ?? fixedQuality.isolatedWins);
  return {
    local: {
      direction: "local",
      nonTiedPairs,
      wins: localWins === null ? 0 : localWins,
      localWins: localWins === null ? 0 : localWins,
      pValue: nullableFinite(localRecord?.pValue ?? signTest.pValue),
      alpha: nullableFinite(localRecord?.alpha) ?? alpha,
    },
    isolated: {
      direction: "isolated",
      nonTiedPairs,
      wins: isolatedWins === null ? 0 : isolatedWins,
      pValue: nullableFinite(isolatedRecord?.pValue ?? signTest.isolatedPValue),
      alpha: nullableFinite(isolatedRecord?.alpha) ?? alpha,
    },
  };
}

function fixedQualityIntegrity(value, trials, configuredPairs, validPairs) {
  const integrity = object(value) ?? {};
  const counts = object(integrity.counts) ?? {};
  const trialReasons = trials.flatMap((trial) => trial.attemptIntegrity.reasons);
  const aggregateReasons = array(integrity.reasons).map(integrityReasonView).filter(Boolean);
  const reasons = aggregateReasons.length > 0 ? aggregateReasons : trialReasons;
  const invalidPairs = finite(
    counts.invalidPairs ?? counts.invalid ?? integrity.invalidPairs ?? integrity.invalid,
    Math.max(0, configuredPairs - validPairs),
  );
  const auditedAttempts = finite(counts.auditedAttempts ?? integrity.auditedAttempts);
  const attempts = finite(counts.attempts ?? integrity.attempts);
  const assessedAttempts = finite(counts.assessedAttempts ?? integrity.assessedAttempts);
  return {
    recorded: object(value) !== null || trials.some((trial) => trial.attemptIntegrity.recorded),
    protocol: string(integrity.protocol, trials.find((trial) => trial.attemptIntegrity.protocol)?.attemptIntegrity.protocol ?? null),
    configuredPairs,
    validPairs,
    invalidPairs,
    attempts,
    auditedAttempts,
    assessedAttempts,
    invalidAttempts: finite(counts.invalidAttempts ?? integrity.invalidAttempts),
    allAttemptsAudited: integrity.allAttemptsAudited === true || (attempts > 0 && auditedAttempts === attempts),
    validForClaim: integrity.validForClaim === true && invalidPairs === 0,
    reasonCounts: object(integrity.reasonCounts) ?? countIntegrityReasons(reasons),
    reasons,
  };
}

function countIntegrityReasons(reasons) {
  const counts = {};
  for (const reason of reasons) counts[reason.code] = finite(counts[reason.code]) + 1;
  return counts;
}

function fixedQualityTarget(config, trials) {
  const firstTarget = trials.flatMap((trial) => CONDITIONS.flatMap((condition) => {
    const target = trial.conditions[condition]?.target;
    return target === null ? [] : [target];
  }))[0] ?? null;
  const multiplier = nullableFinite(config.qualityTargetMultiplier) ?? firstTarget?.multiplier;
  const rechecks = nullableFinite(config.qualityTargetRechecks) ?? firstTarget?.rechecksPerCandidate;
  const requiredRatios = nullableFinite(config.qualityTargetRequiredRatios) ?? firstTarget?.requiredPassingRatios;
  const requiredCorrectness = firstTarget?.requiredCorrectnessPasses ?? rechecks;
  const blockSize = nullableFinite(config.qualityTargetBlockSize) ?? firstTarget?.blockSize;
  const maximumBaselineDrift = nullableFinite(config.qualityTargetMaximumBaselineDrift) ?? firstTarget?.maximumBaselineDriftRatio;
  const parts = [];
  if (multiplier !== null) parts.push(`${number(multiplier, 2)}× its paired baseline`);
  if (requiredRatios !== null && rechecks !== null) parts.push(`${number(requiredRatios)}/${number(rechecks)} ratio rechecks`);
  if (requiredCorrectness !== null) parts.push(`all ${number(requiredCorrectness)} correctness checks`);
  const rule = parts.length === 0
    ? "the recorded fixed-quality recheck protocol"
    : parts.length === 1
      ? parts[0]
      : `${parts[0]} in ${parts.slice(1).join(" and ")}`;
  return {
    multiplier,
    rechecks,
    requiredRatios,
    requiredCorrectness,
    blockSize,
    maximumBaselineDrift,
    definition: `A candidate had to clear ${rule}. Discovery cost is measured at its retrospectively verified first qualifying generation; non-reaching runs are censored at the shared cap. Recheck cost remains separate in raw evidence and is not included in discovery cost.`,
  };
}

function fixedQualityCensoringCopy(attainment, integrity) {
  const pairs = attainment.pairs;
  const integrityLead = integrity.invalidPairs > 0
    ? `Confirmatory integrity is incomplete: ${number(integrity.validPairs)}/${number(integrity.configuredPairs)} planned pairs are valid; ${integrityReasonSummary(integrity.reasons)}. `
    : integrity.recorded
      ? `All-attempt integrity: ${number(integrity.validPairs)}/${number(integrity.configuredPairs)} planned pairs valid. `
      : "";
  return `${integrityLead}${number(pairs.bothReached)} both reached · ${number(pairs.localOnly)} local only · ${number(pairs.isolatedOnly)} isolated only · ${number(pairs.neitherReached)} neither · ${number(pairs.invalid)} invalid. Cost deltas use only both-reached valid pairs; censored costs are never encoded as zero or cap spend.`;
}

function fixedQualityHeadlineFacts({
  attainment,
  comparablePairs,
  configuredPairs,
  tokenDistribution,
  signTests,
  integrity,
  globalControlsVerified,
}) {
  const interval = tokenDistribution.interval95;
  const descriptive = integrity.invalidPairs > 0 ? " · descriptive only" : "";
  const facts = [
    {
      label: "Attempt integrity",
      value: `${integrity.validPairs} / ${integrity.configuredPairs} valid`,
      detail: integrity.invalidPairs > 0
        ? `${number(integrity.invalidPairs)} invalid · confirmatory evidence incomplete`
        : integrity.recorded ? "all retained attempts audited" : "legacy bundle · pair validity only",
    },
    {
      label: "Target reached",
      value: `${attainment.local.reached}/${attainment.local.total} L · ${attainment.isolated.reached}/${attainment.isolated.total} I`,
      detail: `local · isolated${descriptive}`,
    },
    {
      label: "Cost-comparable",
      value: `${comparablePairs} / ${configuredPairs}`,
      detail: `both conditions reached in valid pairs${descriptive}`,
    },
    {
      label: "Median token delta",
      value: tokenDistribution.median === null ? "—" : signedPercent(tokenDistribution.median),
      detail: `${costRangeDetail(tokenDistribution)}${descriptive}`,
    },
    {
      label: "95% token interval",
      value: interval?.lower === null || interval?.upper === null || interval === null
        ? "—"
        : `${signedPercent(interval.lower)} to ${signedPercent(interval.upper)}`,
      detail: interval === null ? "paired bootstrap not available" : `${number(interval.samples)} paired bootstrap samples${descriptive}`,
    },
    {
      label: "Frozen controls",
      value: globalControlsVerified ? "VERIFIED" : "NOT VERIFIED",
      detail: "one fingerprint across every planned run",
    },
  ];
  facts.splice(5, 0, signTestFact(
    signTests.local,
    signTests.isolated.pValue === null ? "Exact sign test" : "Local-direction sign test",
    descriptive,
  ));
  if (signTests.isolated.pValue !== null) {
    facts.splice(6, 0, signTestFact(signTests.isolated, "Isolated-direction sign test", descriptive));
  }
  return facts;
}

function signTestFact(signTest, label, descriptive) {
  return {
    label,
    value: signTest.pValue === null ? "—" : `p = ${String(signTest.pValue)}`,
    detail: `${number(signTest.wins)} ${signTest.direction} wins / ${number(signTest.nonTiedPairs)} non-ties · α ${signTest.alpha === null ? "—" : String(signTest.alpha)}${descriptive}`,
  };
}

function integrityReasonSummary(reasons) {
  if (reasons.length === 0) return "the invalid reason was not recorded";
  const unique = [...new Set(reasons.map((reason) => humanizeIntegrityReason(reason.code)))];
  return unique.join("; ");
}

function humanizeIntegrityReason(code) {
  return {
    ambiguous_provider_attempt: "ambiguous provider attempt",
    exhausted_target_block_retry: "exhausted target-block retry",
  }[code] ?? String(code).replaceAll("_", " ");
}

function costRangeDetail(distribution) {
  return distribution.minimum === null || distribution.maximum === null
    ? "no both-reached cost pairs"
    : `${signedPercent(distribution.minimum)} to ${signedPercent(distribution.maximum)} observed · n=${number(distribution.values.length)}`;
}

function fixedQualityConfigView(config, target) {
  const targetRule = target.multiplier === null || target.requiredRatios === null || target.rechecks === null
    ? "unrecorded"
    : `${number(target.multiplier, 2)}× baseline · ${number(target.requiredRatios)}/${number(target.rechecks)} ratio rechecks`;
  return [
    ["Objective", "recorded discovery cost to fixed verified quality"],
    ["Verified target", targetRule],
    ["Correctness gate", target.requiredCorrectness === null || target.rechecks === null ? "unrecorded" : `${number(target.requiredCorrectness)}/${number(target.rechecks)} checks pass`],
    ["Primary endpoint", "Responses tokens at first qualifying generation"],
    ["Decision rule", `±${number(finite(config.meaningfulCostDeltaPct), 1)}% band · α ${nullableFinite(config.alpha) ?? "—"} · min ${number(finite(config.minimumComparablePairs))} comparable`],
    ["Baseline guard", target.maximumBaselineDrift === null || target.blockSize === null ? "unrecorded" : `≤ ${number(target.maximumBaselineDrift, 2)}× drift · block ${number(target.blockSize)}`],
    ["Topology", `${finite(config.rows)}×${finite(config.columns)} · ${finite(config.generations)} generations`],
    ["Cell budget", `${finite(config.creditsPerCell)} credits · ${finite(config.maxModelTurns)} model turns · ${finite(config.maxToolCalls)} tools`],
    ["Trial order", string(config.order, "unrecorded")],
  ];
}

function unavailableComparison(latestSummary) {
  const latest = object(latestSummary);
  const condition = string(latest?.experiment?.condition, null);
  const model = string(latest?.services?.modelGateway?.model, "unrecorded model");
  const score = nullableFinite(latest?.experiment?.bestScore);
  const tokens = nullableFinite(latest?.services?.modelGateway?.usage?.totalTokens);
  const current = condition === null ? "a single completed run" : `one ${condition} run`;
  return {
    available: false,
    mode: "quality",
    question: "Did neighbor exchange help?",
    observationLabel: "Secondary / descriptive",
    detailTitle: "Trial variation and spend",
    chartTitle: "Best verified score by generation",
    spendTitle: "Accounted spend",
    spendMeta: "all displayed trials",
    complete: false,
    comparisonId: null,
    status: "unavailable",
    completedAt: null,
    verdict: {
      tone: "pending",
      label: "INSUFFICIENT PAIRED EVIDENCE",
      answer: "Not answered yet.",
      explanation: `The report currently has ${current}. Neighbor exchange requires a matched local and isolated run under the same recorded budget.`,
      claim: "No causal comparison is available, so this page does not infer an advantage from the latest score.",
      boundary: "A single run establishes integration and runtime behavior only.",
    },
    efficiency: efficiencyObservation(null),
    headlineFacts: [
      { label: "Matched pairs", value: "0", detail: "local + isolated required" },
      { label: "Latest condition", value: condition ?? "—", detail: latest?.runId ?? "no completed run" },
      { label: "Latest best score", value: score === null ? "—" : number(score), detail: "not a comparative effect" },
      { label: "Latest spend", value: tokens === null ? "—" : number(tokens), detail: `${model} Responses tokens` },
    ],
    config: [],
    trials: [],
    totals: Object.fromEntries(CONDITIONS.map((conditionName) => [conditionName, emptyTotal(conditionName)])),
    curves: { local: [], isolated: [] },
    lineageRuns: [],
    lineageSummaries: [],
    lineageErrors: [],
    variation: { local: emptyVariation(), isolated: emptyVariation() },
  };
}

function comparisonVerdict({ complete, uplift, threshold, conclusion }) {
  if (!complete || uplift === null) {
    return {
      tone: "pending",
      label: "PAIRED EVIDENCE INCOMPLETE",
      answer: "Not answered yet.",
      explanation: "At least one configured matched pair is missing or failed, so no neighbor-effect conclusion is reported.",
    };
  }
  if (conclusion === "observed_local_advantage") {
    return {
      tone: "positive",
      label: "MEASURED LOCAL ADVANTAGE",
      answer: "Yes, in these matched trials.",
      explanation: `Local exchange cleared the predeclared ${number(threshold, 1)}% meaningful-effect threshold.`,
    };
  }
  if (conclusion === "observed_isolated_advantage") {
    return {
      tone: "negative",
      label: "MEASURED ISOLATED ADVANTAGE",
      answer: "No. Isolated agents did better.",
      explanation: `Local exchange trailed isolated work beyond the predeclared ${number(threshold, 1)}% meaningful-effect threshold.`,
    };
  }
  return {
    tone: "neutral",
    label: "INCONCLUSIVE QUALITY RESULT",
    answer: "Quality effect was mixed.",
    explanation: `The paired effect did not establish a repeatable advantage beyond the predeclared ±${number(threshold, 1)}% decision band.`,
    qualifier: "This is inconclusive, not evidence of no effect or quality equivalence.",
  };
}

function efficiencyObservation(value) {
  const metrics = object(object(value)?.localVsIsolatedPct);
  const tokenDelta = distributionMedian(metrics?.tokens);
  const elapsedDelta = distributionMedian(metrics?.elapsedMs);
  const clauses = [
    efficiencyClause(tokenDelta, "tokens"),
    efficiencyClause(elapsedDelta, "elapsed"),
  ].filter(Boolean);
  if (clauses.length === 0) {
    return {
      available: false,
      text: "Efficiency deltas were not recorded in this bundle; no secondary efficiency observation is available.",
    };
  }
  return {
    available: true,
    text: `${joinClauses(clauses)} across passed matched pairs. This descriptive observation does not change the primary quality verdict.`,
  };
}

function distributionMedian(value) {
  return nullableFinite(object(value)?.median);
}

function efficiencyClause(value, metric) {
  if (value === null) return null;
  const magnitude = number(Math.abs(value), 1);
  if (Math.abs(value) < .05) {
    return metric === "tokens"
      ? "Local used effectively the same Responses tokens"
      : "Local took effectively the same elapsed time";
  }
  if (metric === "tokens") {
    return value < 0
      ? `Local used ${magnitude}% fewer Responses tokens`
      : `Local used ${magnitude}% more Responses tokens`;
  }
  return value < 0
    ? `Local took ${magnitude}% less elapsed time`
    : `Local took ${magnitude}% more elapsed time`;
}

function joinClauses(clauses) {
  if (clauses.length < 2) return clauses[0];
  const continuation = clauses[1].startsWith("Local ") ? clauses[1].slice("Local ".length) : clauses[1];
  return `${clauses[0]} and ${continuation}`;
}

function trialView(value) {
  const trial = object(value);
  if (trial === null) return null;
  const conditions = Object.fromEntries(CONDITIONS.map((condition) => [condition, runView(trial.conditions?.[condition])]));
  return {
    trial: finite(trial.trial, 0),
    order: array(trial.order).filter((condition) => CONDITIONS.includes(condition)),
    conditions,
    upliftAbsolute: nullableFinite(trial.uplift?.absolute),
    upliftPercent: nullableFinite(trial.uplift?.percentPoints ?? trial.uplift?.percent),
    outcome: string(trial.outcome, "unrecorded"),
    complete: trial.complete === true || CONDITIONS.every((condition) => conditions[condition] !== null && conditions[condition].status === "passed"),
    equalBudget: array(trial.budgetChecks).length > 0 && array(trial.budgetChecks).every((check) => check?.equal === true),
  };
}

function runView(value) {
  const run = object(value);
  if (run === null) return null;
  return {
    runId: string(run.runId, "unidentified run"),
    status: string(run.status, "unknown"),
    seedScore: finite(run.seedScore),
    bestScore: finite(run.bestScore),
    gain: finite(run.gain),
    gainPct: nullableFinite(run.gainPct),
    tokens: finite(run.tokens),
    modelTurns: finite(run.modelTurns),
    toolExecutions: finite(run.toolExecutions),
    evaluations: finite(run.evaluations),
    elapsedMs: finite(run.elapsedMs),
    fallbacks: finite(run.fallbacks),
    creditsSpent: finite(run.creditsSpent),
    model: string(run.model, "unrecorded"),
    benchmarkId: string(run.benchmarkId, "unrecorded"),
    target: targetView(run.target),
    lineage: {
      uniqueSubmittedCandidates: finite(run.lineage?.uniqueSubmittedCandidates),
      finalDiversity: finite(run.lineage?.finalDiversity),
      adoptions: finite(run.lineage?.adoptions),
      improvements: finite(run.lineage?.improvements),
      challenges: finite(run.lineage?.challenges),
      waits: finite(run.lineage?.waits),
      neighborDerivedImprovements: finite(run.lineage?.neighborDerivedImprovements),
      maxDepth: finite(run.lineage?.maxDepth),
      duplicateEvaluations: finite(run.lineage?.duplicateEvaluations),
    },
    generationMetrics: array(run.generationMetrics).map((metric) => ({
      generation: finite(metric?.generation),
      bestScore: finite(metric?.bestScore ?? metric?.score),
      medianScore: nullableFinite(metric?.medianScore),
    })).filter((metric) => metric.generation > 0),
  };
}

function targetView(value) {
  const target = object(value);
  if (target === null) return null;
  const boundary = object(target.boundary);
  const censoring = object(target.censoring);
  return {
    protocol: string(target.protocol, "unrecorded"),
    valid: target.valid === true,
    reached: target.reached === true,
    state: string(target.state, target.valid === true ? target.reached === true ? "reached" : "not_reached" : "invalid"),
    multiplier: nullableFinite(target.multiplier),
    rechecksPerCandidate: nullableFinite(target.rechecksPerCandidate),
    requiredPassingRatios: nullableFinite(target.requiredPassingRatios),
    requiredCorrectnessPasses: nullableFinite(target.requiredCorrectnessPasses),
    blockSize: nullableFinite(target.blockSize),
    maximumBaselineDriftRatio: nullableFinite(target.maximumBaselineDriftRatio),
    firstReachedGeneration: nullableFinite(target.firstReachedGeneration),
    candidateId: string(target.candidateId, null),
    medianRatio: nullableFinite(target.medianRatio),
    passingRatios: nullableFinite(target.passingRatios),
    boundary: boundary === null ? null : {
      responsesTokens: nullableFinite(boundary.responsesTokens),
      modelTurns: nullableFinite(boundary.modelTurns),
      toolExecutions: nullableFinite(boundary.toolExecutions),
      publicChecks: nullableFinite(boundary.publicChecks),
      evaluations: nullableFinite(boundary.evaluations),
      creditsSpent: nullableFinite(boundary.creditsSpent),
      elapsedMs: nullableFinite(boundary.elapsedMs),
    },
    censoring: censoring === null ? null : {
      reason: string(censoring.reason, "unrecorded"),
      generation: nullableFinite(censoring.generation),
    },
    measurementEvaluations: finite(target.measurementEvaluations),
    measurementElapsedMs: finite(target.measurementElapsedMs),
  };
}

function totalCondition(trials, condition) {
  const runs = trials.flatMap((trial) => trial.conditions[condition] === null ? [] : [trial.conditions[condition]]);
  return {
    condition,
    runs: runs.length,
    tokens: sum(runs, "tokens"),
    modelTurns: sum(runs, "modelTurns"),
    toolExecutions: sum(runs, "toolExecutions"),
    evaluations: sum(runs, "evaluations"),
    elapsedMs: sum(runs, "elapsedMs"),
    fallbacks: sum(runs, "fallbacks"),
    creditsSpent: sum(runs, "creditsSpent"),
  };
}

function emptyTotal(condition) {
  return { condition, runs: 0, tokens: 0, modelTurns: 0, toolExecutions: 0, evaluations: 0, elapsedMs: 0, fallbacks: 0, creditsSpent: 0 };
}

function conditionCurve(trials, condition) {
  const byGeneration = new Map();
  for (const trial of trials) {
    const run = trial.conditions[condition];
    if (run === null || run.status !== "passed") continue;
    addCurveValue(byGeneration, 0, run.seedScore);
    for (const metric of run.generationMetrics) addCurveValue(byGeneration, metric.generation, metric.bestScore);
  }
  return [...byGeneration.entries()].sort(([left], [right]) => left - right).map(([generation, scores]) => ({
    generation,
    score: median(scores),
    minimum: Math.min(...scores),
    maximum: Math.max(...scores),
    samples: scores.length,
  }));
}

function addCurveValue(map, generation, score) {
  if (!Number.isFinite(score)) return;
  const values = map.get(generation) ?? [];
  values.push(score);
  map.set(generation, values);
}

function scoreVariation(trials, condition) {
  const scores = trials.flatMap((trial) => {
    const run = trial.conditions[condition];
    return run === null || run.status !== "passed" ? [] : [run.bestScore];
  });
  if (scores.length === 0) return emptyVariation();
  return { samples: scores.length, minimum: Math.min(...scores), median: median(scores), maximum: Math.max(...scores) };
}

function emptyVariation() {
  return { samples: 0, minimum: null, median: null, maximum: null };
}

function configView(value) {
  const config = object(value) ?? {};
  return [
    ["Benchmark", string(config.benchmarkId, "unrecorded")],
    ["Evaluator", string(config.evaluatorVersion, "unrecorded")],
    ["Topology", `${finite(config.rows)}×${finite(config.columns)} · ${finite(config.generations)} generations`],
    ["Cell budget", `${finite(config.creditsPerCell)} credits · ${finite(config.maxModelTurns)} model turns · ${finite(config.maxToolCalls)} tools`],
    ["Trial order", string(config.order, "unrecorded")],
    ["Conditions", array(config.conditions).join(" vs ") || "unrecorded"],
  ];
}

function lineageRunView(value) {
  const run = object(value);
  if (run === null || !CONDITIONS.includes(run.condition)) return null;
  return {
    trial: finite(run.trial),
    condition: run.condition,
    runId: string(run.runId, "unidentified run"),
    generations: array(run.generations).map((generation) => ({
      generation: finite(generation?.generation),
      cells: finite(generation?.cells),
      candidates: finite(generation?.candidates),
      adoptions: finite(generation?.adoptions),
      leader: object(generation?.leader) === null ? null : {
        candidateId: string(generation.leader.candidateId, "unknown"),
        strategy: string(generation.leader.strategy, "unrecorded strategy"),
        score: finite(generation.leader.score),
        holders: finite(generation.leader.holders),
        adoptedBy: finite(generation.leader.adoptedBy),
        originAgent: string(generation.leader.originAgent, null),
      },
    })).filter((generation) => generation.generation > 0),
  };
}

function sum(runs, key) {
  return runs.reduce((total, run) => total + finite(run[key]), 0);
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function string(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nullableFinite(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function number(value, digits = 0) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

function signedPercent(value) {
  return `${value > 0 ? "+" : ""}${number(value, 1)}%`;
}

function upliftRangeDetail(record, threshold) {
  const minimum = nullableFinite(record?.minimum);
  const maximum = nullableFinite(record?.maximum);
  return minimum === null || maximum === null
    ? `meaningful threshold ±${number(threshold, 1)}%`
    : `${signedPercent(minimum)} to ${signedPercent(maximum)} observed`;
}
