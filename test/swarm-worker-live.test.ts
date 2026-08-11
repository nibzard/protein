import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

const { handleLiveFunctionCall, liveActionDelivered } = await import(
  "../examples/cellular-agent-swarm/worker"
);

type SwarmState = Parameters<typeof handleLiveFunctionCall>[1];
type LiveLoopState = Parameters<typeof handleLiveFunctionCall>[2];
type LiveDraft = NonNullable<LiveLoopState["draft"]>;

const CURRENT_ID = `sha256:${"1".repeat(64)}`;
const TARGET_ID = `sha256:${"2".repeat(64)}`;
const UNKNOWN_ID = `sha256:${"3".repeat(64)}`;
const CURRENT_REF = `artifact://sha256/${"1".repeat(64)}`;
const TARGET_REF = `artifact://sha256/${"2".repeat(64)}`;

describe("live swarm model-decision hardening", () => {
  it.each([
    ["a truncated opaque ID", TARGET_ID.slice(0, -1)],
    ["a complete but non-visible ID", UNKNOWN_ID],
  ])("falls back to a durable wait for %s", (_label, candidateId) => {
    const state = decidingState();
    const transition = handleLiveFunctionCall("cell-a", state, state.live!, {
      callId: "call-adopt-invalid",
      name: "adopt_candidate",
      arguments: {
        candidate_id: candidateId,
        rationale: "Use the strongest neighbor.",
      },
    });

    expect(transition.state).toMatchObject({
      status: "submitting",
      candidateId: CURRENT_ID,
      strategy: "current",
      score: 100,
      credits: 7,
      lastBehavior: "wait",
    });
    expect(transition.actions).toEqual([
      expect.objectContaining({
        id: "swarm:experiment-1:cell-a:2:submit",
        kind: "swarm.submit",
        payload: expect.objectContaining({
          decision: {
            behavior: "wait",
            rationale: "Rejected invalid adopt_candidate decision; retained the current verified candidate.",
          },
          candidate: null,
          cell: expect.objectContaining({
            candidateId: CURRENT_ID,
            credits: 7,
            behavior: "wait",
          }),
        }),
      }),
    ]);
    expect(transition.journal).toEqual({
      phase: "model_decision_rejected",
      protocol: "protein-openai-responses-tools/v1",
      functionName: "adopt_candidate",
      behavior: "wait",
      reason: "semantic_validation_failed",
      category: "candidate_not_visible",
      error: expect.stringContaining("not visible in the frozen neighborhood"),
    });
  });

  it("adopts a valid visible candidate and charges its behavior credit", () => {
    const state = decidingState();
    const transition = handleLiveFunctionCall("cell-a", state, state.live!, {
      callId: "call-adopt-valid",
      name: "adopt_candidate",
      arguments: {
        candidate_id: TARGET_ID,
        rationale: "Its authoritative score is stronger.",
      },
    });

    expect(transition.state).toMatchObject({
      status: "submitting",
      candidateId: TARGET_ID,
      strategy: "target",
      score: 140,
      credits: 6,
      lastBehavior: "adopt",
      lastEvidenceId: `sha256:${"4".repeat(64)}`,
    });
    expect(transition.journal).toMatchObject({
      phase: "candidate_adopted",
      candidateId: TARGET_ID,
    });
  });

  it("finalizes the runtime-held latest successful draft without echoed metadata", () => {
    const state = decidingState({
      live: liveState({
        draft: successfulDraft("latest strategy"),
      }),
    });
    const transition = handleLiveFunctionCall("cell-a", state, state.live!, {
      callId: "call-finalize",
      name: "finalize_candidate",
      arguments: {
        behavior: "improve",
        rationale: "Public checks passed.",
      },
    });

    expect(transition.state).toMatchObject({
      status: "evaluating",
      credits: 4,
      lastBehavior: "improve",
    });
    expect(transition.actions).toEqual([
      expect.objectContaining({
        kind: "swarm.evaluate",
        payload: expect.objectContaining({
          candidateId: TARGET_ID,
          candidateRef: TARGET_REF,
          strategy: "latest strategy",
          parentCandidateIds: [CURRENT_ID],
        }),
      }),
    ]);
  });

  it("rejects a model-supplied draft_ref instead of trusting an opaque echo", () => {
    const state = decidingState({
      live: liveState({ draft: successfulDraft("latest strategy") }),
    });
    const transition = handleLiveFunctionCall("cell-a", state, state.live!, {
      callId: "call-finalize-extra-ref",
      name: "finalize_candidate",
      arguments: {
        draft_ref: "draft://stale",
        behavior: "improve",
        rationale: "Use a stale reference.",
      },
    });

    expect(transition.state).toMatchObject({ status: "submitting", lastBehavior: "wait" });
    expect(transition.journal).toMatchObject({
      phase: "model_decision_rejected",
      functionName: "finalize_candidate",
      behavior: "wait",
      reason: "semantic_validation_failed",
      category: "unsupported_argument",
      error: "finalize_candidate contains unsupported argument draft_ref",
    });
  });

  it("retains the latest successful draft when a later public check fails", () => {
    const retained = successfulDraft("retained strategy");
    const live = liveState({
      modelTurn: 1,
      toolTurns: 2,
      pendingCallId: "call-public-failed",
      pendingToolName: "run_public_checks",
      draft: retained,
    });
    const state = decidingState({ status: "tooling", live });
    const actionId = "swarm:experiment-1:cell-a:2:tool:1";
    const transition = liveActionDelivered("cell-a", state, {
      actionId,
      kind: "swarm.tool.execute",
      result: {
        callId: "call-public-failed",
        toolName: "run_public_checks",
        executorActionId: actionId,
        draftRef: "draft://failed-later",
        candidateId: UNKNOWN_ID,
        candidateRef: `artifact://sha256/${"3".repeat(64)}`,
        strategy: "failed strategy",
        publicPass: false,
      },
      error: null,
    });

    expect(transition.state?.live).toMatchObject({
      modelTurn: 2,
      pendingCallId: null,
      pendingToolName: null,
      draft: retained,
    });
  });

  it("does not downgrade model envelope identity failures into wait", () => {
    const state = decidingState();
    expect(() => liveActionDelivered("cell-a", state, {
      actionId: state.expectedActionId!,
      kind: "swarm.model.turn",
      result: modelTurnResult({ loopId: "wrong-loop" }),
      error: null,
    })).toThrow("Model turn returned the wrong loopId");
  });

  it("does not downgrade executor receipt identity failures into wait", () => {
    const state = decidingState({
      status: "tooling",
      live: liveState({
        pendingCallId: "call-expected",
        pendingToolName: "read_candidate",
      }),
    });
    expect(() => liveActionDelivered("cell-a", state, {
      actionId: "swarm:experiment-1:cell-a:2:tool:0",
      kind: "swarm.tool.execute",
      result: {
        callId: "call-wrong",
        toolName: "read_candidate",
        executorActionId: "swarm:experiment-1:cell-a:2:tool:0",
      },
      error: null,
    })).toThrow("Tool result callId does not match the model function call");
  });

  it("does not downgrade evaluator identity failures into wait", () => {
    const evaluationActionId = "swarm:experiment-1:cell-a:2:evaluate";
    const state = decidingState({
      status: "evaluating",
      expectedActionId: evaluationActionId,
      live: liveState({
        terminal: {
          toolName: "finalize_candidate",
          callId: "call-finalize",
          candidateId: TARGET_ID,
          candidateRef: TARGET_REF,
          behavior: "improve",
          strategy: "latest strategy",
          rationale: "Public checks passed.",
          parentCandidateIds: [CURRENT_ID],
        },
      }),
    });
    expect(() => liveActionDelivered("cell-a", state, {
      actionId: evaluationActionId,
      kind: "swarm.evaluate",
      result: {
        evaluationActionId,
        candidateId: UNKNOWN_ID,
        artifactRef: TARGET_REF,
        strategy: "latest strategy",
        score: 150,
        evidenceId: `sha256:${"6".repeat(64)}`,
        behavior: "improve",
      },
      error: null,
    })).toThrow("Evaluator returned the wrong candidateId");
  });

  it("does not downgrade malformed visible evidence into wait", () => {
    const state = decidingState({
      visibleCandidates: [{ candidateId: TARGET_ID }],
    });
    expect(() => handleLiveFunctionCall("cell-a", state, state.live!, {
      callId: "call-adopt-corrupt-evidence",
      name: "adopt_candidate",
      arguments: {
        candidate_id: TARGET_ID,
        rationale: "Try the malformed candidate.",
      },
    })).toThrow("strategy must be a non-empty string");
  });
});

