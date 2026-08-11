import { describe, expect, it } from "vitest";
import {
  buildAttemptIntegrityAudit,
  buildComparisonSummary,
  buildFixedQualityComparisonSummary,
  projectSwarmRun,
} from "../scripts/swarm-comparison.mjs";

describe("paired celld swarm comparison", () => {
  it("projects measured run usage, seed-relative gain, and fallback evidence", () => {
    const projected = projectSwarmRun({
      summary: summaryFixture({ condition: "local", bestScore: 110, fallbacks: 2 }),
      manifest: manifestFixture({ condition: "local" }),
      seed: { score: 100 },
      summaryPath: "/evidence/local/summary.json",
    });

    expect(projected).toMatchObject({
      condition: "local",
      celldVersion: "celld 0.1.0",
      promptVersion: "protein-swarm-code-agent/v2",
      toolSchemaVersion: "protein-swarm-tools/v2",
      model: "gpt-5.6-luna",
      benchmarkId: "sorted-unique-int32/v3",
      seedScore: 100,
      bestScore: 110,
      gain: 10,
      gainPct: 10,
      tokens: 1000,
      modelTurns: 12,
      toolExecutions: 5,
      evaluations: 4,
      fallbacks: 2,
      totalCredits: 384,
      creditsSpent: 24,
    });
  });

  it("derives neighbor-improvement lineage from authoritative evaluator parents and board generations", () => {
    const summary = summaryFixture({ condition: "local", bestScore: 120, fallbacks: 0 });
    summary.experiment.generations = 2;
    const projected = projectSwarmRun({
      summary,
      manifest: manifestFixture({ condition: "local" }),
      seed: { score: 100 },
      summaryPath: "/evidence/local/summary.json",
      serviceSnapshots: {
        evaluator: {
          evidence: {
            seed: { candidateId: "seed", agent: "board", generation: 0, parentCandidateIds: [] },
            first: { candidateId: "candidate-a", agent: "cell-a", generation: 1, parentCandidateIds: ["seed"] },
            second: { candidateId: "candidate-b", agent: "cell-b", generation: 2, parentCandidateIds: ["candidate-a"] },
          },
        },
        board: {
          submissions: {
            a1: { result: { agent: "cell-a", generation: 1, candidateId: "candidate-a", behavior: "improve" } },
            b1: { result: { agent: "cell-b", generation: 1, candidateId: "seed", behavior: "wait" } },
            a2: { result: { agent: "cell-a", generation: 2, candidateId: "candidate-a", behavior: "wait" } },
            b2: { result: { agent: "cell-b", generation: 2, candidateId: "candidate-b", behavior: "improve" } },
          },
        },
      },
    });

    expect(projected.lineage).toMatchObject({
      finalDiversity: 2,
      improvements: 2,
      waits: 2,
      neighborDerivedImprovements: 1,
      maxDepth: 2,
    });
  });

  it("accepts only target ledgers that reconcile identity, panel, boundary, and reach state", () => {
    const summary = summaryFixture({ condition: "local", bestScore: 120, fallbacks: 0 });
    summary.experimentId = "run-local";
    const manifest = manifestFixture({ condition: "local" });
    manifest.qualityTarget = qualityTargetManifestFixture();
    const ledger = qualityTargetLedgerFixture();
    const valid = projectSwarmRun({
      summary,
      manifest,
      seed: { score: 100 },
      qualityTarget: ledger,
      summaryPath: "/evidence/local/summary.json",
    });

    expect(valid.target).toMatchObject({ valid: true, reached: true, state: "reached", validationErrors: [] });

    const tampered = structuredClone(ledger);
    tampered.condition = "isolated";
    tampered.firstReach.generation = 9;
    const invalid = projectSwarmRun({
      summary,
      manifest,
      seed: { score: 100 },
      qualityTarget: tampered,
      summaryPath: "/evidence/local/summary.json",
    });
    expect(invalid.target.valid).toBe(false);
    expect(invalid.target.state).toBe("invalid");
    expect(invalid.target.validationErrors).toEqual(expect.arrayContaining([
      "target ledger identity does not match the run",
      "target reach generation is outside the configured run",
    ]));
  });

  it("calls an advantage only when paired runs pass equal-budget controls and clear the threshold", () => {
    const trials = [1, 2, 3].map((trial) => ({
      trial,
      order: trial % 2 ? ["local", "isolated"] : ["isolated", "local"],
      conditions: {
        local: runProjection({
          condition: "local",
          gainPct: 8 + trial,
          tokens: 800,
          elapsedMs: 8_000,
          modelTurns: 8,
          toolExecutions: 4,
          evaluations: 2,
        }),
        isolated: runProjection({ condition: "isolated", gainPct: 2 + trial }),
      },
    }));
    const result = buildComparisonSummary({
      comparisonId: "comparison-1",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config: configFixture(),
      trials,
    });

    expect(result.status).toBe("passed");
    expect(result.aggregate).toMatchObject({
      passedPairs: 3,
      equalBudgetVerified: true,
      localWins: 3,
      isolatedWins: 0,
      ties: 0,
      conclusion: { code: "observed_local_advantage" },
    });
    expect(result.aggregate.pairedUpliftPct.median).toBe(6);
    expect(result.aggregate.efficiency.localVsIsolatedPct).toMatchObject({
      tokens: { median: -20 },
      elapsedMs: { median: -20 },
      modelTurns: { median: -20 },
      toolExecutions: { median: -20 },
      evaluations: { median: -50 },
    });
  });

  it("refuses a comparative claim when a frozen control differs", () => {
    const local = runProjection({ condition: "local", gainPct: 7 });
    const isolated = runProjection({ condition: "isolated", gainPct: 1, model: "different-model" });
    const result = buildComparisonSummary({
      comparisonId: "comparison-invalid",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config: { ...configFixture(), trials: 1 },
      trials: [{ trial: 1, order: ["local", "isolated"], conditions: { local, isolated } }],
    });

    expect(result.status).toBe("incomplete");
    expect(result.aggregate.equalBudgetVerified).toBe(false);
    expect(result.aggregate.conclusion.code).toBe("invalid_control");
  });

  it("refuses a comparative claim when a required control is missing from both runs", () => {
    const local = runProjection({ condition: "local", gainPct: 7, toolSchemaSha256: null });
    const isolated = runProjection({ condition: "isolated", gainPct: 1, toolSchemaSha256: null });
    const result = buildComparisonSummary({
      comparisonId: "comparison-missing-control",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config: { ...configFixture(), trials: 1 },
      trials: [{ trial: 1, order: ["local", "isolated"], conditions: { local, isolated } }],
    });

    expect(result.status).toBe("incomplete");
    expect(result.aggregate.equalBudgetVerified).toBe(false);
    expect(result.trials[0].budgetChecks).toContainEqual({
      field: "toolSchemaSha256",
      local: null,
      isolated: null,
      equal: false,
    });
  });

  it("reports an incomplete comparison when a condition fails", () => {
    const local = runProjection({ condition: "local", gainPct: 7 });
    const isolated = runProjection({ condition: "isolated", gainPct: null, status: "failed" });
    const result = buildComparisonSummary({
      comparisonId: "comparison-failed",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config: { ...configFixture(), trials: 1 },
      trials: [{ trial: 1, order: ["local", "isolated"], conditions: { local, isolated } }],
    });

    expect(result.status).toBe("incomplete");
    expect(result.aggregate.passedPairs).toBe(0);
    expect(result.aggregate.conclusion.code).toBe("incomplete");
  });

  it("supports lower fixed-quality token cost only from valid double-reaching pairs", () => {
    const trials = Array.from({ length: 10 }, (_, index) => ({
      trial: index + 1,
      order: index % 2 === 0 ? ["local", "isolated"] : ["isolated", "local"],
      conditions: {
        local: runProjection({
          condition: "local",
          target: targetProjection({ reached: true, responsesTokens: 800 }),
        }),
        isolated: runProjection({
          condition: "isolated",
          target: targetProjection({ reached: true, responsesTokens: 1000 }),
        }),
      },
    }));
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-1",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config: costConfigFixture(),
      trials,
    });

    expect(result.status).toBe("passed");
    expect(result.aggregate.fixedQuality).toMatchObject({
      comparablePairs: 10,
      localWins: 10,
      isolatedWins: 0,
      noAmbiguousUsage: true,
      conclusion: { code: "lower_cost_supported" },
      localVsIsolatedPct: {
        responsesTokens: {
          median: -20,
          directionCounts: { localLower: 10, isolatedLower: 0, equal: 0 },
        },
      },
    });
    expect(result.aggregate.fixedQuality.exactOneSidedSignTest.pValue).toBeCloseTo(0.00097656, 8);
    expect(result.aggregate.fixedQuality.exactOneSidedSignTest.local.pValue).toBeCloseTo(0.00097656, 8);
    expect(result.aggregate.fixedQuality.exactOneSidedSignTest.isolated.pValue).toBe(1);
    expect(result.aggregate.fixedQuality.localVsIsolatedPct.responsesTokens.interval95.upper).toBe(-20);
  });

  it("exposes exact one-sided sign-test p-values in both directions", () => {
    const trials = Array.from({ length: 10 }, (_, index) => ({
      trial: index + 1,
      order: index % 2 === 0 ? ["local", "isolated"] : ["isolated", "local"],
      conditions: {
        local: runProjection({
          condition: "local",
          target: targetProjection({ reached: true, responsesTokens: 1000 }),
        }),
        isolated: runProjection({
          condition: "isolated",
          target: targetProjection({ reached: true, responsesTokens: 800 }),
        }),
      },
    }));
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-isolated-direction",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config: costConfigFixture(),
      trials,
    });

    expect(result.aggregate.fixedQuality.exactOneSidedSignTest).toMatchObject({
      nonTiedPairs: 10,
      localWins: 0,
      isolatedWins: 10,
      pValue: 1,
      local: { wins: 0, pValue: 1 },
      isolated: { wins: 10 },
    });
    expect(result.aggregate.fixedQuality.exactOneSidedSignTest.isolated.pValue)
      .toBeCloseTo(0.00097656, 8);
    expect(result.aggregate.fixedQuality.conclusion.code).toBe("higher_cost_supported");
  });

  it("derives ambiguity and exhausted same-block retry reasons from retained raw attempt evidence", () => {
    const summary = summaryFixture({ condition: "isolated", bestScore: 120, fallbacks: 0 });
    summary.status = "failed";
    summary.services = null;
    const audit = buildAttemptIntegrityAudit({
      summary,
      modelGatewayPrivateState: {
        metrics: {
          providerRequests: 12,
          ambiguousProviderAttempts: 1,
          usage: { totalTokens: 1234 },
        },
      },
      qualityTarget: {
        valid: false,
        blockAttempts: [
          { repeat: 7, block: 6, attempt: 1, baselineValid: false, baselineDriftRatio: 1.21 },
          { repeat: 7, block: 6, attempt: 2, baselineValid: false, baselineDriftRatio: 1.28 },
          { repeat: 8, block: 1, attempt: 1, baselineValid: false, baselineDriftRatio: 1.16 },
          { repeat: 8, block: 1, attempt: 2, baselineValid: true, baselineDriftRatio: 1.01 },
        ],
      },
    });

    expect(audit).toMatchObject({
      assessed: true,
      postDiscoveryEvidence: true,
      ambiguityAssessed: true,
      ambiguousProviderAttempts: 1,
      exhaustedTargetBlocks: [{
        repeat: 7,
        block: 6,
        failedAttempts: [1, 2],
        baselineDriftRatios: [1.21, 1.28],
      }],
      validForPair: false,
    });
    expect(audit.reasons.map((reason) => reason.code)).toEqual([
      "ambiguous_provider_attempt",
      "exhausted_target_block_retry",
    ]);
  });

  it("invalidates only the affected pair when a retained attempt has ambiguous usage", () => {
    const config = { ...costConfigFixture(), trials: 1, minimumComparablePairs: 1 };
    const integrityAudit = buildAttemptIntegrityAudit({
      modelGatewayPrivateState: {
        metrics: {
          providerRequests: 12,
          ambiguousProviderAttempts: 1,
          usage: { totalTokens: 1234 },
        },
      },
    });
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-ambiguous-attempt",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config,
      trials: [fixedQualityTrialFixture(1)],
      attempts: [{
        trial: 1,
        condition: "isolated",
        attempt: 1,
        runId: "failed-isolated-attempt",
        status: "failed",
        integrityAudit,
      }],
    });

    expect(result.status).toBe("incomplete");
    expect(result.aggregate.validPairs).toBe(0);
    expect(result.trials[0]).toMatchObject({
      valid: false,
      attemptIntegrity: {
        attempts: 1,
        auditedAttempts: 1,
        allAttemptsAudited: true,
        validForPair: false,
      },
      fixedQuality: {
        outcome: "invalid",
        primaryReason: "attempt_integrity_failure",
      },
    });
    expect(result.trials[0].attemptIntegrity.reasons[0]).toMatchObject({
      trial: 1,
      condition: "isolated",
      attempt: 1,
      runId: "failed-isolated-attempt",
      code: "ambiguous_provider_attempt",
    });
    expect(result.aggregate.fixedQuality).toMatchObject({
      noAmbiguousUsage: false,
      attemptIntegrity: {
        invalidPairs: 1,
        invalidAttempts: 1,
        validForClaim: false,
        reasonCounts: { ambiguous_provider_attempt: 1 },
      },
      conclusion: { code: "ambiguous_usage" },
    });
  });

  it("invalidates a pair for an exhausted target block even without ambiguous usage", () => {
    const config = { ...costConfigFixture(), trials: 1, minimumComparablePairs: 1 };
    const integrityAudit = buildAttemptIntegrityAudit({
      modelGatewayPrivateState: {
        metrics: {
          providerRequests: 12,
          ambiguousProviderAttempts: 0,
          usage: { totalTokens: 1234 },
        },
      },
      qualityTarget: {
        valid: false,
        blockAttempts: [
          { repeat: 2, block: 3, attempt: 1, baselineValid: false, baselineDriftRatio: 1.2 },
          { repeat: 2, block: 3, attempt: 2, baselineValid: false, baselineDriftRatio: 1.3 },
        ],
      },
    });
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-exhausted-block",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config,
      trials: [fixedQualityTrialFixture(1)],
      attempts: [{
        trial: 1,
        condition: "local",
        attempt: 1,
        runId: "failed-local-attempt",
        status: "failed",
        integrityAudit,
      }],
    });

    expect(result.trials[0].valid).toBe(false);
    expect(result.aggregate.fixedQuality.noAmbiguousUsage).toBe(true);
    expect(result.aggregate.fixedQuality.attemptIntegrity.reasonCounts)
      .toEqual({ exhausted_target_block_retry: 1 });
    expect(result.aggregate.fixedQuality.conclusion.code).toBe("incomplete");
  });

  it("invalidates a target ledger that is invalid without a reconstructable exhausted block", () => {
    const audit = buildAttemptIntegrityAudit({
      modelGatewayPrivateState: {
        metrics: {
          providerRequests: 10,
          ambiguousProviderAttempts: 0,
          usage: { totalTokens: 1000 },
        },
      },
      qualityTarget: {
        valid: false,
        blockAttempts: [{
          repeat: 1,
          block: 1,
          attempt: 1,
          baselineValid: false,
          baselineDriftRatio: 1.2,
        }],
      },
    });

    expect(audit.validForPair).toBe(false);
    expect(audit.exhaustedTargetBlocks).toEqual([]);
    expect(audit.reasons).toEqual([expect.objectContaining({
      code: "invalid_target_ledger",
    })]);
  });

  it("invalidates an early operational attempt without authoritative provider evidence", () => {
    const config = { ...costConfigFixture(), trials: 1, minimumComparablePairs: 1 };
    const summary = summaryFixture({ condition: "local", bestScore: 100, fallbacks: 0 });
    summary.status = "failed";
    summary.services = null;
    summary.experiment.generationMetrics = [];
    const integrityAudit = buildAttemptIntegrityAudit({ summary });
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-early-failure",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config,
      trials: [fixedQualityTrialFixture(1)],
      attempts: [{
        trial: 1,
        condition: "local",
        attempt: 1,
        runId: "early-local-attempt",
        status: "failed",
        integrityAudit,
      }],
    });

    expect(integrityAudit).toMatchObject({
      assessed: true,
      postDiscoveryEvidence: false,
      ambiguityAssessed: false,
      ambiguousProviderAttempts: null,
      providerEvidenceAssessed: false,
      validForPair: false,
    });
    expect(integrityAudit.reasons.map((reason) => reason.code)).toEqual([
      "missing_provider_evidence",
    ]);
    expect(result.status).toBe("incomplete");
    expect(result.trials[0].attemptIntegrity).toMatchObject({
      validForPair: false,
      allAttemptsAudited: true,
    });
  });

  it("accepts an early operational attempt with explicit zero provider activity", () => {
    const config = { ...costConfigFixture(), trials: 1, minimumComparablePairs: 1 };
    const integrityAudit = buildAttemptIntegrityAudit({
      modelGatewayPrivateState: {
        metrics: {
          providerRequests: 0,
          ambiguousProviderAttempts: 0,
          usage: { totalTokens: 0 },
        },
      },
    });
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-pre-provider-failure",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config,
      trials: [fixedQualityTrialFixture(1)],
      attempts: [{
        trial: 1,
        condition: "local",
        attempt: 1,
        runId: "pre-provider-local-attempt",
        status: "failed",
        integrityAudit,
      }],
    });

    expect(integrityAudit).toMatchObject({
      assessed: true,
      providerEvidenceAssessed: true,
      recordedResponsesTokens: 0,
      ambiguousProviderAttempts: 0,
      validForPair: true,
      reasons: [],
    });
    expect(result.status).toBe("passed");
  });

  it("invalidates post-discovery attempts that lack final ambiguity and usage evidence", () => {
    const summary = summaryFixture({ condition: "isolated", bestScore: 120, fallbacks: 0 });
    summary.status = "failed";
    summary.services = null;
    summary.experiment.generationMetrics = Array.from({ length: 4 }, (_, index) => ({
      generation: index + 1,
    }));
    const audit = buildAttemptIntegrityAudit({ summary });

    expect(audit).toMatchObject({
      postDiscoveryEvidence: true,
      ambiguityAssessed: false,
      providerUsageAssessed: false,
      validForPair: false,
    });
    expect(audit.reasons.map((reason) => reason.code)).toEqual([
      "missing_ambiguity_evidence",
      "missing_provider_usage",
    ]);
  });

  it("invalidates an attempt whose retained identity does not match its run bundle", () => {
    const summary = summaryFixture({ condition: "isolated", bestScore: 120, fallbacks: 0 });
    const manifest = manifestFixture({ condition: "isolated" });
    manifest.runId = summary.runId;
    manifest.experimentId = summary.runId;
    manifest.comparison = {
      comparisonId: "comparison-expected",
      trialIndex: 2,
      conditionOrder: "isolated-first",
    };
    const audit = buildAttemptIntegrityAudit({
      attempt: {
        runId: "different-run",
        trial: 2,
        condition: "isolated",
        order: ["isolated", "local"],
      },
      comparisonId: "comparison-expected",
      summary,
      manifest,
    });

    expect(audit.validForPair).toBe(false);
    expect(audit.reasons[0]).toMatchObject({
      code: "attempt_identity_mismatch",
      mismatches: expect.arrayContaining([
        expect.objectContaining({ field: "summary.runId", expected: "different-run" }),
        expect.objectContaining({ field: "manifest.runId", expected: "different-run" }),
      ]),
    });
  });

  it("requires complete attempt-audit coverage once retained-attempt auditing is active", () => {
    const config = { ...costConfigFixture(), trials: 1, minimumComparablePairs: 1 };
    const cleanAudit = buildAttemptIntegrityAudit({
      modelGatewayPrivateState: {
        metrics: {
          providerRequests: 0,
          ambiguousProviderAttempts: 0,
          usage: { totalTokens: 0 },
        },
      },
    });
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-partial-audit",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config,
      trials: [fixedQualityTrialFixture(1)],
      attempts: [{
        trial: 1,
        condition: "local",
        attempt: 1,
        runId: "audited-attempt",
        integrityAudit: cleanAudit,
      }, {
        trial: 1,
        condition: "isolated",
        attempt: 1,
        runId: "legacy-unaudited-attempt",
      }],
    });

    expect(result.status).toBe("incomplete");
    expect(result.trials[0].attemptIntegrity).toMatchObject({
      auditEnforced: true,
      allAttemptsAudited: false,
      validForPair: false,
    });
    expect(result.aggregate.fixedQuality.attemptIntegrity).toMatchObject({
      allAttemptsAudited: false,
      validForClaim: false,
      reasonCounts: { missing_attempt_integrity_audit: 1 },
    });
  });

  it("invalidates an unassessed retained attempt once audit enforcement is active", () => {
    const config = { ...costConfigFixture(), trials: 1, minimumComparablePairs: 1 };
    const unassessedAudit = buildAttemptIntegrityAudit();
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-unassessed-attempt",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config,
      trials: [fixedQualityTrialFixture(1)],
      attempts: [{
        trial: 1,
        condition: "local",
        attempt: 1,
        runId: null,
        status: "failed",
        integrityAudit: unassessedAudit,
      }],
    });

    expect(unassessedAudit).toMatchObject({
      assessed: false,
      validForPair: false,
    });
    expect(unassessedAudit.reasons.map((reason) => reason.code)).toEqual([
      "unassessed_attempt_integrity",
    ]);
    expect(result.status).toBe("incomplete");
    expect(result.trials[0].attemptIntegrity).toMatchObject({
      auditEnforced: true,
      allAttemptsAudited: true,
      validForPair: false,
    });
    expect(result.aggregate.fixedQuality.attemptIntegrity.reasonCounts)
      .toEqual({ unassessed_attempt_integrity: 1 });
  });

  it("rejects protocol drift across pairs even when every pair matches internally", () => {
    const trials = Array.from({ length: 10 }, (_, index) => {
      const promptVersion = index === 4 ? "protein-swarm-code-agent/drift" : "protein-swarm-code-agent/v2";
      return {
        trial: index + 1,
        order: index % 2 === 0 ? ["local", "isolated"] : ["isolated", "local"],
        conditions: {
          local: runProjection({
            condition: "local",
            promptVersion,
            target: targetProjection({ reached: true, responsesTokens: 800 }),
          }),
          isolated: runProjection({
            condition: "isolated",
            promptVersion,
            target: targetProjection({ reached: true, responsesTokens: 1000 }),
          }),
        },
      };
    });
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-global-drift",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config: costConfigFixture(),
      trials,
    });

    expect(result.trials.every((trial) => trial.controlChecks.every((check) => check.equal))).toBe(true);
    expect(result.aggregate.equalBudgetVerified).toBe(true);
    expect(result.aggregate.globalControlsVerified).toBe(false);
    expect(result.aggregate.globalControls.checks.find((check) => check.field === "promptVersion")?.equal).toBe(false);
    expect(result.status).toBe("incomplete");
    expect(result.aggregate.fixedQuality.conclusion.code).toBe("invalid_control");
  });

  it("rejects equally wrong target controls against the frozen comparison config", () => {
    const config = { ...costConfigFixture(), qualityTargetMultiplier: 4 };
    const trials = Array.from({ length: 10 }, (_, index) => ({
      trial: index + 1,
      order: index % 2 === 0 ? ["local", "isolated"] : ["isolated", "local"],
      conditions: {
        local: runProjection({
          condition: "local",
          target: targetProjection({ reached: true, responsesTokens: 800 }),
        }),
        isolated: runProjection({
          condition: "isolated",
          target: targetProjection({ reached: true, responsesTokens: 1000 }),
        }),
      },
    }));
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-wrong-target-config",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config,
      trials,
    });

    expect(result.aggregate.globalControlsVerified).toBe(false);
    expect(result.aggregate.globalControls.checks.find((check) => check.field === "target.multiplier")).toMatchObject({
      expected: 4,
      equal: false,
    });
    expect(result.aggregate.fixedQuality.conclusion.code).toBe("invalid_control");
  });

  it("keeps one-sided target attainment censored out of cost distributions", () => {
    const config = { ...costConfigFixture(), trials: 1, minimumComparablePairs: 1 };
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-censored",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config,
      trials: [{
        trial: 1,
        order: ["local", "isolated"],
        conditions: {
          local: runProjection({ condition: "local", target: targetProjection({ reached: true, responsesTokens: 800 }) }),
          isolated: runProjection({ condition: "isolated", target: targetProjection({ reached: false, responsesTokens: 1200 }) }),
        },
      }],
    });

    expect(result.status).toBe("passed");
    expect(result.trials[0].fixedQuality).toMatchObject({
      outcome: "local_only",
      costComparable: false,
      primaryOutcome: "local",
      primaryReason: "censor_boundary_dominance",
      censoringComparison: {
        winner: "local",
        reachedCost: 800,
        otherCensorBoundary: 1200,
        clearsMeaningfulBand: true,
      },
      localVsIsolatedPct: { responsesTokens: null },
    });
    expect(result.aggregate.fixedQuality.localVsIsolatedPct.responsesTokens.values).toEqual([]);
    expect(result.aggregate.fixedQuality.conclusion.code).toBe("insufficient_comparable_pairs");
  });

  it("does not call a one-sided reach a cost win when its cost exceeds the censor boundary", () => {
    const config = { ...costConfigFixture(), trials: 1, minimumComparablePairs: 1 };
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-censored-indeterminate",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config,
      trials: [{
        trial: 1,
        order: ["local", "isolated"],
        conditions: {
          local: runProjection({ condition: "local", target: targetProjection({ reached: true, responsesTokens: 800 }) }),
          isolated: runProjection({ condition: "isolated", target: targetProjection({ reached: false, responsesTokens: 500 }) }),
        },
      }],
    });

    expect(result.trials[0].fixedQuality).toMatchObject({
      outcome: "local_only",
      primaryOutcome: "tie",
      primaryReason: "censored_cost_indeterminate",
      censoringComparison: {
        winner: "local",
        reachedCost: 800,
        otherCensorBoundary: 500,
        clearsMeaningfulBand: false,
      },
    });
    expect(result.aggregate.fixedQuality).toMatchObject({ localWins: 0, isolatedWins: 0, ties: 1 });
  });

  it("invalidates a target record with a missing discovery-cost field", () => {
    const config = { ...costConfigFixture(), trials: 1, minimumComparablePairs: 1 };
    const incompleteTarget = targetProjection({ reached: true, responsesTokens: 800 });
    delete incompleteTarget.boundary.responsesTokens;
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-missing-usage",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config,
      trials: [{
        trial: 1,
        order: ["local", "isolated"],
        conditions: {
          local: runProjection({ condition: "local", target: incompleteTarget }),
          isolated: runProjection({ condition: "isolated", target: targetProjection({ reached: true, responsesTokens: 1000 }) }),
        },
      }],
    });

    expect(result.status).toBe("incomplete");
    expect(result.trials[0].fixedQuality.outcome).toBe("invalid");
  });

  it("invalidates fixed-quality evidence rather than treating it as non-reach", () => {
    const config = { ...costConfigFixture(), trials: 1, minimumComparablePairs: 1 };
    const invalid = targetProjection({ reached: false, responsesTokens: 1200 });
    invalid.valid = false;
    invalid.state = "invalid";
    const result = buildFixedQualityComparisonSummary({
      comparisonId: "cost-target-invalid",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T01:00:00.000Z",
      config,
      trials: [{
        trial: 1,
        order: ["local", "isolated"],
        conditions: {
          local: runProjection({ condition: "local", target: invalid }),
          isolated: runProjection({ condition: "isolated", target: targetProjection({ reached: false, responsesTokens: 1200 }) }),
        },
      }],
    });

    expect(result.status).toBe("incomplete");
    expect(result.trials[0].fixedQuality.outcome).toBe("invalid");
    expect(result.aggregate.fixedQuality.conclusion.code).toBe("incomplete");
  });
});

