import {
  ProteinAgent,
  ProteinError,
  ProteinValidationError,
  type ActionExecutionContext,
  type ActionIntent,
  type AgentEventContext,
  type AgentTransition,
  type JsonObject,
  type JsonValue,
  type ProteinCheckpoint,
  type ProteinCheckpointContext,
} from "../../src/index";

interface Env extends Cloudflare.Env {
  SWARM_CELL: DurableObjectNamespace<SwarmCell>;
  EXECUTOR_URL: string;
  MODEL_GATEWAY_URL?: string;
  TOOL_EXECUTOR_URL?: string;
  EVALUATOR_URL?: string;
  BOARD_URL: string;
  PROTEIN_LEASE_MS?: string;
}

type SwarmStatus =
  | "idle"
  | "deciding"
  | "materializing"
  | "tooling"
  | "evaluating"
  | "submitting"
  | "waiting"
  | "failed";

type LiveDraft = JsonObject & {
  draftRef: string;
  candidateId: string;
  candidateRef: string;
  strategy: string;
  publicPass: boolean;
};

type LiveTerminal = JsonObject & {
  toolName: "finalize_candidate" | "challenge_candidate";
  callId: string;
  candidateId: string;
  candidateRef: string;
  behavior: "explore" | "improve" | "challenge";
  strategy: string;
  rationale: string;
  parentCandidateIds: string[];
};

type LiveLoopState = JsonObject & {
  protocol: typeof LIVE_AGENT_PROTOCOL;
  loopId: string;
  modelTurn: number;
  toolTurns: number;
  maxModelTurns: number;
  maxToolCalls: number;
  pendingCallId: string | null;
  pendingToolName: "read_candidate" | "run_public_checks" | null;
  draft: LiveDraft | null;
  terminal: LiveTerminal | null;
};

type SwarmState = JsonObject & {
  experimentId: string | null;
  generation: number;
  candidateId: string | null;
  strategy: string | null;
  score: number;
  credits: number;
  status: SwarmStatus;
  lastBehavior: string | null;
  lastEvidenceId: string | null;
  lastArtifactRef: string | null;
  lastEvaluationActionId: string | null;
  expectedActionId: string | null;
  visibleCandidates: JsonValue[];
  live: LiveLoopState | null;
};

interface Observation extends JsonObject {
  experimentId: string;
  generation: number;
  candidateId: string;
  strategy: string;
  score: number;
  credits: number;
  evidenceId?: string;
  artifactRef?: string;
  evaluationActionId?: string;
  condition: "local" | "isolated" | "sequential";
  task: JsonObject;
  neighborhood: JsonValue[];
}

interface Decision extends JsonObject {
  behavior: "explore" | "improve" | "challenge" | "adopt" | "wait";
  targetCandidateId?: string;
  strategy?: string;
  rationale: string;
}

interface CandidateResult extends JsonObject {
  candidateId: string;
  strategy: string;
  score: number;
  evidenceId: string;
  artifactRef: string;
  behavior: string;
  evaluationActionId?: string;
}

interface LiveFunctionCall {
  callId: string;
  name:
    | "read_candidate"
    | "run_public_checks"
    | "finalize_candidate"
    | "adopt_candidate"
    | "challenge_candidate"
    | "wait";
  arguments: JsonObject;
}

const LIVE_AGENT_PROTOCOL = "protein-openai-responses-tools/v1";
const DEFAULT_MAX_MODEL_TURNS = 4;
const DEFAULT_MAX_TOOL_CALLS = 3;
const MAX_LIVE_TURNS = 16;

class ModelDecisionRejectedError extends ProteinValidationError {
  constructor(message: string) {
    super(message);
    this.name = "ModelDecisionRejectedError";
  }
}

const BEHAVIOR_COST: Record<Decision["behavior"], number> = {
  explore: 4,
  improve: 3,
  challenge: 1,
  adopt: 1,
  wait: 0,
};

export class SwarmCell extends ProteinAgent<Env, SwarmState> {
  initialState: SwarmState = {
    experimentId: null,
    generation: 0,
    candidateId: null,
    strategy: null,
    score: 0,
    credits: 0,
    status: "idle",
    lastBehavior: null,
    lastEvidenceId: null,
    lastArtifactRef: null,
    lastEvaluationActionId: null,
    expectedActionId: null,
    visibleCandidates: [],
    live: null,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const leaseMs = Number(env.PROTEIN_LEASE_MS);
    if (Number.isFinite(leaseMs) && leaseMs >= 250) {
      this.proteinOptions = {
        ...this.proteinOptions,
        eventLeaseMs: leaseMs,
        actionLeaseMs: leaseMs,
      };
    }
  }