function decidingState(overrides: Partial<SwarmState> = {}): SwarmState {
  return {
    experimentId: "experiment-1",
    generation: 2,
    candidateId: CURRENT_ID,
    strategy: "current",
    score: 100,
    credits: 7,
    status: "deciding",
    lastBehavior: "improve",
    lastEvidenceId: `sha256:${"5".repeat(64)}`,
    lastArtifactRef: CURRENT_REF,
    lastEvaluationActionId: "evaluation-current",
    expectedActionId: "swarm:experiment-1:cell-a:2:model:1",
    visibleCandidates: [{
      candidateId: TARGET_ID,
      strategy: "target",
      score: 140,
      evidenceId: `sha256:${"4".repeat(64)}`,
      artifactRef: TARGET_REF,
      behavior: "improve",
      evaluationActionId: "evaluation-target",
    }],
    live: liveState(),
    ...overrides,
  };
}

function liveState(overrides: Partial<LiveLoopState> = {}): LiveLoopState {
  return {
    protocol: "protein-openai-responses-tools/v1",
    loopId: "swarm:experiment-1:cell-a:g2",
    modelTurn: 1,
    toolTurns: 1,
    maxModelTurns: 4,
    maxToolCalls: 3,
    pendingCallId: null,
    pendingToolName: null,
    draft: null,
    terminal: null,
    ...overrides,
  };
}

function successfulDraft(strategy: string): LiveDraft {
  return {
    draftRef: "draft://latest-success",
    candidateId: TARGET_ID,
    candidateRef: TARGET_REF,
    strategy,
    publicPass: true,
  };
}

function modelTurnResult(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "protein-openai-responses-tools/v1",
    loopId: "swarm:experiment-1:cell-a:g2",
    turn: 1,
    status: "completed",
    functionCall: {
      callId: "call-wait",
      name: "wait",
      arguments: JSON.stringify({ rationale: "Done." }),
    },
    ...overrides,
  };
}
