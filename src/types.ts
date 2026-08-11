export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type EventStatus = "pending" | "processing" | "completed" | "failed";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";
export type ActionStatus =
  | "pending"
  | "delivering"
  | "delivered"
  | "failed"
  | "ambiguous";
export type ActionSafety = "idempotent" | "reconcilable" | "unsafe";

export interface AgentEvent<Payload extends JsonValue = JsonValue> {
  id: string;
  type: string;
  runId?: string;
  payload: Payload;
}

export interface AcceptedEvent {
  id: string;
  accepted: boolean;
  duplicate: boolean;
  status: EventStatus;
}

export interface StartRunInput<Goal extends JsonValue = JsonValue> {
  id: string;
  goal: Goal;
}

export interface RunRecord<Goal extends JsonValue = JsonValue> {
  id: string;
  status: RunStatus;
  goal: Goal;
  result: JsonValue | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ActionIntent<Payload extends JsonValue = JsonValue> {
  id: string;
  kind: string;
  payload: Payload;
  safety: ActionSafety;
}

export interface ActionRecord<Payload extends JsonValue = JsonValue> {
  id: string;
  eventId: string;
  runId: string | null;
  kind: string;
  payload: Payload;
  safety: ActionSafety;
  status: ActionStatus;
  attempts: number;
  dispatchStartedAt: number | null;
  result: JsonValue | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunTransition {
  status: RunStatus;
  result?: JsonValue;
  error?: string;
}

export interface AgentTransition<State extends JsonObject> {
  state?: State;
  run?: RunTransition;
  actions?: ActionIntent[];
  journal?: JsonValue;
}

export interface AgentEventContext<State extends JsonObject> {
  event: AgentEvent;
  state: Readonly<State>;
  attempt: number;
  now: number;
}

export interface ActionExecutionContext {
  action: ActionRecord;
  idempotencyKey: string;
}

export type ProteinCheckpoint =
  | "event.claimed"
  | "event.before_commit"
  | "event.committed"
  | "action.claimed"
  | "action.dispatch_started"
  | "action.reconciling"
  | "action.response_received"
  | "action.committed";

export interface ProteinCheckpointContext extends JsonObject {
  eventId: string | null;
  runId: string | null;
  actionId: string | null;
  attempt: number;
  revision: number;
}

export interface JournalRecord {
  sequence: number;
  kind: string;
  eventId: string | null;
  runId: string | null;
  actionId: string | null;
  data: JsonValue | null;
  createdAt: number;
}

export interface ProteinAgentOptions {
  eventLeaseMs: number;
  actionLeaseMs: number;
  maxEventAttempts: number;
  maxActionAttempts: number;
  queueRetryBaseDelayMs: number;
  queueRetryMaxDelayMs: number;
}

export const DEFAULT_PROTEIN_OPTIONS: ProteinAgentOptions = {
  eventLeaseMs: 60_000,
  actionLeaseMs: 120_000,
  maxEventAttempts: 5,
  maxActionAttempts: 5,
  queueRetryBaseDelayMs: 250,
  queueRetryMaxDelayMs: 30_000,
};