  protected override async onAgentEvent(
    context: AgentEventContext<SwarmState>,
  ): Promise<AgentTransition<SwarmState>> {
    const state = normalizeState(context.state);

    if (context.event.type === "swarm.generation.opened") {
      const observation = observationValue(context.event.payload);
      if (observation.generation <= state.generation) {
        return {
          state,
          journal: {
            phase: "generation_ignored",
            reason: "non_monotonic",
            receivedGeneration: observation.generation,
            currentGeneration: state.generation,
          },
        };
      }
      if (state.expectedActionId !== null) {
        return {
          state,
          journal: {
            phase: "generation_ignored",
            reason: "previous_generation_active",
            expectedActionId: state.expectedActionId,
          },
        };
      }
      const live = liveLoopForObservation(this.name, observation);
      const provenance = observationProvenance(observation, state);
      const action = live === null
        ? mockDecisionAction(this.name, observation)
        : liveModelAction(this.name, observation, live, null);
      return {
        state: {
          ...state,
          experimentId: observation.experimentId,
          generation: observation.generation,
          candidateId: observation.candidateId,
          strategy: observation.strategy,
          score: observation.score,
          credits: observation.credits,
          lastEvidenceId: provenance.evidenceId,
          lastArtifactRef: provenance.artifactRef,
          lastEvaluationActionId: provenance.evaluationActionId,
          status: "deciding",
          lastBehavior: null,
          expectedActionId: action.id,
          visibleCandidates: observation.neighborhood,
          live,
        },
        actions: [action],
        journal: {
          phase: live === null ? "decision_requested" : "model_turn_requested",
          generation: observation.generation,
          ...(live === null ? {} : { protocol: LIVE_AGENT_PROTOCOL, turn: 0 }),
        },
      };
    }

    if (context.event.type === "protein.action.delivered") {
      const outcome = actionOutcome(context.event.payload);
      if (outcome.actionId !== state.expectedActionId) {
        return {
          state,
          journal: {
            phase: "action_ignored",
            reason: "stale_or_unexpected",
            actionId: outcome.actionId,
            expectedActionId: state.expectedActionId,
          },
        };
      }
      if (state.live !== null) {
        try {
          return liveActionDelivered(this.name, state, outcome);
        } catch (error) {
          return liveProtocolFailure(state, outcome.kind, error);
        }
      }
      if (outcome.kind === "swarm.decide") {
        const decision = decisionValue(outcome.result);
        if (state.experimentId === null || state.candidateId === null) {
          throw new ProteinValidationError("Decision completed without an active observation");
        }
        const cost = BEHAVIOR_COST[decision.behavior];
        if (cost > state.credits) {
          throw new ProteinValidationError(
            `Decision ${decision.behavior} costs ${cost}, but only ${state.credits} credits remain`,
          );
        }
        const decidedState = { ...state, credits: state.credits - cost, lastBehavior: decision.behavior };
        if (decision.behavior === "wait") {
          const action = submitAction(this.name, decidedState, decision, null);
          return {
            state: { ...decidedState, status: "submitting", expectedActionId: action.id },
            actions: [action],
            journal: { phase: "decision_waited", rationale: decision.rationale },
          };
        }

        if (decision.behavior === "adopt") {
          const target = visibleCandidate(state.visibleCandidates, decision.targetCandidateId);
          const adoptedState: SwarmState = {
            ...decidedState,
            candidateId: target.candidateId,
            strategy: target.strategy,
            score: target.score,
            lastEvidenceId: target.evidenceId,
            lastArtifactRef: target.artifactRef,
            lastEvaluationActionId: target.evaluationActionId ?? (
              target.candidateId === state.candidateId ? state.lastEvaluationActionId : null
            ),
            status: "submitting",
          };
          const action = submitAction(this.name, adoptedState, decision, null);
          return {
            state: { ...adoptedState, expectedActionId: action.id },
            actions: [action],
            journal: {
              phase: "candidate_adopted",
              candidateId: target.candidateId,
              score: target.score,
            },
          };
        }

        const nextKind = decision.behavior === "challenge" ? "swarm.challenge" : "swarm.materialize";
        const actionId = workActionId(this.name, decidedState, nextKind);
        return {
          state: {
            ...decidedState,
            status: "materializing",
            expectedActionId: actionId,
          },
          actions: [
            {
              id: actionId,
              kind: nextKind,
              safety: "reconcilable",
              payload: {
                experimentId: decidedState.experimentId,
                generation: decidedState.generation,
                candidateId: decidedState.candidateId,
                strategy: decidedState.strategy,
                evidenceId: decidedState.lastEvidenceId,
                artifactRef: decidedState.lastArtifactRef,
                decision,
              },
            },
          ],
          journal: { phase: "candidate_requested", behavior: decision.behavior },
        };
      }

      if (outcome.kind === "swarm.materialize" || outcome.kind === "swarm.challenge") {
        const candidate = candidateResultValue(outcome.result);
        const candidateState: SwarmState = outcome.kind === "swarm.challenge"
          ? { ...state }
          : {
              ...state,
              candidateId: candidate.candidateId,
              strategy: candidate.strategy,
              score: candidate.score,
              lastEvidenceId: candidate.evidenceId,
              lastArtifactRef: candidate.artifactRef,
              lastEvaluationActionId: candidate.evaluationActionId ?? null,
            };
        const action = submitAction(this.name, candidateState, null, candidate);
        return {
          state: {
            ...candidateState,
            status: "submitting",
            expectedActionId: action.id,
          },
          actions: [action],
          journal: {
            phase: outcome.kind === "swarm.challenge" ? "challenge_verified" : "candidate_verified",
            candidateId: candidate.candidateId,
            score: candidate.score,
          },
        };
      }

      if (outcome.kind === "swarm.submit") {
        return {
          state: { ...state, status: "waiting", expectedActionId: null, visibleCandidates: [] },
          journal: { phase: "board_submission_delivered" },
        };
      }
    }

    if (
      context.event.type === "protein.action.failed" ||
      context.event.type === "protein.action.ambiguous"
    ) {
      const outcome = actionOutcome(context.event.payload);
      if (outcome.actionId !== state.expectedActionId) {
        return {
          state,
          journal: { phase: "failed_action_ignored", actionId: outcome.actionId },
        };
      }
      return {
        state: { ...state, status: "failed", expectedActionId: null },
        journal: { phase: "external_action_failed", kind: outcome.kind, error: outcome.error },
      };
    }

    return { state, journal: { phase: "event_ignored", type: context.event.type } };
  }