function summaryFixture({ condition, bestScore, fallbacks }) {
  return {
    runId: `run-${condition}`,
    status: "passed",
    elapsedMs: 12_000,
    protein: { modelDecisionFallbacks: fallbacks },
    experiment: {
      condition,
      rows: 4,
      columns: 4,
      generations: 4,
      bestScore,
      remainingCredits: 360,
      generationMetrics: [{ generation: 1, bestScore: 100, elapsedMs: 1_000, submissions: 16 }],
    },
    services: {
      modelGateway: {
        protocol: "protein-openai-responses-tools/v1",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        promptVersion: "protein-swarm-code-agent/v2",
        toolSchemaVersion: "protein-swarm-tools/v2",
        toolSchemaSha256: "schema-sha256",
        maxOutputTokens: 1200,
        completedActions: 12,
        providerRetries: 0,
        usage: { totalTokens: 1000, inputTokens: 800, outputTokens: 200, reasoningTokens: 50 },
      },
      toolExecutor: { benchmark: { id: "sorted-unique-int32/v3" }, benchmarkConcurrency: 1, completedActions: 5, publicChecks: 3 },
      evaluator: { evaluatorVersion: "protein-swarm-evaluator/v3", benchmarkConcurrency: 1, completedActions: 4, passedEvaluations: 4 },
    },
    celld: { version: "celld 0.1.0" },
  };
}

