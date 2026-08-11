import { DurableObject } from "cloudflare:workers";
import { ProteinConflictError, ProteinValidationError } from "./errors";
import { canonicalJson, errorMessage, parseJson } from "./json";
import {
  DEFAULT_PROTEIN_OPTIONS,
  type AcceptedEvent,
  type ActionExecutionContext,
  type ActionIntent,
  type ActionRecord,
  type ActionSafety,
  type ActionStatus,
  type AgentEvent,
  type AgentEventContext,
  type AgentTransition,
  type EventStatus,
  type JournalRecord,
  type JsonObject,
  type JsonValue,
  type ProteinAgentOptions,
  type ProteinCheckpoint,
  type ProteinCheckpointContext,
  type RunRecord,
  type RunStatus,
  type StartRunInput,
} from "./types";

interface EventRow {
  id: string;
  type: string;
  run_id: string | null;
  payload: string;
  status: EventStatus;
  revision: number;
  attempts: number;
  available_at: number;
  lease_until: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  status: RunStatus;
  goal: string;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface ActionRow {
  id: string;
  event_id: string;
  run_id: string | null;
  kind: string;
  payload: string;
  safety: ActionSafety;
  status: ActionStatus;
  revision: number;
  attempts: number;
  dispatch_started_at: number | null;
  available_at: number;
  lease_until: number | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface JournalRow {
  sequence: number;
  kind: string;
  event_id: string | null;
  run_id: string | null;
  action_id: string | null;
  data: string | null;
  created_at: number;
}

interface ClaimedEvent {
  row: EventRow;
  revision: number;
}

interface ClaimedAction {
  row: ActionRow;
  revision: number;
}

interface QueueEventPayload {
  eventId: string;
}

interface QueueActionPayload {
  actionId: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;

export abstract class ProteinAgent<
  Env extends Cloudflare.Env,
  State extends JsonObject,
> extends DurableObject<Env> {
  abstract initialState: State;
  protected proteinOptions: ProteinAgentOptions = DEFAULT_PROTEIN_OPTIONS;
  private cachedState: State | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureProteinSchema();
  }

  get name(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  get state(): State {
    if (this.cachedState !== undefined) return this.cachedState;
    const row = this.first<{ state: string }>(
      "SELECT state FROM protein_state WHERE id = 'current'",
    );
    this.cachedState =
      row === undefined ? this.initialState : parseJson<State>(row.state);
    return this.cachedState;
  }

  protected setState(state: State): void {
    this.persistState(state);
    this.cachedState = state;
    this.broadcast({ type: "protein.state", state });
  }

  private persistState(state: State): void {
    const serialized = canonicalJson(state);
    this.exec(
      `INSERT INTO protein_state (id, state) VALUES ('current', ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state`,
      serialized,
    );
  }

  protected abstract onAgentEvent(
    context: AgentEventContext<State>,
  ): Promise<AgentTransition<State>>;

  protected async executeAction(
    _context: ActionExecutionContext,
  ): Promise<JsonValue> {
    throw new Error("No action executor is configured for this agent");
  }

  protected async reconcileAction(
    _context: ActionExecutionContext,
  ): Promise<JsonValue | undefined> {
    return undefined;
  }

  protected async onProteinCheckpoint(
    _checkpoint: ProteinCheckpoint,
    _context: ProteinCheckpointContext,
  ): Promise<void> {}

  protected abstract onRequest(request: Request): Promise<Response>;

  protected onMessage(_webSocket: WebSocket, _message: string | ArrayBuffer): void {}

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ connectedAt: Date.now() });
      server.send(
        JSON.stringify({ type: "protein.connected", agent: this.name, state: this.state }),
      );
      return new Response(null, { status: 101, webSocket: client });
    }
    return this.onRequest(request);
  }

  override webSocketMessage(
    webSocket: WebSocket,
    message: string | ArrayBuffer,
  ): void {
    this.onMessage(webSocket, message);
  }

  override webSocketClose(
    webSocket: WebSocket,
    code: number,
    reason: string,
  ): void {
    webSocket.close(code, reason);
  }

  override async alarm(): Promise<void> {
    try {
      const action = this.nextRunnableAction();
      if (action !== undefined) {
        await this.processProteinAction({ actionId: action.id });
        return;
      }

      const event = this.nextRunnableEvent();
      if (event !== undefined) {
        await this.processProteinEvent({ eventId: event.id });
      }
    } finally {
      await this.reconcileAlarm();
    }
  }

  async startRun(input: StartRunInput): Promise<RunRecord> {
    validateIdentifier(input.id, "run id");
    const now = Date.now();
    const goal = canonicalJson(input.goal);
    const eventId = `run:${input.id}:requested`;

    this.ctx.storage.transactionSync(() => {
      const existing = this.first<RunRow>(
        "SELECT * FROM protein_runs WHERE id = ?",
        input.id,
      );

      if (existing !== undefined) {
        if (existing.goal !== goal) {
          throw new ProteinConflictError(
            `Run ${input.id} already exists with a different goal`,
          );
        }
      } else {
        this.exec(
          `INSERT INTO protein_runs
            (id, status, goal, result, error, created_at, updated_at)
           VALUES (?, 'queued', ?, NULL, NULL, ?, ?)`,
          input.id,
          goal,
          now,
          now,
        );
        this.appendJournal("run.accepted", null, input.id, null, input.goal, now);
      }

      const event = this.first<EventRow>(
        "SELECT * FROM protein_events WHERE id = ?",
        eventId,
      );
      if (event === undefined) {
        this.exec(
          `INSERT INTO protein_events
            (id, type, run_id, payload, status, revision, attempts, lease_until,
             available_at, error, created_at, updated_at)
           VALUES (?, 'protein.run.requested', ?, ?, 'pending', 0, 0, NULL,
                   ?, NULL, ?, ?)`,
          eventId,
          input.id,
          goal,
          now,
          now,
          now,
        );
        this.appendJournal(
          "event.accepted",
          eventId,
          input.id,
          null,
          { type: "protein.run.requested" },
          now,
        );
      } else if (
        event.type !== "protein.run.requested" ||
        event.run_id !== input.id ||
        event.payload !== goal
      ) {
        throw new ProteinConflictError(
          `Run admission event ${eventId} conflicts with existing content`,
        );
      }
    });

    await this.reconcileAlarm();

    const run = this.getRun(input.id);
    if (run === undefined) {
      throw new Error(`Run ${input.id} disappeared after admission`);
    }
    return run;
  }

  async acceptEvent(input: AgentEvent): Promise<AcceptedEvent> {
    validateIdentifier(input.id, "event id");
    validateIdentifier(input.type, "event type");
    if (input.runId !== undefined) validateIdentifier(input.runId, "run id");

    const payload = canonicalJson(input.payload);
    const now = Date.now();
    let accepted = false;
    let status: EventStatus = "pending";

    this.ctx.storage.transactionSync(() => {
      const existing = this.first<EventRow>(
        "SELECT * FROM protein_events WHERE id = ?",
        input.id,
      );

      if (existing !== undefined) {
        if (
          existing.type !== input.type ||
          existing.run_id !== (input.runId ?? null) ||
          existing.payload !== payload
        ) {
          throw new ProteinConflictError(
            `Event ${input.id} was reused with different content`,
          );
        }
        status = existing.status;
        return;
      }

      this.exec(
        `INSERT INTO protein_events
          (id, type, run_id, payload, status, revision, attempts, lease_until,
           available_at, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, 0, NULL, ?, NULL, ?, ?)`,
        input.id,
        input.type,
        input.runId ?? null,
        payload,
        now,
        now,
        now,
      );
      this.appendJournal(
        "event.accepted",
        input.id,
        input.runId ?? null,
        null,
        { type: input.type },
        now,
      );
      accepted = true;
    });

    if (status === "pending" || status === "processing") {
      await this.reconcileAlarm();
    }

    return {
      id: input.id,
      accepted,
      duplicate: !accepted,
      status,
    };
  }

  async processProteinEvent(payload: QueueEventPayload): Promise<void> {
    const claim = this.claimEvent(payload.eventId);
    if (claim === undefined) {
      return;
    }

    const checkpoint = this.eventCheckpointContext(claim);
    await this.onProteinCheckpoint("event.claimed", checkpoint);
    let committed = false;
    try {
      const transition = await this.onAgentEvent({
        event: this.eventFromRow(claim.row),
        state: this.state,
        attempt: claim.row.attempts + 1,
        now: Date.now(),
      });
      await this.onProteinCheckpoint("event.before_commit", checkpoint);
      committed = this.commitEvent(claim, transition);
    } catch (error) {
      const terminal = claim.row.attempts + 1 >= this.proteinOptions.maxEventAttempts;
      this.failOrRetryEvent(claim, errorMessage(error), terminal);
      return;
    }
    if (committed) {
      await this.onProteinCheckpoint("event.committed", checkpoint);
    }
  }

  async processProteinAction(payload: QueueActionPayload): Promise<void> {
    const existing = this.getActionRow(payload.actionId);
    if (
      existing?.status === "delivered" ||
      existing?.status === "failed" ||
      existing?.status === "ambiguous"
    ) {
      this.ensureActionOutcomeEvent(existing);
      return;
    }

    const claim = this.claimAction(payload.actionId);
    if (claim === undefined) return;

    const checkpoint = this.actionCheckpointContext(claim);
    await this.onProteinCheckpoint("action.claimed", checkpoint);

    if (
      claim.row.safety === "unsafe" &&
      claim.row.dispatch_started_at !== null
    ) {
      const committed = this.commitActionOutcome(
        claim,
        "ambiguous",
        null,
        "The prior unsafe dispatch lost its receipt; Protein will not call it again",
      );
      if (committed !== undefined) {
        await this.onProteinCheckpoint("action.committed", checkpoint);
      }
      return;
    }

    try {
      let dispatchRow = this.currentClaimedActionRow(claim);
      const executionContext = (): ActionExecutionContext => ({
        action: this.actionFromRow(dispatchRow),
        idempotencyKey: claim.row.id,
      });

      if (claim.row.safety === "reconcilable") {
        await this.onProteinCheckpoint("action.reconciling", checkpoint);
        const reconciled = await this.reconcileAction(executionContext());
        if (reconciled !== undefined) {
          const committed = this.commitActionOutcome(
            claim,
            "delivered",
            reconciled,
            null,
          );
          if (committed !== undefined) {
            await this.onProteinCheckpoint("action.committed", checkpoint);
          }
          return;
        }
      }

      const marked = this.markActionDispatchStarted(claim);
      if (marked === undefined) return;
      dispatchRow = marked;
      await this.onProteinCheckpoint("action.dispatch_started", checkpoint);
      const result = await this.executeAction(executionContext());
      await this.onProteinCheckpoint("action.response_received", checkpoint);
      const committed = this.commitActionOutcome(
        claim,
        "delivered",
        result,
        null,
      );
      if (committed !== undefined) {
        await this.onProteinCheckpoint("action.committed", checkpoint);
      }
    } catch (error) {
      const message = errorMessage(error);
      if (claim.row.safety === "unsafe") {
        const committed = this.commitActionOutcome(
          claim,
          "ambiguous",
          null,
          message,
        );
        if (committed !== undefined) {
          await this.onProteinCheckpoint("action.committed", checkpoint);
        }
        return;
      }

      const terminal =
        claim.row.attempts + 1 >= this.proteinOptions.maxActionAttempts;
      const committed = this.failOrRetryAction(claim, message, terminal);
      if (terminal && committed !== undefined) {
        await this.onProteinCheckpoint("action.committed", checkpoint);
        return;
      }
      return;
    }
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.first<RunRow>("SELECT * FROM protein_runs WHERE id = ?", id);
    return row === undefined ? undefined : this.runFromRow(row);
  }

  listRuns(limit = 50): RunRecord[] {
    const safeLimit = boundedLimit(limit);
    return this.rows<RunRow>(
      "SELECT * FROM protein_runs ORDER BY created_at DESC LIMIT ?",
      safeLimit,
    ).map((row) => this.runFromRow(row));
  }

  listActions(limit = 50): ActionRecord[] {
    const safeLimit = boundedLimit(limit);
    return this.rows<ActionRow>(
      "SELECT * FROM protein_actions ORDER BY created_at DESC LIMIT ?",
      safeLimit,
    ).map((row) => this.actionFromRow(row));
  }

  listJournal(limit = 100): JournalRecord[] {
    const safeLimit = boundedLimit(limit, 500);
    return this.rows<JournalRow>(
      "SELECT * FROM protein_journal ORDER BY sequence DESC LIMIT ?",
      safeLimit,
    ).map((row) => ({
      sequence: row.sequence,
      kind: row.kind,
      eventId: row.event_id,
      runId: row.run_id,
      actionId: row.action_id,
      data: row.data === null ? null : parseJson(row.data),
      createdAt: row.created_at,
    }));
  }

  private ensureProteinSchema(): void {
    this.ctx.storage.transactionSync(() => {
      this.exec(`CREATE TABLE IF NOT EXISTS protein_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
      this.exec(`CREATE TABLE IF NOT EXISTS protein_state (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL
      )`);
      this.exec(`CREATE TABLE IF NOT EXISTS protein_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        goal TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      this.exec(`CREATE TABLE IF NOT EXISTS protein_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        run_id TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        lease_until INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      this.exec(
        "CREATE INDEX IF NOT EXISTS protein_events_status ON protein_events(status, created_at)",
      );
      this.exec(`CREATE TABLE IF NOT EXISTS protein_actions (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        run_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        safety TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        dispatch_started_at INTEGER,
        available_at INTEGER NOT NULL,
        lease_until INTEGER,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      const actionColumns = this.rows<{ name: string }>(
        "PRAGMA table_info(protein_actions)",
      );
      if (!actionColumns.some((column) => column.name === "dispatch_started_at")) {
        this.exec(
          "ALTER TABLE protein_actions ADD COLUMN dispatch_started_at INTEGER",
        );
      }
      this.exec(
        "CREATE INDEX IF NOT EXISTS protein_actions_status ON protein_actions(status, created_at)",
      );
      this.exec(`CREATE TABLE IF NOT EXISTS protein_journal (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        event_id TEXT,
        run_id TEXT,
        action_id TEXT,
        data TEXT,
        created_at INTEGER NOT NULL
      )`);
      this.exec(
        `INSERT INTO protein_meta (key, value) VALUES ('schema_version', '2')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
    });
  }

  private claimEvent(id: string): ClaimedEvent | undefined {
    const now = Date.now();
    let claim: ClaimedEvent | undefined;

    this.ctx.storage.transactionSync(() => {
      const row = this.first<EventRow>(
        "SELECT * FROM protein_events WHERE id = ?",
        id,
      );
      if (row === undefined || row.status === "completed" || row.status === "failed") {
        return;
      }
      if (row.status === "pending" && row.available_at > now) return;
      if (row.status === "processing" && (row.lease_until ?? 0) > now) return;

      const revision = row.revision + 1;
      this.exec(
        `UPDATE protein_events
         SET status = 'processing', revision = ?, attempts = attempts + 1,
             lease_until = ?, error = NULL, updated_at = ?
         WHERE id = ? AND revision = ?`,
        revision,
        now + this.proteinOptions.eventLeaseMs,
        now,
        id,
        row.revision,
      );
      claim = { row, revision };
      this.appendJournal(
        "event.claimed",
        id,
        row.run_id,
        null,
        { attempt: row.attempts + 1, revision },
        now,
      );
    });

    return claim;
  }

  private commitEvent(
    claim: ClaimedEvent,
    transition: AgentTransition<State>,
  ): boolean {
    const now = Date.now();
    let committed = false;

    this.ctx.storage.transactionSync(() => {
      const current = this.first<EventRow>(
        "SELECT * FROM protein_events WHERE id = ?",
        claim.row.id,
      );
      if (
        current === undefined ||
        current.status !== "processing" ||
        current.revision !== claim.revision
      ) {
        return;
      }

      if (transition.state !== undefined) this.persistState(transition.state);
      if (transition.run !== undefined) {
        if (claim.row.run_id === null) {
          throw new ProteinValidationError(
            `Event ${claim.row.id} cannot update a run because it has no runId`,
          );
        }
        this.exec(
          `UPDATE protein_runs
           SET status = ?, result = ?, error = ?, updated_at = ?
           WHERE id = ?`,
          transition.run.status,
          transition.run.result === undefined
            ? null
            : canonicalJson(transition.run.result),
          transition.run.error ?? null,
          now,
          claim.row.run_id,
        );
      }

      for (const action of transition.actions ?? []) {
        this.insertAction(claim.row, action, now);
      }

      this.exec(
        `UPDATE protein_events
         SET status = 'completed', revision = revision + 1, lease_until = NULL,
             error = NULL, updated_at = ?
         WHERE id = ? AND revision = ?`,
        now,
        claim.row.id,
        claim.revision,
      );
      this.appendJournal(
        "event.completed",
        claim.row.id,
        claim.row.run_id,
        null,
        transition.journal ?? null,
        now,
      );
      committed = true;
    });

    if (committed && transition.state !== undefined) {
      this.cachedState = transition.state;
      this.broadcast({ type: "protein.state", state: transition.state });
    }

    return committed;
  }

  private failOrRetryEvent(
    claim: ClaimedEvent,
    message: string,
    terminal: boolean,
  ): void {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const status: EventStatus = terminal ? "failed" : "pending";
      const availableAt = terminal
        ? now
        : now + retryBackoffMs(claim.row.attempts + 1, this.proteinOptions);
      this.exec(
        `UPDATE protein_events
         SET status = ?, revision = revision + 1, lease_until = NULL,
             available_at = ?, error = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
        status,
        availableAt,
        message,
        now,
        claim.row.id,
        claim.revision,
      );
      if (terminal && claim.row.run_id !== null) {
        this.exec(
          `UPDATE protein_runs SET status = 'failed', error = ?, updated_at = ?
           WHERE id = ?`,
          message,
          now,
          claim.row.run_id,
        );
      }
      this.appendJournal(
        terminal ? "event.failed" : "event.retrying",
        claim.row.id,
        claim.row.run_id,
        null,
        { error: message },
        now,
      );
    });
  }

  private insertAction(row: EventRow, action: ActionIntent, now: number): void {
    validateIdentifier(action.id, "action id");
    validateIdentifier(action.kind, "action kind");
    const payload = canonicalJson(action.payload);
    const existing = this.first<ActionRow>(
      "SELECT * FROM protein_actions WHERE id = ?",
      action.id,
    );

    if (existing !== undefined) {
      if (
        existing.kind !== action.kind ||
        existing.payload !== payload ||
        existing.safety !== action.safety ||
        existing.run_id !== row.run_id
      ) {
        throw new ProteinConflictError(
          `Action ${action.id} was reused with different content`,
        );
      }
      return;
    }

    this.exec(
      `INSERT INTO protein_actions
        (id, event_id, run_id, kind, payload, safety, status, revision,
         attempts, dispatch_started_at, available_at, lease_until, result, error,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, NULL, ?, NULL, NULL, NULL, ?, ?)`,
      action.id,
      row.id,
      row.run_id,
      action.kind,
      payload,
      action.safety,
      now,
      now,
      now,
    );
    this.appendJournal(
      "action.committed",
      row.id,
      row.run_id,
      action.id,
      { kind: action.kind, safety: action.safety },
      now,
    );
  }

  private claimAction(id: string): ClaimedAction | undefined {
    const now = Date.now();
    let claim: ClaimedAction | undefined;
    this.ctx.storage.transactionSync(() => {
      const row = this.getActionRow(id);
      if (
        row === undefined ||
        row.status === "delivered" ||
        row.status === "failed" ||
        row.status === "ambiguous"
      ) {
        return;
      }
      if (row.status === "pending" && row.available_at > now) return;
      if (row.status === "delivering" && (row.lease_until ?? 0) > now) return;

      const revision = row.revision + 1;
      this.exec(
        `UPDATE protein_actions
         SET status = 'delivering', revision = ?, attempts = attempts + 1,
             lease_until = ?, error = NULL, updated_at = ?
         WHERE id = ? AND revision = ?`,
        revision,
        now + this.proteinOptions.actionLeaseMs,
        now,
        id,
        row.revision,
      );
      claim = { row, revision };
      this.appendJournal(
        "action.claimed",
        row.event_id,
        row.run_id,
        row.id,
        { attempt: row.attempts + 1, revision },
        now,
      );
    });
    return claim;
  }

  private currentClaimedActionRow(claim: ClaimedAction): ActionRow {
    return {
      ...claim.row,
      status: "delivering",
      revision: claim.revision,
      attempts: claim.row.attempts + 1,
      lease_until: Date.now() + this.proteinOptions.actionLeaseMs,
    };
  }

  private markActionDispatchStarted(
    claim: ClaimedAction,
  ): ActionRow | undefined {
    const now = Date.now();
    let marked: ActionRow | undefined;
    this.ctx.storage.transactionSync(() => {
      const current = this.getActionRow(claim.row.id);
      if (
        current === undefined ||
        current.status !== "delivering" ||
        current.revision !== claim.revision
      ) {
        return;
      }
      if (current.dispatch_started_at === null) {
        this.exec(
          `UPDATE protein_actions
           SET dispatch_started_at = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
          now,
          now,
          current.id,
          claim.revision,
        );
        this.appendJournal(
          "action.dispatch_started",
          current.event_id,
          current.run_id,
          current.id,
          { revision: claim.revision },
          now,
        );
      }
      marked = this.getActionRow(claim.row.id);
    });
    return marked;
  }

  private commitActionOutcome(
    claim: ClaimedAction,
    status: "delivered" | "ambiguous",
    result: JsonValue | null,
    error: string | null,
  ): ActionRow | undefined {
    const now = Date.now();
    let committed: ActionRow | undefined;
    this.ctx.storage.transactionSync(() => {
      const current = this.getActionRow(claim.row.id);
      if (
        current === undefined ||
        current.status !== "delivering" ||
        current.revision !== claim.revision
      ) {
        return;
      }
      this.exec(
        `UPDATE protein_actions
         SET status = ?, revision = revision + 1, lease_until = NULL,
             result = ?, error = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
        status,
        result === null ? null : canonicalJson(result),
        error,
        now,
        claim.row.id,
        claim.revision,
      );
      this.appendJournal(
        status === "delivered" ? "action.delivered" : "action.ambiguous",
        claim.row.event_id,
        claim.row.run_id,
        claim.row.id,
        error === null ? result : { error },
        now,
      );
      committed = this.getActionRow(claim.row.id);
      if (committed !== undefined) {
        this.insertActionOutcomeEvent(committed, now);
      }
    });
    return committed;
  }

  private failOrRetryAction(
    claim: ClaimedAction,
    message: string,
    terminal: boolean,
  ): ActionRow | undefined {
    const now = Date.now();
    let committed: ActionRow | undefined;
    this.ctx.storage.transactionSync(() => {
      const availableAt = terminal
        ? now
        : now + retryBackoffMs(claim.row.attempts + 1, this.proteinOptions);
      this.exec(
        `UPDATE protein_actions
         SET status = ?, revision = revision + 1, lease_until = NULL,
             available_at = ?, error = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
        terminal ? "failed" : "pending",
        availableAt,
        message,
        now,
        claim.row.id,
        claim.revision,
      );
      this.appendJournal(
        terminal ? "action.failed" : "action.retrying",
        claim.row.event_id,
        claim.row.run_id,
        claim.row.id,
        { error: message },
        now,
      );
      committed = this.getActionRow(claim.row.id);
      if (terminal && committed !== undefined) {
        this.insertActionOutcomeEvent(committed, now);
      }
    });
    return committed;
  }

  private ensureActionOutcomeEvent(action: ActionRow): void {
    this.ctx.storage.transactionSync(() => {
      this.insertActionOutcomeEvent(action, Date.now());
    });
  }

  private insertActionOutcomeEvent(action: ActionRow, now: number): void {
    if (
      action.status !== "delivered" &&
      action.status !== "failed" &&
      action.status !== "ambiguous"
    ) {
      return;
    }
    const payload: JsonObject = {
      actionId: action.id,
      kind: action.kind,
      status: action.status,
      result: action.result === null ? null : parseJson(action.result),
      error: action.error,
    };
    const id = `action:${action.id}:${action.status}`;
    const type = `protein.action.${action.status}`;
    const serialized = canonicalJson(payload);
    const existing = this.first<EventRow>(
      "SELECT * FROM protein_events WHERE id = ?",
      id,
    );
    if (existing !== undefined) {
      if (
        existing.type !== type ||
        existing.run_id !== action.run_id ||
        existing.payload !== serialized
      ) {
        throw new ProteinConflictError(
          `Action outcome event ${id} conflicts with existing content`,
        );
      }
      return;
    }

    this.exec(
      `INSERT INTO protein_events
        (id, type, run_id, payload, status, revision, attempts, lease_until,
         available_at, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, 0, NULL, ?, NULL, ?, ?)`,
      id,
      type,
      action.run_id,
      serialized,
      now,
      now,
      now,
    );
    this.appendJournal(
      "event.accepted",
      id,
      action.run_id,
      action.id,
      { type },
      now,
    );
  }

  private nextRunnableEvent(): EventRow | undefined {
    const now = Date.now();
    return this.first<EventRow>(
      `SELECT * FROM protein_events
       WHERE (status = 'pending' AND available_at <= ?)
          OR (status = 'processing' AND lease_until <= ?)
       ORDER BY created_at ASC LIMIT 1`,
      now,
      now,
    );
  }

  private nextRunnableAction(): ActionRow | undefined {
    const now = Date.now();
    return this.first<ActionRow>(
      `SELECT * FROM protein_actions
       WHERE (status = 'pending' AND available_at <= ?)
          OR (status = 'delivering' AND lease_until <= ?)
       ORDER BY created_at ASC LIMIT 1`,
      now,
      now,
    );
  }

  private async reconcileAlarm(): Promise<void> {
    const eventDue = this.first<{ due: number | null }>(
      `SELECT MIN(
         CASE WHEN status = 'pending' THEN available_at ELSE lease_until END
       ) AS due
       FROM protein_events
       WHERE status IN ('pending', 'processing')`,
    )?.due;
    const actionDue = this.first<{ due: number | null }>(
      `SELECT MIN(
         CASE WHEN status = 'pending' THEN available_at ELSE lease_until END
       ) AS due
       FROM protein_actions
       WHERE status IN ('pending', 'delivering')`,
    )?.due;
    const due = [eventDue, actionDue].filter(
      (value): value is number => typeof value === "number",
    );

    if (due.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(Math.max(Date.now(), Math.min(...due)));
  }

  private broadcast(value: JsonValue): void {
    const message = JSON.stringify(value);
    for (const webSocket of this.ctx.getWebSockets()) {
      try {
        webSocket.send(message);
      } catch {
        // The host owns socket lifecycle; a later close event removes it.
      }
    }
  }

  private eventCheckpointContext(
    claim: ClaimedEvent,
  ): ProteinCheckpointContext {
    return {
      eventId: claim.row.id,
      runId: claim.row.run_id,
      actionId: null,
      attempt: claim.row.attempts + 1,
      revision: claim.revision,
    };
  }

  private actionCheckpointContext(
    claim: ClaimedAction,
  ): ProteinCheckpointContext {
    return {
      eventId: claim.row.event_id,
      runId: claim.row.run_id,
      actionId: claim.row.id,
      attempt: claim.row.attempts + 1,
      revision: claim.revision,
    };
  }

  private eventFromRow(row: EventRow): AgentEvent {
    return {
      id: row.id,
      type: row.type,
      ...(row.run_id === null ? {} : { runId: row.run_id }),
      payload: parseJson(row.payload),
    };
  }

  private runFromRow(row: RunRow): RunRecord {
    return {
      id: row.id,
      status: row.status,
      goal: parseJson(row.goal),
      result: row.result === null ? null : parseJson(row.result),
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private actionFromRow(row: ActionRow): ActionRecord {
    return {
      id: row.id,
      eventId: row.event_id,
      runId: row.run_id,
      kind: row.kind,
      payload: parseJson(row.payload),
      safety: row.safety,
      status: row.status,
      attempts: row.attempts,
      dispatchStartedAt: row.dispatch_started_at,
      result: row.result === null ? null : parseJson(row.result),
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getActionRow(id: string): ActionRow | undefined {
    return this.first<ActionRow>("SELECT * FROM protein_actions WHERE id = ?", id);
  }

  private appendJournal(
    kind: string,
    eventId: string | null,
    runId: string | null,
    actionId: string | null,
    data: JsonValue,
    now: number,
  ): void {
    this.exec(
      `INSERT INTO protein_journal
        (kind, event_id, run_id, action_id, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      kind,
      eventId,
      runId,
      actionId,
      canonicalJson(data),
      now,
    );
  }

  private rows<T>(query: string, ...values: SqlStorageValue[]): T[] {
    return [...this.ctx.storage.sql.exec(query, ...values)] as T[];
  }

  private first<T>(query: string, ...values: SqlStorageValue[]): T | undefined {
    return this.rows<T>(query, ...values)[0];
  }

  private exec(query: string, ...values: SqlStorageValue[]): void {
    this.ctx.storage.sql.exec(query, ...values);
  }
}

type SqlStorageValue = string | number | ArrayBuffer | null;

function validateIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new ProteinValidationError(
      `${label} must match ${IDENTIFIER_PATTERN.toString()}`,
    );
  }
}

function boundedLimit(value: number, maximum = 100): number {
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, maximum);
}

function retryBackoffMs(
  attempt: number,
  options: ProteinAgentOptions,
): number {
  return Math.min(
    options.queueRetryMaxDelayMs,
    options.queueRetryBaseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
}
