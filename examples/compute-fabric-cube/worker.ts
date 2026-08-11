import {
  ProteinAgent,
  ProteinError,
  ProteinValidationError,
  type ActionExecutionContext,
  type AgentEventContext,
  type AgentTransition,
  type JsonObject,
  type JsonValue,
} from "../../src/index";

interface Env extends Cloudflare.Env {
  FABRIC_CELL: DurableObjectNamespace<FabricCell>;
  CAPABILITY_URL: string;
  PROTEIN_LEASE_MS?: string;
}

type FabricState = JsonObject & {
  domain: string | null;
  layer: string | null;
  status: "new" | "idle" | "working" | "failed";
  wakeCount: number;
  completedWork: JsonValue[];
  receipts: JsonValue[];
  relationships: JsonValue[];
  pendingActionId: string | null;
  lastActiveAt: number | null;
};

interface WorkAssignment extends JsonObject {
  workId: string;
  phase: string;
  tier: "cell" | "model" | "bounded" | "sandbox";
  capabilityId: string;
  artifactId?: string;
  parentArtifactIds: JsonValue[];
  relationships: JsonValue[];
  spec: JsonObject;
}

export class FabricCell extends ProteinAgent<Env, FabricState> {
  initialState: FabricState = {
    domain: null,
    layer: null,
    status: "new",
    wakeCount: 0,
    completedWork: [],
    receipts: [],
    relationships: [],
    pendingActionId: null,
    lastActiveAt: null,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const leaseMs = Number(env.PROTEIN_LEASE_MS);
    if (Number.isFinite(leaseMs) && leaseMs >= 250) {
      this.proteinOptions = { ...this.proteinOptions, eventLeaseMs: leaseMs, actionLeaseMs: leaseMs };
    }
  }

  protected override async onAgentEvent(
    context: AgentEventContext<FabricState>,
  ): Promise<AgentTransition<FabricState>> {
    const state = normalizeState(context.state);
    if (context.event.type === "fabric.identity.bootstrapped") {
      const payload = objectValue(context.event.payload, "identity payload");
      const domain = stringValue(payload.domain, "domain");
      const layer = stringValue(payload.layer, "layer");
      return {
        state: { ...state, domain, layer, status: "idle", wakeCount: state.wakeCount + 1, lastActiveAt: context.now },
        journal: { phase: "identity_bootstrapped", domain, layer },
      };
    }

    if (context.event.type === "fabric.work.assigned") {
      const assignment = assignmentValue(context.event.payload);
      if (state.pendingActionId !== null) {
        throw new ProteinValidationError(`Cell already has pending action ${state.pendingActionId}`);
      }
      if (assignment.tier === "cell") {
        const receipt = {
          receiptId: `receipt:${assignment.capabilityId}`,
          capabilityId: assignment.capabilityId,
          actionId: null,
          tier: "cell",
          status: "completed",
          agent: this.name,
          workId: assignment.workId,
          phase: assignment.phase,
          artifactId: assignment.artifactId ?? `cell:${assignment.capabilityId}`,
          parentArtifactIds: assignment.parentArtifactIds,
          resource: { modelCalls: 0, tokens: 0, sandboxAttempts: 0, durationMs: 0 },
          completedAt: context.now,
        } satisfies JsonObject;
        return {
          state: {
            ...state,
            status: "idle",
            wakeCount: state.wakeCount + 1,
            completedWork: [...state.completedWork, completedEntry(assignment, receipt)],
            receipts: [...state.receipts, receipt],
            relationships: [...state.relationships, ...assignment.relationships],
            lastActiveAt: context.now,
          },
          journal: { phase: "cell_work_completed", workId: assignment.workId, capabilityId: assignment.capabilityId },
        };
      }
      const actionId = `cap:${assignment.capabilityId}`;
      return {
        state: { ...state, status: "working", wakeCount: state.wakeCount + 1, pendingActionId: actionId, lastActiveAt: context.now },
        actions: [{ id: actionId, kind: "fabric.capability", safety: "reconcilable", payload: assignment }],
        journal: { phase: "capability_requested", workId: assignment.workId, tier: assignment.tier, capabilityId: assignment.capabilityId },
      };
    }

    if (context.event.type === "protein.action.delivered") {
      const outcome = actionOutcome(context.event.payload);
      if (outcome.actionId !== state.pendingActionId) {
        return { state, journal: { phase: "stale_action_ignored", actionId: outcome.actionId, pendingActionId: state.pendingActionId } };
      }
      const receipt = objectValue(outcome.result.receipt, "capability receipt");
      const assignment = assignmentValue(outcome.result.assignment);
      return {
        state: {
          ...state,
          status: "idle",
          pendingActionId: null,
          completedWork: [...state.completedWork, completedEntry(assignment, receipt)],
          receipts: [...state.receipts, receipt],
          relationships: [...state.relationships, ...assignment.relationships],
          lastActiveAt: context.now,
        },
        journal: { phase: "capability_completed", workId: assignment.workId, tier: assignment.tier, capabilityId: assignment.capabilityId, receiptId: receipt.receiptId ?? null },
      };
    }

    if (context.event.type === "protein.action.failed" || context.event.type === "protein.action.ambiguous") {
      const payload = objectValue(context.event.payload, "failed action outcome");
      return {
        state: { ...state, status: "failed", pendingActionId: null, lastActiveAt: context.now },
        journal: { phase: "capability_failed", outcome: context.event.type, actionId: payload.actionId ?? null, error: payload.error ?? null },
      };
    }

    return { state, journal: { phase: "event_ignored", type: context.event.type } };
  }