function manifestFixture({ condition }) {
  return {
    topology: { condition },
    source: {
      workerBundleSha256: "worker-sha256",
      benchmarkId: "sorted-unique-int32/v3",
      evaluatorVersion: "protein-swarm-evaluator/v3",
      sandbox: { imageId: "sandbox-sha256" },
      modelGateway: {
        protocol: "protein-openai-responses-tools/v1",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        promptVersion: "protein-swarm-code-agent/v2",
        toolSchemaVersion: "protein-swarm-tools/v2",
        toolSchemaSha256: "schema-sha256",
        store: false,
      },
    },
    budget: {
      totalCredits: 384,
      maxModelTurnsPerCellGeneration: 4,
      maxToolCallsPerCellGeneration: 3,
      dispatchConcurrency: 8,
    },
  };
}

function runProjection(overrides = {}) {
  return {
    runId: `run-${overrides.condition}`,
    status: "passed",
    condition: overrides.condition,
    celldVersion: "celld 0.1.0",
    workerBundleSha256: "worker-sha256",
    responsesProtocol: "protein-openai-responses-tools/v1",
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    promptVersion: "protein-swarm-code-agent/v2",
    toolSchemaVersion: "protein-swarm-tools/v2",
    toolSchemaSha256: "schema-sha256",
    modelMaxOutputTokens: 1200,
    providerStore: false,
    benchmarkId: "sorted-unique-int32/v3",
    evaluatorVersion: "protein-swarm-evaluator/v3",
    sandboxImageId: "sandbox-sha256",
    publicBenchmarkConcurrency: 1,
    hiddenBenchmarkConcurrency: 1,
    rows: 4,
    columns: 4,
    generations: 4,
    totalCredits: 384,
    maxModelTurns: 4,
    maxToolCalls: 3,
    dispatchConcurrency: 8,
    providerTimeoutMs: 35_000,
    providerMaximumAttempts: 2,
    ambiguousProviderAttempts: 0,
    gain: overrides.gainPct,
    gainPct: overrides.gainPct,
    bestScore: 100 + (overrides.gainPct ?? 0),
    tokens: 1000,
    elapsedMs: 10_000,
    modelTurns: 10,
    toolExecutions: 5,
    evaluations: 4,
    fallbacks: 0,
    creditsSpent: 20,
    lineage: { neighborDerivedImprovements: 0 },
    ...overrides,
  };
}

