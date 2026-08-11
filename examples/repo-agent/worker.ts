import {
  ProteinAgent,
  ProteinError,
  ProteinValidationError,
  type ActionExecutionContext,
  type ActionSafety,
  type AgentEventContext,
  type AgentTransition,
  type JsonObject,
  type JsonValue,
  type ProteinCheckpoint,
  type ProteinCheckpointContext,
} from "../../src/index";

interface Env extends Cloudflare.Env {
  REPO_AGENT: DurableObjectNamespace<RepoAgent>;
  EXECUTOR_URL: string;
  PROTEIN_LEASE_MS?: string;
  PROTEIN_CHECKPOINT_URL?: string;
  PROTEIN_NODE_ID?: string;
}

type RepoState = JsonObject & {
  repository: string | null;
  activeRunId: string | null;
  completedRuns: number;
  lastSummary: string | null;
};

interface RepoGoal extends JsonObject {
  repository: string;
  task: string;
  revision?: string;
  safety?: ActionSafety;
}

export class RepoAgent extends ProteinAgent<Env, RepoState> {
  initialState: RepoState = {
    repository: null,
    activeRunId: null,
    completedRuns: 0,
    lastSummary: null,
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
    context: AgentEventContext<RepoState>,
  ): Promise<AgentTransition<RepoState>> {
    const state = normalizeState(context.state);

    if (context.event.type === "protein.run.requested") {
      if (context.event.runId === undefined) {
        throw new ProteinValidationError("A requested run must have a runId");
      }
      const goal = parseRepoGoal(context.event.payload);
      return {
        state: {
          ...state,
          repository: goal.repository,
          activeRunId: context.event.runId,
        },
        run: { status: "running" },
        actions: [
          {
            id: `run:${context.event.runId}:execute`,
            kind: "repo.execute",
            safety: goal.safety ?? "idempotent",
            payload: {
              repository: goal.repository,
              task: goal.task,
              revision: goal.revision ?? null,
            },
          },
        ],
        journal: { phase: "executor_requested" },
      };
    }

    if (context.event.type === "protein.action.delivered") {
      const result = actionResult(context.event.payload);
      return {
        state: {
          ...state,
          activeRunId: null,
          completedRuns: state.completedRuns + 1,
          lastSummary: result.summary,
        },
        run: { status: "completed", result },
        journal: { phase: "executor_completed" },
      };
    }

    if (
      context.event.type === "protein.action.failed" ||
      context.event.type === "protein.action.ambiguous"
    ) {
      const payload = objectValue(context.event.payload, "action outcome");
      const message =
        typeof payload.error === "string"
          ? payload.error
          : `Executor action ended as ${String(payload.status)}`;
      return {
        state: { ...state, activeRunId: null },
        run: { status: "failed", error: message },
        journal: { phase: "executor_failed", error: message },
      };
    }

    return { state, journal: { phase: "event_ignored" } };
  }