  protected override async executeAction(context: ActionExecutionContext): Promise<JsonValue> {
    if (context.action.kind !== "fabric.capability") throw new ProteinValidationError(`Unsupported action ${context.action.kind}`);
    const response = await fetch(new URL("/jobs", this.env.CAPABILITY_URL), {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": context.idempotencyKey },
      body: JSON.stringify({ agent: this.name, actionId: context.action.id, assignment: context.action.payload }),
    });
    if (!response.ok) throw new Error(`Capability service returned ${response.status}: ${(await response.text()).slice(0, 600)}`);
    return (await response.json()) as JsonValue;
  }

  protected override async reconcileAction(context: ActionExecutionContext): Promise<JsonValue | undefined> {
    const response = await fetch(new URL(`/jobs/${encodeURIComponent(context.idempotencyKey)}`, this.env.CAPABILITY_URL));
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Capability lookup returned ${response.status}: ${(await response.text()).slice(0, 600)}`);
    return (await response.json()) as JsonValue;
  }

  override async onRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/events") {
        const body = objectValue(await request.json(), "event request");
        const id = stringValue(body.id, "event id");
        const type = stringValue(body.type, "event type");
        const accepted = await this.acceptEvent({ id, type, payload: body.payload ?? null });
        return Response.json(accepted, { status: accepted.accepted ? 202 : 200 });
      }
      if (request.method === "GET" && url.pathname === "/state") return Response.json({ agent: this.name, state: normalizeState(this.state) });
      if (request.method === "GET" && url.pathname === "/actions") return Response.json({ actions: this.listActions(numberParam(url, "limit", 100)) });
      if (request.method === "GET" && url.pathname === "/journal") return Response.json({ journal: this.listJournal(numberParam(url, "limit", 200)) });
      if (request.method === "GET" && url.pathname === "/identity") return Response.json({ agent: this.name, domain: this.state.domain, layer: this.state.layer });
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/cells\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match?.[1] === undefined) return Response.json({ error: "Use /cells/:name/state, /events, /actions, or /journal" }, { status: 404 });
    const name = decodeURIComponent(match[1]);
    if (name.length === 0 || name.length > 192) return Response.json({ error: "invalid_cell_name" }, { status: 400 });
    url.pathname = match[2] ?? "/state";
    const id = env.FABRIC_CELL.idFromName(name);
    return env.FABRIC_CELL.get(id).fetch(new Request(url, request));
  },
};

function assignmentValue(value: unknown): WorkAssignment {
  const assignment = objectValue(value, "work assignment");
  const tier = stringValue(assignment.tier, "tier");
  if (tier !== "cell" && tier !== "model" && tier !== "bounded" && tier !== "sandbox") throw new ProteinValidationError(`Unsupported tier ${tier}`);
  const parentArtifactIds = arrayValue(assignment.parentArtifactIds, "parentArtifactIds");
  const relationships = arrayValue(assignment.relationships, "relationships");
  return {
    ...assignment,
    workId: stringValue(assignment.workId, "workId"),
    phase: stringValue(assignment.phase, "phase"),
    tier,
    capabilityId: stringValue(assignment.capabilityId, "capabilityId"),
    ...(typeof assignment.artifactId === "string" ? { artifactId: assignment.artifactId } : {}),
    parentArtifactIds,
    relationships,
    spec: objectValue(assignment.spec, "spec"),
  };
}

function actionOutcome(value: unknown): { actionId: string; result: JsonObject } {
  const payload = objectValue(value, "action outcome");
  return {
    actionId: stringValue(payload.actionId, "actionId"),
    result: objectValue(payload.result, "result"),
  };
}

function completedEntry(assignment: WorkAssignment, receipt: JsonObject): JsonObject {
  return { workId: assignment.workId, phase: assignment.phase, tier: assignment.tier, capabilityId: assignment.capabilityId, artifactId: receipt.artifactId ?? assignment.artifactId ?? null, receiptId: receipt.receiptId ?? null };
}

function normalizeState(state: Readonly<FabricState>): FabricState {
  const status = state.status === "idle" || state.status === "working" || state.status === "failed" ? state.status : "new";
  return { domain: typeof state.domain === "string" ? state.domain : null, layer: typeof state.layer === "string" ? state.layer : null, status, wakeCount: typeof state.wakeCount === "number" ? state.wakeCount : 0, completedWork: Array.isArray(state.completedWork) ? [...state.completedWork] : [], receipts: Array.isArray(state.receipts) ? [...state.receipts] : [], relationships: Array.isArray(state.relationships) ? [...state.relationships] : [], pendingActionId: typeof state.pendingActionId === "string" ? state.pendingActionId : null, lastActiveAt: typeof state.lastActiveAt === "number" ? state.lastActiveAt : null };
}
function objectValue(value: unknown, label: string): JsonObject { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ProteinValidationError(`${label} must be an object`); return value as JsonObject; }
function arrayValue(value: unknown, label: string): JsonValue[] { if (!Array.isArray(value)) throw new ProteinValidationError(`${label} must be an array`); return value as JsonValue[]; }
function stringValue(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0) throw new ProteinValidationError(`${label} must be a non-empty string`); return value; }
function numberParam(url: URL, name: string, fallback: number): number { const value = Number(url.searchParams.get(name)); return Number.isFinite(value) && value > 0 ? value : fallback; }
function errorResponse(error: unknown): Response { if (error instanceof ProteinError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "conflict" ? 409 : 400 }); console.error(error); return Response.json({ error: "internal_error", message: "Cell request failed" }, { status: 500 }); }