function fixedQualityTrialFixture(trial) {
  return {
    trial,
    order: trial % 2 === 0 ? ["isolated", "local"] : ["local", "isolated"],
    conditions: {
      local: runProjection({
        condition: "local",
        target: targetProjection({ reached: true, responsesTokens: 800 }),
      }),
      isolated: runProjection({
        condition: "isolated",
        target: targetProjection({ reached: true, responsesTokens: 1000 }),
      }),
    },
  };
}

function targetProjection({ reached, responsesTokens }) {
  return {
    protocol: "protein-fixed-quality-recheck/v1",
    valid: true,
    reached,
    state: reached ? "reached" : "not_reached",
    multiplier: 3,
    rechecksPerCandidate: 9,
    requiredPassingRatios: 8,
    requiredCorrectnessPasses: 9,
    blockSize: 4,
    maximumBaselineDriftRatio: 1.15,
    firstReachedGeneration: reached ? 3 : null,
    candidateId: reached ? "sha256:target" : null,
    medianRatio: reached ? 3.2 : null,
    passingRatios: reached ? 9 : null,
    boundary: {
      responsesTokens,
      modelTurns: 80,
      toolExecutions: 40,
      publicChecks: 20,
      evaluations: 10,
      creditsSpent: 60,
      elapsedMs: 50_000,
    },
    censoring: reached ? null : { reason: "generation_cap", generation: 4 },
    panelCandidates: 10,
    qualifyingCandidates: reached ? 1 : 0,
    measurementEvaluations: 100,
    measurementElapsedMs: 10_000,
    invalidBlockAttempts: 0,
  };
}

