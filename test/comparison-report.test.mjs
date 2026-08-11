import { describe, expect, it } from "vitest";
import { comparisonView } from "../examples/cellular-agent-swarm/public/comparison-view-model.js";

describe("comparison evidence report", () => {
  it("refuses to infer a neighbor effect from the latest single run", () => {
    const view = comparisonView(null, {
      runId: "local-only",
      experiment: { condition: "local", bestScore: 60163 },
      services: { modelGateway: { model: "gpt-5.6-luna", usage: { totalTokens: 42000 } } },
    });

    expect(view.available).toBe(false);
    expect(view.verdict.answer).toBe("Not answered yet.");
    expect(view.verdict.claim).toContain("No causal comparison");
    expect(view.efficiency).toEqual({
      available: false,
      text: "Efficiency deltas were not recorded in this bundle; no secondary efficiency observation is available.",
    });
    expect(view.headlineFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Matched pairs", value: "0" }),
      expect.objectContaining({ label: "Latest condition", value: "local" }),
    ]));
  });

  it("projects paired wins, variation, spend, curves, and compact lineage", () => {
    const payload = pairedPayload();
    const view = comparisonView(payload);

    expect(view.available).toBe(true);
    expect(view.complete).toBe(true);
    expect(view.verdict.tone).toBe("positive");
    expect(view.verdict.answer).toBe("Yes, in these matched trials.");
    expect(view.efficiency).toEqual({
      available: true,
      text: "Local used 7% fewer Responses tokens and took 23.8% less elapsed time across passed matched pairs. This descriptive observation does not change the primary quality verdict.",
    });
    expect(view.trials).toHaveLength(2);
    expect(view.totals.local).toMatchObject({ tokens: 2200, toolExecutions: 9, fallbacks: 1, creditsSpent: 85 });
    expect(view.totals.isolated).toMatchObject({ tokens: 2000, toolExecutions: 8, fallbacks: 3, creditsSpent: 84 });
    expect(view.variation.local).toEqual({ samples: 2, minimum: 110, median: 115, maximum: 120 });
    expect(view.curves.local).toEqual([
      { generation: 0, score: 80, minimum: 80, maximum: 80, samples: 2 },
      { generation: 1, score: 95, minimum: 90, maximum: 100, samples: 2 },
      { generation: 2, score: 115, minimum: 110, maximum: 120, samples: 2 },
    ]);
    expect(view.lineageRuns[0]).toMatchObject({ trial: 1, condition: "local", generations: [{ generation: 1 }] });
  });

  it("keeps a high uplift inconclusive when a configured pair failed", () => {
    const payload = pairedPayload();
    payload.summary.status = "failed";
    payload.summary.aggregate.passedPairs = 1;
    payload.summary.trials[1].conditions.isolated.status = "failed";
    payload.summary.trials[1].complete = false;

    const view = comparisonView(payload);

    expect(view.complete).toBe(false);
    expect(view.verdict.tone).toBe("pending");
    expect(view.verdict.answer).toBe("Not answered yet.");
    expect(view.trials[1].complete).toBe(false);
  });

  it("reports effects inside the declared threshold as inconclusive", () => {
    const payload = pairedPayload();
    payload.summary.aggregate.pairedUpliftPct = { values: [2, 2], median: 2, minimum: 2, maximum: 2 };
    payload.summary.aggregate.conclusion = {
      code: "inconclusive",
      headline: "No repeatable neighbor-exchange advantage was observed.",
      detail: "Observed uplift remained inside the decision band.",
    };

    const view = comparisonView(payload);

    expect(view.complete).toBe(true);
    expect(view.verdict.tone).toBe("neutral");
    expect(view.verdict.label).toBe("INCONCLUSIVE QUALITY RESULT");
    expect(view.verdict.answer).toBe("Quality effect was mixed.");
    expect(view.verdict.claim).toContain("not evidence of no effect or quality equivalence");
  });

  it("describes higher local efficiency spend without changing the quality verdict", () => {
    const payload = pairedPayload();
    payload.summary.aggregate.efficiency.localVsIsolatedPct.tokens.median = 12.5;
    payload.summary.aggregate.efficiency.localVsIsolatedPct.elapsedMs.median = 8.4;

    const view = comparisonView(payload);

    expect(view.verdict.answer).toBe("Yes, in these matched trials.");
    expect(view.efficiency.text).toBe("Local used 12.5% more Responses tokens and took 8.4% more elapsed time across passed matched pairs. This descriptive observation does not change the primary quality verdict.");
  });

  it("keeps older paired bundles useful when efficiency distributions are absent", () => {
    const payload = pairedPayload();
    delete payload.summary.aggregate.efficiency;

    const view = comparisonView(payload);

    expect(view.complete).toBe(true);
    expect(view.verdict.answer).toBe("Yes, in these matched trials.");
    expect(view.efficiency.available).toBe(false);
    expect(view.efficiency.text).toContain("were not recorded");
  });

  it("presents the fixed-quality question, target, paired cost variation, and conservative decision evidence", () => {
    const view = comparisonView(fixedQualityPayload());

    expect(view.mode).toBe("fixed-quality");
    expect(view.question).toBe("Did local exchange reach verified quality with less compute?");
    expect(view.complete).toBe(true);
    expect(view.verdict).toMatchObject({
      tone: "positive",
      label: "OBSERVED LOWER COST AT TARGET",
      answer: "Local reached the target with less recorded compute.",
    });
    expect(view.verdict.boundary).toContain("3× its paired baseline");
    expect(view.verdict.boundary).toContain("8/9 ratio rechecks");
    expect(view.verdict.boundary).toContain("Recheck cost");
    expect(view.headlineFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Target reached", value: "10/10 L · 10/10 I" }),
      expect.objectContaining({ label: "Cost-comparable", value: "10 / 10" }),
      expect.objectContaining({ label: "Median token delta", value: "-20%" }),
      expect.objectContaining({ label: "95% token interval", value: "-24% to -16%" }),
      expect.objectContaining({ label: "Exact sign test", value: "p = 0.00097656" }),
    ]));
    expect(view.fixedQuality.resources.map((resource) => resource.key)).toEqual([
      "responsesTokens",
      "modelTurns",
      "toolExecutions",
      "evaluations",
      "elapsedMs",
    ]);
    expect(view.fixedQuality.resources[0].distribution).toMatchObject({
      values: [-20, -20, -20, -20, -20, -20, -20, -20, -20, -20],
      median: -20,
      minimum: -20,
      maximum: -20,
      directionCounts: { localLower: 10, isolatedLower: 0, equal: 0 },
    });
    expect(view.fixedQuality.signTest).toEqual({
      nonTiedPairs: 10,
      localWins: 10,
      pValue: 0.00097656,
      alpha: 0.05,
    });
  });

  it("keeps every fixed-quality attainment outcome explicit and withholds censored cost", () => {
    const payload = fixedQualityPayload();
    payload.summary.status = "incomplete";
    payload.summary.config.trials = 5;
    payload.summary.aggregate.pairs = 5;
    payload.summary.aggregate.validPairs = 4;
    payload.summary.trials = [
      fixedTrial(1, "both_reached"),
      fixedTrial(2, "local_only"),
      fixedTrial(3, "isolated_only"),
      fixedTrial(4, "neither_reached"),
      fixedTrial(5, "invalid"),
    ];
    payload.summary.aggregate.fixedQuality.attainment = {
      local: { reached: 2, total: 4, ratePct: 50 },
      isolated: { reached: 2, total: 4, ratePct: 50 },
      pairs: { bothReached: 1, localOnly: 1, isolatedOnly: 1, neitherReached: 1, invalid: 1 },
    };
    payload.summary.aggregate.fixedQuality.comparablePairs = 1;
    payload.summary.aggregate.fixedQuality.conclusion = {
      code: "incomplete",
      headline: "The fixed-quality comparison is incomplete.",
      detail: "One pair was invalid.",
    };

    const view = comparisonView(payload);

    expect(view.trials.map((trial) => trial.fixedQuality.outcome)).toEqual([
      "both_reached",
      "local_only",
      "isolated_only",
      "neither_reached",
      "invalid",
    ]);
    expect(view.trials[1].fixedQuality.costComparable).toBe(false);
    expect(view.trials[1].fixedQuality.localVsIsolatedPct.responsesTokens).toBeNull();
    expect(view.trials[1].fixedQuality.costAtTarget.local.responsesTokens).toBe(800);
    expect(view.trials[1].fixedQuality.costAtTarget.isolated).toBeNull();
    expect(view.trials[3].fixedQuality.costAtTarget).toEqual({ local: null, isolated: null });
    expect(view.efficiency.text).toContain("1 local only");
    expect(view.efficiency.text).toContain("censored costs are never encoded as zero or cap spend");
    expect(view.verdict.answer).toBe("No confirmatory conclusion.");
  });

  it("states why a valid fixed-quality run can still lack enough comparable cost pairs", () => {
    const payload = fixedQualityPayload();
    payload.summary.aggregate.fixedQuality.comparablePairs = 3;
    payload.summary.aggregate.fixedQuality.conclusion = {
      code: "insufficient_comparable_pairs",
      headline: "Too few pairs reached the quality target in both conditions.",
      detail: "3/10 pairs support a paired cost-to-target calculation; censored pairs were not imputed.",
    };

    const view = comparisonView(payload);

    expect(view.complete).toBe(true);
    expect(view.verdict.label).toBe("TOO FEW COST-COMPARABLE PAIRS");
    expect(view.verdict.answer).toBe("The target did not yield enough paired cost observations.");
    expect(view.verdict.claim).toContain("censored pairs were not imputed");
    expect(view.verdict.claim).toContain("not encoded as zero");
  });

  it("keeps an isolated-direction descriptive signal subordinate to a failed all-attempt integrity audit", () => {
    const payload = fixedQualityPayload();
    const invalidReason = {
      code: "exhausted_target_block_retry",
      detail: "A retained isolated attempt exhausted a target-block retry.",
      trial: 10,
      condition: "isolated",
      attempt: 1,
      runId: "isolated-10",
    };
    payload.summary.status = "incomplete";
    payload.summary.aggregate.validPairs = 9;
    payload.summary.trials = Array.from({ length: 10 }, (_, index) => {
      const trial = fixedTrial(index + 1, index === 9 ? "invalid" : "both_reached");
      trial.attemptIntegrity = {
        protocol: "protein-comparison-pair-integrity/v1",
        attempts: 2,
        auditedAttempts: 2,
        assessedAttempts: 2,
        allAttemptsAudited: true,
        validForPair: index !== 9,
        reasons: index === 9 ? [invalidReason] : [],
      };
      if (index !== 9) {
        trial.fixedQuality.primaryOutcome = "isolated";
        trial.fixedQuality.localVsIsolatedPct.responsesTokens = 12;
      }
      return trial;
    });
    const descriptiveValues = Array(9).fill(12);
    const tokenDistribution = payload.summary.aggregate.fixedQuality.localVsIsolatedPct.responsesTokens;
    Object.assign(tokenDistribution, {
      values: descriptiveValues,
      median: 12,
      minimum: 12,
      maximum: 12,
      directionCounts: { localLower: 0, isolatedLower: 9, equal: 0 },
      interval95: { lower: 10, upper: 14, method: "paired_percentile_bootstrap_median", samples: 10000, seed: "fixture:isolated" },
    });
    Object.assign(payload.summary.aggregate.fixedQuality, {
      attainment: {
        local: { reached: 9, total: 9, ratePct: 100 },
        isolated: { reached: 9, total: 9, ratePct: 100 },
        pairs: { bothReached: 9, localOnly: 0, isolatedOnly: 0, neitherReached: 0, invalid: 1 },
      },
      comparablePairs: 9,
      localWins: 0,
      isolatedWins: 9,
      ties: 0,
      exactOneSidedSignTest: {
        nonTiedPairs: 9,
        localWins: 0,
        isolatedWins: 9,
        pValue: 1,
        alpha: 0.05,
        local: { wins: 0, pValue: 1 },
        isolated: { wins: 9, pValue: 0.00195313 },
      },
      attemptIntegrity: {
        protocol: "protein-comparison-attempt-integrity/v1",
        attempts: 20,
        auditedAttempts: 20,
        assessedAttempts: 20,
        allAttemptsAudited: true,
        invalidPairs: 1,
        invalidAttempts: 1,
        validForClaim: false,
        reasonCounts: { exhausted_target_block_retry: 1 },
        reasons: [invalidReason],
      },
      conclusion: {
        code: "incomplete",
        headline: "The fixed-quality comparison is incomplete.",
        detail: "1 planned pair failed retained-attempt integrity; see the surfaced audit reasons.",
      },
    });

    const view = comparisonView(payload);

    expect(view.complete).toBe(false);
    expect(view.verdict).toMatchObject({
      label: "CONFIRMATORY EVIDENCE INCOMPLETE",
      answer: "No confirmatory conclusion.",
    });
    expect(view.verdict.claim).toContain("1 planned pair failed retained-attempt integrity");
    expect(view.verdict.claim).toContain("Descriptive results from 9 valid pairs");
    expect(view.fixedQuality.integrity).toMatchObject({
      validPairs: 9,
      invalidPairs: 1,
      invalidAttempts: 1,
      validForClaim: false,
      allAttemptsAudited: true,
    });
    expect(view.fixedQuality.resources[0].distribution).toMatchObject({
      values: descriptiveValues,
      median: 12,
      minimum: 12,
      maximum: 12,
    });
    expect(view.fixedQuality.signTests).toMatchObject({
      local: { wins: 0, pValue: 1 },
      isolated: { wins: 9, pValue: 0.00195313 },
    });
    expect(view.headlineFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Attempt integrity", value: "9 / 10 valid" }),
      expect.objectContaining({ label: "Median token delta", value: "+12%" }),
      expect.objectContaining({ label: "Local-direction sign test", value: "p = 1" }),
      expect.objectContaining({ label: "Isolated-direction sign test", value: "p = 0.00195313", detail: expect.stringContaining("descriptive only") }),
    ]));
    expect(view.efficiency.text).toContain("Confirmatory integrity is incomplete");
    expect(view.efficiency.text).toContain("exhausted target-block retry");
    expect(view.trials[9].attemptIntegrity).toMatchObject({
      validForPair: false,
      reasons: [{ code: "exhausted_target_block_retry", condition: "isolated", attempt: 1 }],
    });
    expect(view.trials[9].fixedQuality.costAtTarget).toEqual({ local: null, isolated: null });
  });
});