  protected override async executeAction(
    context: ActionExecutionContext,
  ): Promise<JsonValue> {
    if (context.action.kind !== "repo.execute") {
      throw new ProteinValidationError(
        `Unsupported action kind ${context.action.kind}`,
      );
    }

    const executorUrl = new URL("/jobs", this.env.EXECUTOR_URL).toString();
    console.log("dispatching durable action", context.action.id, executorUrl);
    const response = await fetch(executorUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": context.idempotencyKey,
        ...(this.env.PROTEIN_NODE_ID === undefined
          ? {}
          : { "x-protein-node": this.env.PROTEIN_NODE_ID }),
      },
      body: JSON.stringify({
        agent: this.name,
        runId: context.action.runId,
        ...objectValue(context.action.payload, "executor payload"),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Executor returned ${response.status}: ${body.slice(0, 500)}`);
    }

    return (await response.json()) as JsonValue;
  }

  protected override async reconcileAction(
    context: ActionExecutionContext,
  ): Promise<JsonValue | undefined> {
    const lookupUrl = new URL(
      `/jobs/${encodeURIComponent(context.idempotencyKey)}`,
      this.env.EXECUTOR_URL,
    ).toString();
    const response = await fetch(lookupUrl, {
      headers:
        this.env.PROTEIN_NODE_ID === undefined
          ? {}
          : { "x-protein-node": this.env.PROTEIN_NODE_ID },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `Executor reconciliation returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    }
    return (await response.json()) as JsonValue;
  }

  protected override async onProteinCheckpoint(
    checkpoint: ProteinCheckpoint,
    context: ProteinCheckpointContext,
  ): Promise<void> {
    if (this.env.PROTEIN_CHECKPOINT_URL === undefined) return;
    const response = await fetch(
      new URL("/checkpoints", this.env.PROTEIN_CHECKPOINT_URL),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checkpoint,
          context,
          agent: this.name,
          node: this.env.PROTEIN_NODE_ID ?? null,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Checkpoint controller returned ${response.status}: ${await response.text()}`,
      );
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    try {
      return await this.routeRequest(request);
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async routeRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/executor-health") {
      const response = await fetch(
        new URL("/stats", this.env.EXECUTOR_URL).toString(),
      );
      return new Response(response.body, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/identity") {
      return Response.json({
        agent: this.name,
        node: this.env.PROTEIN_NODE_ID ?? null,
      });
    }

    if (request.method === "POST" && url.pathname === "/runs") {
      const body = objectValue(await request.json(), "run request");
      if (typeof body.id !== "string") {
        throw new ProteinValidationError("Run request requires a string id");
      }
      const goal = parseRepoGoal(body.goal);
      const run = await this.startRun({ id: body.id, goal });
      return Response.json(run, { status: 202 });
    }

    if (request.method === "POST" && url.pathname === "/events") {
      const body = objectValue(await request.json(), "event request");
      if (typeof body.id !== "string" || typeof body.type !== "string") {
        throw new ProteinValidationError("Event requires string id and type");
      }
      const accepted = await this.acceptEvent({
        id: body.id,
        type: body.type,
        ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
        payload: body.payload ?? null,
      });
      return Response.json(accepted, { status: accepted.accepted ? 202 : 200 });
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      return Response.json({ runs: this.listRuns(numberParam(url, "limit", 50)) });
    }

    const runMatch = /^\/runs\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && runMatch?.[1] !== undefined) {
      const run = this.getRun(decodeURIComponent(runMatch[1]));
      return run === undefined
        ? Response.json({ error: "run_not_found" }, { status: 404 })
        : Response.json(run);
    }

    if (request.method === "GET" && url.pathname === "/actions") {
      return Response.json({
        actions: this.listActions(numberParam(url, "limit", 50)),
      });
    }

    if (request.method === "GET" && url.pathname === "/journal") {
      return Response.json({
        journal: this.listJournal(numberParam(url, "limit", 100)),
      });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      return Response.json({ agent: this.name, state: normalizeState(this.state) });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/agents\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match?.[1] === undefined) {
      return Response.json(
        { error: "Use /agents/:name/runs, /state, /actions, or /journal" },
        { status: 404 },
      );
    }

    const name = decodeURIComponent(match[1]);
    if (name.length === 0 || name.length > 192) {
      return Response.json({ error: "invalid_agent_name" }, { status: 400 });
    }

    url.pathname = match[2] ?? "/state";
    const innerRequest = new Request(url, request);
    const id = env.REPO_AGENT.idFromName(name);
    return env.REPO_AGENT.get(id).fetch(innerRequest);
  },
};

function parseRepoGoal(value: unknown): RepoGoal {
  const goal = objectValue(value, "repo goal");
  if (typeof goal.repository !== "string" || goal.repository.length === 0) {
    throw new ProteinValidationError("Repo goal requires repository");
  }
  if (typeof goal.task !== "string" || goal.task.length === 0) {
    throw new ProteinValidationError("Repo goal requires task");
  }
  if (goal.revision !== undefined && typeof goal.revision !== "string") {
    throw new ProteinValidationError("Repo goal revision must be a string");
  }
  if (
    goal.safety !== undefined &&
    goal.safety !== "idempotent" &&
    goal.safety !== "reconcilable" &&
    goal.safety !== "unsafe"
  ) {
    throw new ProteinValidationError(
      "Repo goal safety must be idempotent, reconcilable, or unsafe",
    );
  }
  return {
    repository: goal.repository,
    task: goal.task,
    ...(typeof goal.revision === "string" ? { revision: goal.revision } : {}),
    ...(goal.safety === "idempotent" ||
    goal.safety === "reconcilable" ||
    goal.safety === "unsafe"
      ? { safety: goal.safety }
      : {}),
  };
}

function actionResult(value: unknown): JsonObject & { summary: string } {
  const payload = objectValue(value, "action outcome");
  const result = objectValue(payload.result, "executor result");
  if (typeof result.summary !== "string") {
    throw new ProteinValidationError("Executor result requires summary");
  }
  return { ...result, summary: result.summary };
}

function objectValue(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProteinValidationError(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function normalizeState(state: Readonly<RepoState>): RepoState {
  return {
    repository: typeof state.repository === "string" ? state.repository : null,
    activeRunId: typeof state.activeRunId === "string" ? state.activeRunId : null,
    completedRuns:
      typeof state.completedRuns === "number" ? state.completedRuns : 0,
    lastSummary: typeof state.lastSummary === "string" ? state.lastSummary : null,
  };
}

function numberParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function errorResponse(error: unknown): Response {
  if (error instanceof ProteinError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.code === "conflict" ? 409 : 400 },
    );
  }
  console.error(error);
  return Response.json(
    { error: "internal_error", message: "Agent request failed" },
    { status: 500 },
  );
}