  protected override async executeAction(
    context: ActionExecutionContext,
  ): Promise<JsonValue> {
    const receiver = actionReceiver(this.env, context.action.kind);
    const endpoint = new URL(receiver.collectionPath, receiver.baseUrl);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": context.idempotencyKey,
      },
      body: JSON.stringify({
        actionId: context.idempotencyKey,
        agent: this.name,
        kind: context.action.kind,
        payload: context.action.payload,
      }),
    });
    if (!response.ok) {
      throw new Error(`Swarm receiver returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    return (await response.json()) as JsonValue;
  }

  protected override async reconcileAction(
    context: ActionExecutionContext,
  ): Promise<JsonValue | undefined> {
    const receiver = actionReceiver(this.env, context.action.kind);
    const endpoint = new URL(
      `${receiver.collectionPath}/${encodeURIComponent(context.idempotencyKey)}`,
      receiver.baseUrl,
    );
    const response = await fetch(endpoint);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Swarm reconciliation returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    return (await response.json()) as JsonValue;
  }

  protected override async onProteinCheckpoint(
    checkpoint: ProteinCheckpoint,
    context: ProteinCheckpointContext,
  ): Promise<void> {
    console.log(JSON.stringify({
      component: "protein.swarm-cell",
      checkpoint,
      agent: this.name,
      context,
    }));
  }

  protected override async onRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/state") {
        return Response.json({ agent: this.name, state: normalizeState(this.state) });
      }
      if (request.method === "GET" && url.pathname === "/journal") {
        return Response.json({ journal: this.listJournal(numberParam(url, "limit", 500)) });
      }
      if (request.method === "GET" && url.pathname === "/actions") {
        return Response.json({ actions: this.listActions(numberParam(url, "limit", 100)) });
      }
      if (request.method === "POST" && url.pathname === "/events") {
        const body = objectValue(await request.json(), "event request");
        const id = stringValue(body.id, "event request id");
        const type = stringValue(body.type, "event request type");
        const accepted = await this.acceptEvent({ id, type, payload: body.payload ?? null });
        return Response.json(accepted, { status: accepted.accepted ? 202 : 200 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      if (error instanceof ProteinError) {
        return Response.json({ error: error.code, message: error.message }, { status: 400 });
      }
      console.error(error);
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/cells\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match?.[1] === undefined) {
      return Response.json({ error: "Use /cells/:name/events, /state, /actions, or /journal" }, { status: 404 });
    }
    const name = decodeURIComponent(match[1]);
    if (name.length === 0 || name.length > 192) {
      return Response.json({ error: "invalid_cell_name" }, { status: 400 });
    }
    const id = env.SWARM_CELL.idFromName(name);
    url.pathname = match[2] ?? "/state";
    return env.SWARM_CELL.get(id).fetch(new Request(url, request));
  },
};

function submitAction(
  agent: string,
  state: SwarmState,
  decision: Decision | null,
  candidate: CandidateResult | null,
): ActionIntent {
  if (state.experimentId === null) throw new ProteinValidationError("Cannot submit without an experiment");
  return {
    id: `swarm:${state.experimentId}:${agent}:${state.generation}:submit`,
    kind: "swarm.submit",
    safety: "reconcilable",
    payload: {
      experimentId: state.experimentId,
      generation: state.generation,
      agent,
      decision,
      candidate,
      cell: {
        candidateId: state.candidateId,
        strategy: state.strategy,
        score: state.score,
        evidenceId: state.lastEvidenceId,
        artifactRef: state.lastArtifactRef,
        evaluationActionId: state.lastEvaluationActionId,
        credits: state.credits,
        behavior: state.lastBehavior,
      },
    },
  };
}

function decisionActionId(agent: string, observation: Observation): string {
  return `swarm:${observation.experimentId}:${agent}:${observation.generation}:decide`;
}

function mockDecisionAction(agent: string, observation: Observation): ActionIntent {
  return {
    id: decisionActionId(agent, observation),
    kind: "swarm.decide",
    safety: "reconcilable",
    payload: observation,
  };
}

function workActionId(agent: string, state: SwarmState, kind: "swarm.materialize" | "swarm.challenge"): string {
  if (state.experimentId === null) throw new ProteinValidationError("Cannot create work without an experiment");
  return `swarm:${state.experimentId}:${agent}:${state.generation}:${kind === "swarm.challenge" ? "challenge" : "materialize"}`;
}

function liveLoopForObservation(agent: string, observation: Observation): LiveLoopState | null {
  if (observation.task.agentProtocol !== LIVE_AGENT_PROTOCOL) return null;
  const maxModelTurns = taskInteger(
    observation.task,
    "maxModelTurns",
    DEFAULT_MAX_MODEL_TURNS,
    1,
    MAX_LIVE_TURNS,
  );
  const maxToolCalls = taskIntegerWithAlias(
    observation.task,
    "maxToolCalls",
    "maxToolTurns",
    Math.min(DEFAULT_MAX_TOOL_CALLS, Math.max(0, maxModelTurns - 1)),
    0,
    MAX_LIVE_TURNS,
  );
  return {
    protocol: LIVE_AGENT_PROTOCOL,
    loopId: `swarm:${observation.experimentId}:${agent}:g${observation.generation}`,
    modelTurn: 0,
    toolTurns: 0,
    maxModelTurns,
    maxToolCalls,
    pendingCallId: null,
    pendingToolName: null,
    draft: null,
    terminal: null,
  };
}

function liveModelAction(
  agent: string,
  observation: Observation | null,
  live: LiveLoopState,
  continuation: { callId: string; output: JsonValue } | null,
  state?: SwarmState,
): ActionIntent {
  const experimentId = observation?.experimentId ?? state?.experimentId;
  const generation = observation?.generation ?? state?.generation;
  if (experimentId === null || experimentId === undefined || generation === undefined) {
    throw new ProteinValidationError("Cannot request a model turn without an experiment and generation");
  }
  if ((observation === null) === (continuation === null)) {
    throw new ProteinValidationError("A model turn requires exactly one initial observation or function output");
  }
  return {
    id: `${liveActionPrefix(experimentId, agent, generation)}:model:${live.modelTurn}`,
    kind: "swarm.model.turn",
    safety: "reconcilable",
    payload: {
      loopId: live.loopId,
      turn: live.modelTurn,
      maxTurns: live.maxModelTurns,
      ...(observation === null ? {} : { observation }),
      ...(continuation === null
        ? {}
        : {
            functionCallOutput: {
              callId: continuation.callId,
              output: continuation.output,
            },
          }),
    },
  };
}

function liveToolAction(
  agent: string,
  state: SwarmState,
  live: LiveLoopState,
  call: LiveFunctionCall,
): ActionIntent {
  if (state.experimentId === null) {
    throw new ProteinValidationError("Cannot execute a live tool without an experiment");
  }
  return {
    id: `${liveActionPrefix(state.experimentId, agent, state.generation)}:tool:${live.toolTurns}`,
    kind: "swarm.tool.execute",
    safety: "reconcilable",
    payload: {
      experimentId: state.experimentId,
      generation: state.generation,
      loopId: live.loopId,
      callId: call.callId,
      tool: {
        name: call.name,
        arguments: call.arguments,
      },
      visibleCandidateIds: visibleCandidateIds(state),
    },
  };
}

function liveEvaluationAction(
  agent: string,
  state: SwarmState,
  terminal: LiveTerminal,
): ActionIntent {
  if (state.experimentId === null) {
    throw new ProteinValidationError("Cannot evaluate without an experiment");
  }
  return {
    id: `${liveActionPrefix(state.experimentId, agent, state.generation)}:evaluate`,
    kind: "swarm.evaluate",
    safety: "reconcilable",
    payload: {
      experimentId: state.experimentId,
      generation: state.generation,
      candidateId: terminal.candidateId,
      candidateRef: terminal.candidateRef,
      behavior: terminal.behavior,
      strategy: terminal.strategy,
      rationale: terminal.rationale,
      parentCandidateIds: terminal.parentCandidateIds,
    },
  };
}

export function liveActionDelivered(
  agent: string,
  state: SwarmState,
  outcome: ReturnType<typeof actionOutcome>,
): AgentTransition<SwarmState> {
  const live = state.live;
  if (live === null) {
    throw new ProteinValidationError("Live action completed without live loop state");
  }
  const expectedKind = expectedLiveActionKind(state.status);
  if (outcome.kind !== expectedKind) {
    throw new ProteinValidationError(
      `Expected live action kind ${expectedKind}, received ${outcome.kind}`,
    );
  }

  if (outcome.kind === "swarm.model.turn") {
    const call = liveModelTurnValue(outcome.result, live);
    return handleLiveFunctionCall(agent, state, live, call);
  }

  if (outcome.kind === "swarm.tool.execute") {
    if (live.pendingCallId === null || live.pendingToolName === null) {
      throw new ProteinValidationError("Tool completed without a pending function call");
    }
    validateToolOutcomeIdentity(
      outcome.result,
      outcome.actionId,
      live.pendingCallId,
      live.pendingToolName,
    );
    let draft = live.draft;
    if (live.pendingToolName === "run_public_checks") {
      const checkedDraft = liveDraftValue(outcome.result);
      if (checkedDraft.publicPass) draft = checkedDraft;
    }
    const nextTurn = live.modelTurn + 1;
    if (nextTurn >= live.maxModelTurns) {
      throw new ProteinValidationError("Tool result cannot continue beyond the model-turn budget");
    }
    const nextLive: LiveLoopState = {
      ...live,
      modelTurn: nextTurn,
      pendingCallId: null,
      pendingToolName: null,
      draft,
    };
    const action = liveModelAction(
      agent,
      null,
      nextLive,
      { callId: live.pendingCallId, output: outcome.result },
      state,
    );
    return {
      state: {
        ...state,
        status: "deciding",
        expectedActionId: action.id,
        live: nextLive,
      },
      actions: [action],
      journal: {
        phase: "function_output_forwarded",
        functionName: live.pendingToolName,
        turn: nextTurn,
      },
    };
  }

  if (outcome.kind === "swarm.evaluate") {
    const terminal = live.terminal;
    if (terminal === null) {
      throw new ProteinValidationError("Evaluation completed without a terminal function call");
    }
    const evaluated = candidateResultValue(outcome.result);
    validateEvaluationIdentity(outcome.result, outcome.actionId, terminal, evaluated);
    const candidate: CandidateResult = {
      ...evaluated,
      behavior: terminal.behavior,
    };
    const nextState: SwarmState = terminal.toolName === "challenge_candidate"
      ? { ...state, lastBehavior: "challenge" }
      : {
          ...state,
          candidateId: candidate.candidateId,
          strategy: candidate.strategy,
          score: candidate.score,
          lastEvidenceId: candidate.evidenceId,
          lastArtifactRef: candidate.artifactRef,
          lastEvaluationActionId: candidate.evaluationActionId ?? null,
          lastBehavior: terminal.behavior,
        };
    const decision: Decision = terminal.toolName === "challenge_candidate"
      ? {
          behavior: "challenge",
          targetCandidateId: terminal.candidateId,
          rationale: terminal.rationale,
        }
      : {
          behavior: terminal.behavior,
          strategy: terminal.strategy,
          rationale: terminal.rationale,
        };
    const action = submitAction(agent, nextState, decision, candidate);
    return {
      state: {
        ...nextState,
        status: "submitting",
        expectedActionId: action.id,
        live: { ...live, terminal: null },
      },
      actions: [action],
      journal: {
        phase: terminal.toolName === "challenge_candidate"
          ? "challenge_evaluated"
          : "candidate_evaluated",
        candidateId: candidate.candidateId,
        score: candidate.score,
      },
    };
  }

  if (outcome.kind === "swarm.submit") {
    return {
      state: {
        ...state,
        status: "waiting",
        expectedActionId: null,
        visibleCandidates: [],
        live: null,
      },
      journal: { phase: "board_submission_delivered", protocol: LIVE_AGENT_PROTOCOL },
    };
  }

  throw new ProteinValidationError(`Unexpected live action kind ${outcome.kind}`);
}

export function handleLiveFunctionCall(
  agent: string,
  state: SwarmState,
  live: LiveLoopState,
  call: LiveFunctionCall,
): AgentTransition<SwarmState> {
  try {
    return handleValidatedLiveFunctionCall(agent, state, live, call);
  } catch (error) {
    if (error instanceof ModelDecisionRejectedError) {
      return rejectModelDecisionAndWait(agent, state, call, error);
    }
    throw error;
  }
}

function handleValidatedLiveFunctionCall(
  agent: string,
  state: SwarmState,
  live: LiveLoopState,
  call: LiveFunctionCall,
): AgentTransition<SwarmState> {
  if (call.name === "read_candidate" || call.name === "run_public_checks") {
    if (live.modelTurn >= live.maxModelTurns - 1) {
      throw new ModelDecisionRejectedError(`${call.name} is not allowed on the final model turn`);
    }
    if (live.toolTurns >= live.maxToolCalls) {
      throw new ModelDecisionRejectedError("The live tool-turn budget is exhausted");
    }
    validateNonterminalToolArguments(state, call);
    const action = liveToolAction(agent, state, live, call);
    const nextLive: LiveLoopState = {
      ...live,
      toolTurns: live.toolTurns + 1,
      pendingCallId: call.callId,
      pendingToolName: call.name,
    };
    return {
      state: {
        ...state,
        status: "tooling",
        expectedActionId: action.id,
        live: nextLive,
      },
      actions: [action],
      journal: {
        phase: "tool_requested",
        functionName: call.name,
        modelTurn: live.modelTurn,
        toolTurn: live.toolTurns,
      },
    };
  }

  if (call.name === "finalize_candidate") {
    const terminal = finalizeTerminalValue(state, live, call);
    const chargedState = validateModelDecision(() => chargeBehavior(state, terminal.behavior));
    const action = liveEvaluationAction(agent, chargedState, terminal);
    return {
      state: {
        ...chargedState,
        status: "evaluating",
        expectedActionId: action.id,
        live: { ...live, terminal },
      },
      actions: [action],
      journal: { phase: "evaluation_requested", behavior: terminal.behavior },
    };
  }

  if (call.name === "challenge_candidate") {
    const visibleIds = visibleCandidateIds(state);
    const { candidateId, rationale } = validateModelDecision(() => {
      assertOnlyKeys(call.arguments, ["candidate_id", "rationale"], call.name);
      const candidateId = boundedStringValue(call.arguments.candidate_id, "candidate_id", 512);
      if (!visibleIds.includes(candidateId)) {
        throw new ProteinValidationError(
          `Candidate ${candidateId} was not visible in the frozen neighborhood`,
        );
      }
      return {
        candidateId,
        rationale: boundedStringValue(call.arguments.rationale, "rationale", 500),
      };
    });
    const target = visibleCandidate(state.visibleCandidates, candidateId, state);
    const terminal: LiveTerminal = {
      toolName: "challenge_candidate",
      callId: call.callId,
      candidateId: target.candidateId,
      candidateRef: target.artifactRef,
      behavior: "challenge",
      strategy: target.strategy,
      rationale,
      parentCandidateIds: [target.candidateId],
    };
    const chargedState = validateModelDecision(() => chargeBehavior(state, "challenge"));
    const action = liveEvaluationAction(agent, chargedState, terminal);
    return {
      state: {
        ...chargedState,
        status: "evaluating",
        expectedActionId: action.id,
        live: { ...live, terminal },
      },
      actions: [action],
      journal: { phase: "challenge_evaluation_requested", candidateId: target.candidateId },
    };
  }

  if (call.name === "adopt_candidate") {
    const visibleIds = visibleCandidateIds(state);
    const { candidateId, rationale } = validateModelDecision(() => {
      assertOnlyKeys(call.arguments, ["candidate_id", "rationale"], call.name);
      const candidateId = boundedStringValue(call.arguments.candidate_id, "candidate_id", 512);
      if (!visibleIds.includes(candidateId)) {
        throw new ProteinValidationError(
          `Candidate ${candidateId} was not visible in the frozen neighborhood`,
        );
      }
      return {
        candidateId,
        rationale: boundedStringValue(call.arguments.rationale, "rationale", 500),
      };
    });
    const target = visibleCandidate(state.visibleCandidates, candidateId, state);
    const adopted: CandidateResult = { ...target, behavior: "adopt" };
    const chargedState = validateModelDecision(() => chargeBehavior(state, "adopt"));
    const adoptedState: SwarmState = {
      ...chargedState,
      candidateId: adopted.candidateId,
      strategy: adopted.strategy,
      score: adopted.score,
      lastEvidenceId: adopted.evidenceId,
      lastArtifactRef: adopted.artifactRef,
      lastEvaluationActionId: adopted.evaluationActionId ?? (
        adopted.candidateId === state.candidateId ? state.lastEvaluationActionId : null
      ),
    };
    const decision: Decision = {
      behavior: "adopt",
      targetCandidateId: adopted.candidateId,
      rationale,
    };
    const action = submitAction(agent, adoptedState, decision, adopted);
    return {
      state: {
        ...adoptedState,
        status: "submitting",
        expectedActionId: action.id,
      },
      actions: [action],
      journal: { phase: "candidate_adopted", candidateId: adopted.candidateId, score: adopted.score },
    };
  }

  if (call.name === "wait") {
    const decision = validateModelDecision<Decision>(() => {
      assertOnlyKeys(call.arguments, ["rationale"], call.name);
      return {
        behavior: "wait",
        rationale: boundedStringValue(call.arguments.rationale, "rationale", 500),
      };
    });
    const waitingState = chargeBehavior(state, "wait");
    const action = submitAction(agent, waitingState, decision, null);
    return {
      state: {
        ...waitingState,
        status: "submitting",
        expectedActionId: action.id,
      },
      actions: [action],
      journal: { phase: "decision_waited", protocol: LIVE_AGENT_PROTOCOL },
    };
  }

  throw new ProteinValidationError(`Unsupported live function ${call.name}`);
}

function rejectModelDecisionAndWait(
  agent: string,
  state: SwarmState,
  call: LiveFunctionCall,
  error: ModelDecisionRejectedError,
): AgentTransition<SwarmState> {
  const decision: Decision = {
    behavior: "wait",
    rationale: `Rejected invalid ${call.name} decision; retained the current verified candidate.`,
  };
  const waitingState = chargeBehavior(state, "wait");
  const action = submitAction(agent, waitingState, decision, null);
  return {
    state: {
      ...waitingState,
      status: "submitting",
      expectedActionId: action.id,
    },
    actions: [action],
    journal: {
      phase: "model_decision_rejected",
      protocol: LIVE_AGENT_PROTOCOL,
      functionName: call.name,
      behavior: "wait",
      reason: "semantic_validation_failed",
      category: modelDecisionRejectionCategory(error.message),
      error: error.message.slice(0, 500),
    },
  };
}

function modelDecisionRejectionCategory(message: string): string {
  if (message.includes("requires a successfully public-checked draft")) {
    return "no_successful_public_draft";
  }
  if (message.includes("strategy must match the checked draft")) return "strategy_mismatch";
  if (message.includes("Parent candidate") && message.includes("not visible")) return "parent_not_visible";
  if (message.includes("Candidate") && message.includes("not visible")) return "candidate_not_visible";
  if (message.includes("contains unsupported argument")) return "unsupported_argument";
  if (message.includes("not allowed on the final model turn")) return "nonterminal_on_final_turn";
  if (message.includes("tool-turn budget is exhausted")) return "tool_budget_exhausted";
  if (message.includes("credits")) return "insufficient_credits";
  return "invalid_arguments";
}

function validateModelDecision<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ProteinValidationError) {
      throw new ModelDecisionRejectedError(error.message);
    }
    throw error;
  }
}

function liveProtocolFailure(
  state: SwarmState,
  actionKind: string,
  error: unknown,
): AgentTransition<SwarmState> {
  return {
    state: { ...state, status: "failed", expectedActionId: null },
    journal: {
      phase: "live_protocol_failed",
      actionKind,
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    },
  };
}

function liveActionPrefix(experimentId: string, agent: string, generation: number): string {
  return `swarm:${experimentId}:${agent}:${generation}`;
}

function expectedLiveActionKind(status: SwarmStatus): string {
  if (status === "deciding") return "swarm.model.turn";
  if (status === "tooling") return "swarm.tool.execute";
  if (status === "evaluating") return "swarm.evaluate";
  if (status === "submitting") return "swarm.submit";
  throw new ProteinValidationError(`Live loop cannot accept an action while ${status}`);
}

function observationProvenance(
  observation: Observation,
  state: SwarmState,
): {
  evidenceId: string | null;
  artifactRef: string | null;
  evaluationActionId: string | null;
} {
  const visibleCurrent = observation.neighborhood.find((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    return value.candidateId === observation.candidateId;
  });
  const visible = visibleCurrent === undefined
    ? null
    : objectValue(visibleCurrent, "current visible candidate");
  const priorMatches = state.candidateId === observation.candidateId;
  return {
    evidenceId: observation.evidenceId ?? optionalBoundedString(
      visible?.evidenceId,
      "current visible candidate evidenceId",
      512,
    ) ?? (priorMatches ? state.lastEvidenceId : null),
    artifactRef: observation.artifactRef ?? optionalBoundedString(
      visible?.artifactRef,
      "current visible candidate artifactRef",
      2_048,
    ) ?? (priorMatches ? state.lastArtifactRef : null),
    evaluationActionId: observation.evaluationActionId ?? optionalBoundedString(
      visible?.evaluationActionId,
      "current visible candidate evaluationActionId",
      512,
    ) ?? (priorMatches ? state.lastEvaluationActionId : null),
  };
}

function actionReceiver(
  env: Env,
  kind: string,
): { baseUrl: string; collectionPath: "/actions" | "/submissions" } {
  if (kind === "swarm.submit") {
    return { baseUrl: receiverUrl(env.BOARD_URL, "BOARD_URL"), collectionPath: "/submissions" };
  }
  if (kind === "swarm.model.turn") {
    return {
      baseUrl: receiverUrl(env.MODEL_GATEWAY_URL, "MODEL_GATEWAY_URL"),
      collectionPath: "/actions",
    };
  }
  if (kind === "swarm.tool.execute") {
    return {
      baseUrl: receiverUrl(env.TOOL_EXECUTOR_URL, "TOOL_EXECUTOR_URL"),
      collectionPath: "/actions",
    };
  }
  if (kind === "swarm.evaluate") {
    return {
      baseUrl: receiverUrl(env.EVALUATOR_URL, "EVALUATOR_URL"),
      collectionPath: "/actions",
    };
  }
  if (kind === "swarm.decide" || kind === "swarm.materialize" || kind === "swarm.challenge") {
    return { baseUrl: receiverUrl(env.EXECUTOR_URL, "EXECUTOR_URL"), collectionPath: "/actions" };
  }
  throw new ProteinValidationError(`No receiver is configured for action kind ${kind}`);
}

function receiverUrl(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProteinValidationError(`${label} is required for this action`);
  }
  try {
    new URL(value);
  } catch {
    throw new ProteinValidationError(`${label} must be an absolute URL`);
  }
  return value;
}

function chargeBehavior(state: SwarmState, behavior: Decision["behavior"]): SwarmState {
  const cost = BEHAVIOR_COST[behavior];
  if (cost > state.credits) {
    throw new ProteinValidationError(
      `Decision ${behavior} costs ${cost}, but only ${state.credits} credits remain`,
    );
  }
  return { ...state, credits: state.credits - cost, lastBehavior: behavior };
}

function taskInteger(
  task: JsonObject,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = task[key];
  return value === undefined
    ? fallback
    : boundedIntegerValue(value, `task.${key}`, minimum, maximum);
}

function taskIntegerWithAlias(
  task: JsonObject,
  key: string,
  alias: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = task[key];
  const aliasValue = task[alias];
  if (value !== undefined && aliasValue !== undefined && value !== aliasValue) {
    throw new ProteinValidationError(`task.${key} conflicts with legacy task.${alias}`);
  }
  if (value !== undefined) return boundedIntegerValue(value, `task.${key}`, minimum, maximum);
  if (aliasValue !== undefined) {
    return boundedIntegerValue(aliasValue, `task.${alias}`, minimum, maximum);
  }
  return fallback;
}

function liveLoopStateValue(value: JsonValue | undefined): LiveLoopState | null {
  if (value === null || value === undefined) return null;
  try {
    const object = objectValue(value, "live loop state");
    if (object.protocol !== LIVE_AGENT_PROTOCOL) {
      throw new ProteinValidationError("live loop state has an unsupported protocol");
    }
    const maxModelTurns = boundedIntegerValue(
      object.maxModelTurns,
      "live maxModelTurns",
      1,
      MAX_LIVE_TURNS,
    );
    const maxToolCalls = boundedIntegerValue(
      object.maxToolCalls ?? object.maxToolTurns,
      "live maxToolCalls",
      0,
      MAX_LIVE_TURNS,
    );
    const modelTurn = boundedIntegerValue(
      object.modelTurn,
      "live modelTurn",
      0,
      maxModelTurns - 1,
    );
    const toolTurns = boundedIntegerValue(
      object.toolTurns,
      "live toolTurns",
      0,
      maxToolCalls,
    );
    const pendingCallId = object.pendingCallId === null
      ? null
      : boundedStringValue(object.pendingCallId, "live pendingCallId", 512);
    const pendingToolName = object.pendingToolName === null
      ? null
      : nonterminalToolNameValue(object.pendingToolName, "live pendingToolName");
    if ((pendingCallId === null) !== (pendingToolName === null)) {
      throw new ProteinValidationError("live pending call identity is incomplete");
    }
    if (pendingCallId !== null && toolTurns === 0) {
      throw new ProteinValidationError("live pending call has no consumed tool turn");
    }
    const draft = object.draft === null ? null : liveDraftValue(object.draft);
    const terminal = object.terminal === null ? null : liveTerminalStateValue(object.terminal);
    if (pendingCallId !== null && terminal !== null) {
      throw new ProteinValidationError("live loop cannot have pending and terminal calls together");
    }
    return {
      protocol: LIVE_AGENT_PROTOCOL,
      loopId: boundedStringValue(object.loopId, "live loopId", 512),
      modelTurn,
      toolTurns,
      maxModelTurns,
      maxToolCalls,
      pendingCallId,
      pendingToolName,
      draft,
      terminal,
    };
  } catch {
    return null;
  }
}

function liveTerminalStateValue(value: JsonValue | undefined): LiveTerminal {
  const object = objectValue(value, "live terminal state");
  const toolName = stringValue(object.toolName, "live terminal toolName");
  if (toolName !== "finalize_candidate" && toolName !== "challenge_candidate") {
    throw new ProteinValidationError(`Unsupported live terminal tool ${toolName}`);
  }
  const behavior = stringValue(object.behavior, "live terminal behavior");
  if (behavior !== "explore" && behavior !== "improve" && behavior !== "challenge") {
    throw new ProteinValidationError(`Unsupported live terminal behavior ${behavior}`);
  }
  if (
    (toolName === "challenge_candidate" && behavior !== "challenge") ||
    (toolName === "finalize_candidate" && behavior === "challenge")
  ) {
    throw new ProteinValidationError("live terminal tool and behavior do not match");
  }
  return {
    toolName,
    callId: boundedStringValue(object.callId, "live terminal callId", 512),
    candidateId: boundedStringValue(object.candidateId, "live terminal candidateId", 512),
    candidateRef: boundedStringValue(object.candidateRef, "live terminal candidateRef", 2_048),
    behavior,
    strategy: boundedStringValue(object.strategy, "live terminal strategy", 80),
    rationale: boundedStringValue(object.rationale, "live terminal rationale", 500),
    parentCandidateIds: boundedStringArrayValue(
      object.parentCandidateIds,
      "live terminal parentCandidateIds",
      2,
      512,
    ),
  };
}

function liveModelTurnValue(value: JsonValue, live: LiveLoopState): LiveFunctionCall {
  const object = objectValue(value, "model turn result");
  if (object.protocol !== LIVE_AGENT_PROTOCOL) {
    throw new ProteinValidationError("Model turn returned the wrong agent protocol");
  }
  if (stringValue(object.loopId, "model loopId") !== live.loopId) {
    throw new ProteinValidationError("Model turn returned the wrong loopId");
  }
  if (boundedIntegerValue(object.turn, "model turn", 0, MAX_LIVE_TURNS - 1) !== live.modelTurn) {
    throw new ProteinValidationError("Model turn result does not match the requested turn");
  }
  if (object.status !== "completed") {
    throw new ProteinValidationError("Model turn did not complete");
  }
  const functionCall = objectValue(object.functionCall, "model functionCall");
  const argumentsText = boundedStringValue(
    functionCall.arguments,
    "model functionCall arguments",
    20_000,
  );
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(argumentsText);
  } catch {
    throw new ProteinValidationError("model functionCall arguments must be valid JSON");
  }
  return {
    callId: boundedStringValue(functionCall.callId, "model functionCall callId", 512),
    name: liveToolNameValue(functionCall.name, "model functionCall name"),
    arguments: objectValue(parsedArguments, "model functionCall arguments"),
  };
}

function validateToolOutcomeIdentity(
  value: JsonValue,
  actionId: string,
  callId: string,
  toolName: "read_candidate" | "run_public_checks",
): void {
  const object = objectValue(value, "tool result");
  if (stringValue(object.callId, "tool result callId") !== callId) {
    throw new ProteinValidationError("Tool result callId does not match the model function call");
  }
  if (stringValue(object.toolName, "tool result toolName") !== toolName) {
    throw new ProteinValidationError("Tool result name does not match the model function call");
  }
  if (stringValue(object.executorActionId, "tool result executorActionId") !== actionId) {
    throw new ProteinValidationError("Tool result does not match the Protein action");
  }
}

function liveDraftValue(value: JsonValue | undefined): LiveDraft {
  const object = objectValue(value, "public-check draft result");
  const candidateRef = boundedStringValue(object.candidateRef, "draft candidateRef", 2_048);
  if (object.artifactRef !== undefined && object.artifactRef !== candidateRef) {
    throw new ProteinValidationError("Draft artifactRef does not match candidateRef");
  }
  return {
    draftRef: boundedStringValue(object.draftRef, "draftRef", 2_048),
    candidateId: boundedStringValue(object.candidateId, "draft candidateId", 512),
    candidateRef,
    strategy: boundedStringValue(object.strategy, "draft strategy", 80),
    publicPass: booleanValue(object.publicPass, "draft publicPass"),
  };
}

function validateNonterminalToolArguments(state: SwarmState, call: LiveFunctionCall): void {
  if (call.name === "read_candidate") {
    const visibleIds = visibleCandidateIds(state);
    validateModelDecision(() => {
      assertOnlyKeys(call.arguments, ["candidate_id"], call.name);
      const candidateId = boundedStringValue(call.arguments.candidate_id, "candidate_id", 512);
      if (!visibleIds.includes(candidateId)) {
        throw new ProteinValidationError(
          `Candidate ${candidateId} was not visible in the frozen neighborhood`,
        );
      }
    });
    return;
  }
  if (call.name === "run_public_checks") {
    validateModelDecision(() => {
      assertOnlyKeys(call.arguments, ["source", "strategy", "summary"], call.name);
      boundedStringValue(call.arguments.source, "source", 16_384);
      boundedStringValue(call.arguments.strategy, "strategy", 80);
      boundedStringValue(call.arguments.summary, "summary", 320);
    });
    return;
  }
  throw new ProteinValidationError(`${call.name} is not a non-terminal tool`);
}

function finalizeTerminalValue(
  state: SwarmState,
  live: LiveLoopState,
  call: LiveFunctionCall,
): LiveTerminal {
  const draft = live.draft;
  if (draft === null) {
    throw new ModelDecisionRejectedError(
      "finalize_candidate requires a successfully public-checked draft from run_public_checks",
    );
  }
  if (!draft.publicPass) {
    throw new ProteinValidationError("Persisted live draft did not pass public checks");
  }
  if (state.candidateId === null) {
    throw new ProteinValidationError("Cannot finalize a draft without a current verified candidate");
  }
  const { behavior, rationale } = validateModelDecision(() => {
    assertOnlyKeys(
      call.arguments,
      ["behavior", "rationale"],
      call.name,
    );
    const behaviorValue = stringValue(call.arguments.behavior, "behavior");
    if (behaviorValue !== "explore" && behaviorValue !== "improve") {
      throw new ProteinValidationError("finalize_candidate behavior must be explore or improve");
    }
    const behavior: "explore" | "improve" = behaviorValue;
    return {
      behavior,
      rationale: boundedStringValue(call.arguments.rationale, "rationale", 500),
    };
  });
  return {
    toolName: "finalize_candidate",
    callId: call.callId,
    candidateId: draft.candidateId,
    candidateRef: draft.candidateRef,
    behavior,
    strategy: draft.strategy,
    rationale,
    parentCandidateIds: [state.candidateId],
  };
}

function validateEvaluationIdentity(
  value: JsonValue,
  actionId: string,
  terminal: LiveTerminal,
  evaluated: CandidateResult,
): void {
  const object = objectValue(value, "evaluation result");
  if (stringValue(object.evaluationActionId, "evaluationActionId") !== actionId) {
    throw new ProteinValidationError("Evaluation result does not match the Protein action");
  }
  if (evaluated.candidateId !== terminal.candidateId) {
    throw new ProteinValidationError("Evaluator returned the wrong candidateId");
  }
  if (evaluated.artifactRef !== terminal.candidateRef) {
    throw new ProteinValidationError("Evaluator returned the wrong candidate reference");
  }
  if (evaluated.strategy !== terminal.strategy || evaluated.behavior !== terminal.behavior) {
    throw new ProteinValidationError("Evaluator returned mismatched candidate metadata");
  }
}

function visibleCandidateIds(state: SwarmState): string[] {
  const ids: string[] = [];
  const add = (value: JsonValue | undefined): void => {
    if (typeof value !== "string" || value.length === 0 || value.length > 512) return;
    if (!ids.includes(value)) ids.push(value);
  };
  add(state.candidateId ?? undefined);
  for (const value of state.visibleCandidates) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    add(value.candidateId);
  }
  if (ids.length > 64) {
    throw new ProteinValidationError("Frozen neighborhood exceeds the 64-candidate tool limit");
  }
  return ids;
}

function assertOnlyKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected !== undefined) {
    throw new ProteinValidationError(`${label} contains unsupported argument ${unexpected}`);
  }
}

function liveToolNameValue(value: JsonValue | undefined, label: string): LiveFunctionCall["name"] {
  const name = stringValue(value, label);
  if (
    name !== "read_candidate" &&
    name !== "run_public_checks" &&
    name !== "finalize_candidate" &&
    name !== "adopt_candidate" &&
    name !== "challenge_candidate" &&
    name !== "wait"
  ) {
    throw new ProteinValidationError(`Unsupported live function ${name}`);
  }
  return name;
}

function nonterminalToolNameValue(
  value: JsonValue | undefined,
  label: string,
): "read_candidate" | "run_public_checks" {
  const name = stringValue(value, label);
  if (name !== "read_candidate" && name !== "run_public_checks") {
    throw new ProteinValidationError(`${label} must be read_candidate or run_public_checks`);
  }
  return name;
}

function boundedIntegerValue(
  value: JsonValue | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new ProteinValidationError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function boundedStringValue(
  value: JsonValue | undefined,
  label: string,
  maximumLength: number,
): string {
  const result = stringValue(value, label);
  if (result.length > maximumLength) {
    throw new ProteinValidationError(`${label} must be at most ${maximumLength} characters`);
  }
  return result;
}

function optionalBoundedString(
  value: JsonValue | undefined,
  label: string,
  maximumLength: number,
): string | null {
  return value === undefined || value === null
    ? null
    : boundedStringValue(value, label, maximumLength);
}

function booleanValue(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProteinValidationError(`${label} must be a boolean`);
  }
  return value;
}

function boundedStringArrayValue(
  value: JsonValue | undefined,
  label: string,
  maximumItems: number,
  maximumItemLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new ProteinValidationError(`${label} must contain at most ${maximumItems} strings`);
  }
  const result = value.map((item, index) =>
    boundedStringValue(item, `${label}[${index}]`, maximumItemLength));
  if (new Set(result).size !== result.length) {
    throw new ProteinValidationError(`${label} must not contain duplicates`);
  }
  return result;
}

function normalizeState(state: Readonly<SwarmState>): SwarmState {
  const status = state.status;
  return {
    experimentId: typeof state.experimentId === "string" ? state.experimentId : null,
    generation: typeof state.generation === "number" ? state.generation : 0,
    candidateId: typeof state.candidateId === "string" ? state.candidateId : null,
    strategy: typeof state.strategy === "string" ? state.strategy : null,
    score: typeof state.score === "number" ? state.score : 0,
    credits: typeof state.credits === "number" ? state.credits : 0,
    status:
      status === "deciding" || status === "materializing" || status === "submitting" ||
      status === "tooling" || status === "evaluating" || status === "waiting" ||
      status === "failed" ? status : "idle",
    lastBehavior: typeof state.lastBehavior === "string" ? state.lastBehavior : null,
    lastEvidenceId: typeof state.lastEvidenceId === "string" ? state.lastEvidenceId : null,
    lastArtifactRef: typeof state.lastArtifactRef === "string" ? state.lastArtifactRef : null,
    lastEvaluationActionId: typeof state.lastEvaluationActionId === "string"
      ? state.lastEvaluationActionId
      : null,
    expectedActionId: typeof state.expectedActionId === "string" ? state.expectedActionId : null,
    visibleCandidates: Array.isArray(state.visibleCandidates) ? state.visibleCandidates : [],
    live: liveLoopStateValue(state.live),
  };
}

function observationValue(value: JsonValue): Observation {
  const object = objectValue(value, "generation observation");
  return {
    experimentId: stringValue(object.experimentId, "experimentId"),
    generation: numberValue(object.generation, "generation"),
    candidateId: stringValue(object.candidateId, "candidateId"),
    strategy: stringValue(object.strategy, "strategy"),
    score: numberValue(object.score, "score"),
    credits: numberValue(object.credits, "credits"),
    ...(object.evidenceId === undefined
      ? {}
      : { evidenceId: boundedStringValue(object.evidenceId, "evidenceId", 512) }),
    ...(object.artifactRef === undefined
      ? {}
      : { artifactRef: boundedStringValue(object.artifactRef, "artifactRef", 2_048) }),
    ...(object.evaluationActionId === undefined
      ? {}
      : {
          evaluationActionId: boundedStringValue(
            object.evaluationActionId,
            "evaluationActionId",
            512,
          ),
        }),
    condition: conditionValue(object.condition),
    task: objectValue(object.task, "task"),
    neighborhood: Array.isArray(object.neighborhood) ? object.neighborhood : [],
  };
}

function decisionValue(value: JsonValue): Decision {
  const object = objectValue(value, "decision result");
  const behavior = stringValue(object.behavior, "decision behavior");
  if (!["explore", "improve", "challenge", "adopt", "wait"].includes(behavior)) {
    throw new ProteinValidationError(`Unsupported swarm behavior ${behavior}`);
  }
  return {
    behavior: behavior as Decision["behavior"],
    rationale: stringValue(object.rationale, "decision rationale"),
    ...(typeof object.targetCandidateId === "string" ? { targetCandidateId: object.targetCandidateId } : {}),
    ...(typeof object.strategy === "string" ? { strategy: object.strategy } : {}),
  };
}

function candidateResultValue(value: JsonValue): CandidateResult {
  const object = objectValue(value, "candidate result");
  return {
    candidateId: stringValue(object.candidateId, "candidateId"),
    strategy: stringValue(object.strategy, "strategy"),
    score: numberValue(object.score, "score"),
    evidenceId: stringValue(object.evidenceId, "evidenceId"),
    artifactRef: stringValue(object.artifactRef, "artifactRef"),
    behavior: stringValue(object.behavior, "behavior"),
    ...(typeof object.evaluationActionId === "string"
      ? { evaluationActionId: stringValue(object.evaluationActionId, "evaluationActionId") }
      : {}),
  };
}

function actionOutcome(value: JsonValue) {
  const object = objectValue(value, "action outcome");
  return {
    actionId: stringValue(object.actionId, "action id"),
    kind: stringValue(object.kind, "action kind"),
    result: (object.result ?? null) as JsonValue,
    error: typeof object.error === "string" ? object.error : null,
  };
}

function visibleCandidate(
  values: JsonValue[],
  targetCandidateId: string | undefined,
  state?: SwarmState,
): CandidateResult {
  if (targetCandidateId === undefined) {
    throw new ProteinValidationError("Adopt decision requires targetCandidateId");
  }
  const target = values.find((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    return value.candidateId === targetCandidateId;
  });
  if (target !== undefined) return candidateResultValue(target);
  if (
    state?.candidateId === targetCandidateId &&
    state.strategy !== null &&
    state.lastEvidenceId !== null &&
    state.lastArtifactRef !== null
  ) {
    return {
      candidateId: state.candidateId,
      strategy: state.strategy,
      score: state.score,
      evidenceId: state.lastEvidenceId,
      artifactRef: state.lastArtifactRef,
      behavior: state.lastBehavior ?? "current",
      ...(state.lastEvaluationActionId === null
        ? {}
        : { evaluationActionId: state.lastEvaluationActionId }),
    };
  }
  throw new ProteinValidationError(
    `Candidate ${targetCandidateId} was not visible in the frozen neighborhood`,
  );
}

function conditionValue(value: JsonValue | undefined): Observation["condition"] {
  if (value === "local" || value === "isolated" || value === "sequential") return value;
  throw new ProteinValidationError("condition must be local, isolated, or sequential");
}

function numberParam(url: URL, key: string, fallback: number): number {
  const value = Number(url.searchParams.get(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function objectValue(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProteinValidationError(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProteinValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function numberValue(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProteinValidationError(`${label} must be a finite number`);
  }
  return value;
}