function fixedQualityPayload() {
  const distribution = (values, median, minimum, maximum, interval = null) => ({
    values,
    median,
    minimum,
    maximum,
    directionCounts: { localLower: values.filter((value) => value < 0).length, isolatedLower: values.filter((value) => value > 0).length, equal: values.filter((value) => value === 0).length },
    interval95: interval,
  });
  const tokenValues = Array(10).fill(-20);
  return {
    summary: {
      schemaVersion: 2,
      comparisonId: "fixed-quality-1",
      status: "passed",
      evidenceLevel: "celld-comparison",
      completedAt: "2026-08-09T20:00:00.000Z",
      config: {
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        benchmarkId: "fixture/v3",
        evaluatorVersion: "evaluator/v3",
        objective: "cost_to_fixed_verified_quality",
        primaryResource: "responsesTokens",
        conditions: ["local", "isolated"],
        rows: 4,
        columns: 4,
        generations: 4,
        trials: 10,
        creditsPerCell: 24,
        maxModelTurns: 4,
        maxToolCalls: 3,
        order: "alternating",
        qualityTargetMultiplier: 3,
        qualityTargetRechecks: 9,
        qualityTargetRequiredRatios: 8,
        qualityTargetBlockSize: 4,
        qualityTargetMaximumBaselineDrift: 1.15,
        meaningfulCostDeltaPct: 5,
        minimumComparablePairs: 6,
        alpha: 0.05,
      },
      trials: Array.from({ length: 10 }, (_, index) => fixedTrial(index + 1, "both_reached")),
      aggregate: {
        pairs: 10,
        validPairs: 10,
        equalBudgetVerified: true,
        globalControlsVerified: true,
        fixedQuality: {
          attainment: {
            local: { reached: 10, total: 10, ratePct: 100 },
            isolated: { reached: 10, total: 10, ratePct: 100 },
            pairs: { bothReached: 10, localOnly: 0, isolatedOnly: 0, neitherReached: 0, invalid: 0 },
          },
          comparablePairs: 10,
          localWins: 10,
          isolatedWins: 0,
          ties: 0,
          exactOneSidedSignTest: { nonTiedPairs: 10, localWins: 10, pValue: 0.00097656, alpha: 0.05 },
          localVsIsolatedPct: {
            responsesTokens: distribution(tokenValues, -20, -20, -20, { lower: -24, upper: -16, method: "paired_percentile_bootstrap_median", samples: 10000, seed: "fixture:tokens" }),
            modelTurns: distribution(Array(10).fill(-12.5), -12.5, -12.5, -12.5),
            toolExecutions: distribution(Array(10).fill(-20), -20, -20, -20),
            publicChecks: distribution(Array(10).fill(-25), -25, -25, -25),
            evaluations: distribution(Array(10).fill(-10), -10, -10, -10),
            creditsSpent: distribution(Array(10).fill(-8), -8, -8, -8),
            elapsedMs: distribution(Array(10).fill(-16), -16, -16, -16),
          },
          noAmbiguousUsage: true,
          conclusion: {
            code: "lower_cost_supported",
            headline: "Local exchange reached the fixed quality target with lower recorded token cost.",
            detail: "Median paired Responses-token cost was 20% lower across 10 cost-comparable pairs; the one-sided sign-test p-value was 0.000977.",
          },
        },
      },
      claimBoundary: "One fixed target under one benchmark and protocol.",
    },
    lineage: { runs: [], collectionErrors: [] },
  };
}