function qualityTargetManifestFixture() {
  return {
    protocol: "protein-fixed-quality-recheck/v1",
    multiplier: 3,
    rechecksPerCandidate: 9,
    requiredPassingRatios: 8,
    requiredCorrectnessPasses: 9,
    blockSize: 4,
    maximumBaselineDriftRatio: 1.15,
  };
}

function qualityTargetLedgerFixture() {
  const boundary = {
    responsesTokens: 800,
    inputTokens: 700,
    outputTokens: 100,
    reasoningTokens: 20,
    modelTurns: 8,
    providerRequests: 8,
    providerRetries: 0,
    ambiguousProviderAttempts: 0,
    toolExecutions: 4,
    publicChecks: 2,
    evaluations: 2,
    passedEvaluations: 2,
    creditsSpent: 12,
    elapsedMs: 9_000,
  };
  return {
    schemaVersion: 1,
    protocol: "protein-fixed-quality-recheck/v1",
    experimentId: "run-local",
    condition: "local",
    target: {
      ...qualityTargetManifestFixture(),
      metric: "candidate_to_interleaved_baseline_score_ratio",
    },
    valid: true,
    firstReach: {
      generation: 2,
      candidateId: "sha256:candidate",
      medianRatio: 3.2,
      passingRatios: 9,
      discovery: boundary,
    },
    censoring: null,
    panel: {
      distinctCandidates: 1,
      audit: { valid: true },
      candidates: [{
        candidateId: "sha256:candidate",
        firstEvaluatedGeneration: 2,
        qualifies: true,
      }],
    },
    measurement: {
      evaluations: 27,
      elapsedMs: 4_000,
      includedInDiscoveryCost: false,
      invalidBlockAttempts: 0,
    },
  };
}

function configFixture() {
  return {
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    benchmarkId: "sorted-unique-int32/v3",
    evaluatorVersion: "protein-swarm-evaluator/v3",
    conditions: ["local", "isolated"],
    rows: 4,
    columns: 4,
    generations: 4,
    trials: 3,
    creditsPerCell: 24,
    maxModelTurns: 4,
    maxToolCalls: 3,
    providerTimeoutMs: 35_000,
    providerMaximumAttempts: 2,
    meaningfulThresholdPct: 1,
  };
}

function costConfigFixture() {
  return {
    ...configFixture(),
    objective: "cost_to_fixed_verified_quality",
    trials: 10,
    primaryResource: "responsesTokens",
    qualityTargetMultiplier: 3,
    qualityTargetRechecks: 9,
    qualityTargetRequiredRatios: 8,
    qualityTargetBlockSize: 4,
    qualityTargetMaximumBaselineDrift: 1.15,
    meaningfulCostDeltaPct: 5,
    minimumComparablePairs: 6,
    alpha: 0.05,
    bootstrapSamples: 1_000,
    bootstrapSeed: "test-seed",
  };
}