function fixedTrial(trialNumber, outcome) {
  const localReached = ["both_reached", "local_only"].includes(outcome);
  const isolatedReached = ["both_reached", "isolated_only"].includes(outcome);
  const valid = outcome !== "invalid";
  const local = fixedRun(`local-${trialNumber}`, localReached, 800, valid);
  const isolated = fixedRun(`isolated-${trialNumber}`, isolatedReached, 1000, valid);
  return {
    trial: trialNumber,
    order: trialNumber % 2 === 1 ? ["local", "isolated"] : ["isolated", "local"],
    conditions: { local, isolated },
    complete: true,
    valid,
    controlChecks: [{ field: "model", local: "gpt-5.6-luna", isolated: "gpt-5.6-luna", equal: true }],
    fixedQuality: {
      outcome,
      costComparable: outcome === "both_reached",
      primaryOutcome: outcome === "local_only" ? "local" : outcome === "isolated_only" ? "isolated" : outcome === "both_reached" ? "local" : "tie",
      localVsIsolatedPct: {
        responsesTokens: outcome === "both_reached" ? -20 : null,
        modelTurns: outcome === "both_reached" ? -12.5 : null,
        toolExecutions: outcome === "both_reached" ? -20 : null,
        publicChecks: outcome === "both_reached" ? -25 : null,
        evaluations: outcome === "both_reached" ? -10 : null,
        creditsSpent: outcome === "both_reached" ? -8 : null,
        elapsedMs: outcome === "both_reached" ? -16 : null,
      },
    },
  };
}

function fixedRun(runId, reached, responsesTokens, valid) {
  return {
    ...run(runId, 44000, 500000, 40, 0, 60, [20000, 35000, 44000, 45000]),
    target: {
      protocol: "protein-fixed-quality-recheck/v1",
      valid,
      reached: valid && reached,
      state: valid ? reached ? "reached" : "not_reached" : "invalid",
      multiplier: 3,
      rechecksPerCandidate: 9,
      requiredPassingRatios: 8,
      requiredCorrectnessPasses: 9,
      blockSize: 4,
      maximumBaselineDriftRatio: 1.15,
      firstReachedGeneration: valid && reached ? 3 : null,
      medianRatio: valid && reached ? 3.2 : null,
      boundary: {
        responsesTokens,
        modelTurns: responsesTokens === 800 ? 70 : 80,
        toolExecutions: responsesTokens === 800 ? 32 : 40,
        publicChecks: 20,
        evaluations: 10,
        creditsSpent: 60,
        elapsedMs: responsesTokens === 800 ? 42000 : 50000,
      },
      censoring: valid && !reached ? { reason: "generation_cap", generation: 4 } : null,
      measurementEvaluations: 90,
      measurementElapsedMs: 10000,
    },
  };
}

function pairedPayload() {
  return {
    summary: {
      schemaVersion: 1,
      comparisonId: "comparison-1",
      status: "passed",
      evidenceLevel: "celld-comparison",
      completedAt: "2026-08-09T18:00:00.000Z",
      config: {
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        benchmarkId: "fixture/v3",
        evaluatorVersion: "evaluator/v3",
        conditions: ["local", "isolated"],
        rows: 2,
        columns: 2,
        generations: 2,
        trials: 2,
        creditsPerCell: 24,
        maxModelTurns: 4,
        maxToolCalls: 3,
        order: "alternating",
        meaningfulThresholdPct: 5,
      },
      trials: [
        trial(1, {
          local: run("local-1", 120, 1200, 5, 0, 44, [100, 120]),
          isolated: run("isolated-1", 100, 900, 4, 1, 42, [95, 100]),
          uplift: { absolute: 20, percent: 20 },
        }),
        trial(2, {
          local: run("local-2", 110, 1000, 4, 1, 41, [90, 110]),
          isolated: run("isolated-2", 100, 1100, 4, 2, 42, [92, 100]),
          uplift: { absolute: 10, percent: 10 },
        }),
      ],
      aggregate: {
        pairs: 2,
        passedPairs: 2,
        localWins: 2,
        isolatedWins: 0,
        ties: 0,
        equalBudgetVerified: true,
        pairedUpliftPct: { values: [20, 10], median: 15, minimum: 10, maximum: 20 },
        efficiency: {
          interpretation: "Negative percentages mean local used less than its matched isolated run.",
          localVsIsolatedPct: {
            tokens: { values: [-6, -8], median: -7, minimum: -8, maximum: -6 },
            modelTurns: { values: [-20, -22], median: -21, minimum: -22, maximum: -20 },
            toolExecutions: { values: [-30, -32], median: -31, minimum: -32, maximum: -30 },
            evaluations: { values: [-50, -40], median: -45, minimum: -50, maximum: -40 },
            creditsSpent: { values: [-18, -22], median: -20, minimum: -22, maximum: -18 },
            elapsedMs: { values: [-20, -27.6], median: -23.8, minimum: -27.6, maximum: -20 },
          },
        },
        conclusion: {
          code: "observed_local_advantage",
          headline: "Neighbor exchange helped in this exploratory comparison.",
          detail: "Local won both matched pairs.",
        },
      },
      claimBoundary: "Two matched pilot pairs; not a population-level estimate.",
    },
    lineage: {
      runs: [{
        trial: 1,
        condition: "local",
        runId: "local-1",
        generations: [{
          generation: 1,
          cells: 4,
          candidates: 3,
          adoptions: 0,
          leader: {
            candidateId: "sha256:abcdef",
            strategy: "ordered fast path",
            score: 100,
            holders: 1,
            adoptedBy: 0,
            originAgent: "run-r01c00",
          },
        }],
      }],
      collectionErrors: [],
    },
  };
}

function trial(trialNumber, { local, isolated, uplift }) {
  return {
    trial: trialNumber,
    order: trialNumber % 2 === 1 ? ["local", "isolated"] : ["isolated", "local"],
    conditions: { local, isolated },
    complete: true,
    uplift: { absolute: uplift.absolute, percentPoints: uplift.percent },
    outcome: "local",
    budgetChecks: [{ field: "model", local: "gpt-5.6-luna", isolated: "gpt-5.6-luna", equal: true }],
  };
}

function run(runId, bestScore, tokens, tools, fallbacks, creditsSpent, generationScores) {
  return {
    runId,
    status: "passed",
    summaryPath: `/evidence/${runId}/summary.json`,
    seedScore: 80,
    bestScore,
    gain: bestScore - 80,
    gainPct: (bestScore - 80) / 80 * 100,
    tokens,
    modelTurns: 5,
    toolExecutions: tools,
    evaluations: 4,
    elapsedMs: 10000,
    fallbacks,
    generationMetrics: generationScores.map((score, index) => ({ generation: index + 1, bestScore: score })),
    creditsSpent,
    model: "gpt-5.6-luna",
    benchmarkId: "fixture/v3",
  };
}
