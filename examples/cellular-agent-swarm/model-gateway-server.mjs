import { createServer } from "node:http";
import { join, resolve } from "node:path";
import {
  PROMPT_VERSION,
  RESPONSES_PROTOCOL,
  TOOL_SCHEMA_SHA256,
  TOOL_SCHEMA_VERSION,
  buildAgentInstructions,
  buildInitialInput,
  createResponsesTurn,
} from "./openai-responses.mjs";
import {
  RequestError,
  bodyJson,
  boundedInteger,
  canonicalJson,
  createRecorder,
  createStateStore,
  integerValue,
  objectValue,
  percentile,
  publicError,
  sendJson,
  sha256,
  stringValue,
  validateReceiverRequest,
} from "./service-utils.mjs";

const root = process.cwd();
const port = boundedInteger(process.env.SWARM_MODEL_GATEWAY_PORT, 19121, 1_024, 65_535);
const statePath = resolve(process.env.SWARM_MODEL_GATEWAY_STATE ?? join(root, ".protein/cellular-agent-swarm/model-gateway-state.json"));
const logPath = resolve(process.env.SWARM_MODEL_GATEWAY_LOG ?? join(root, ".protein/cellular-agent-swarm/model-gateway.jsonl"));
const model = process.env.OPENAI_MODEL ?? "gpt-5.6-luna";
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const reasoningEffort = process.env.OPENAI_REASONING_EFFORT ?? "medium";
const maxOutputTokens = boundedInteger(process.env.SWARM_MODEL_MAX_OUTPUT_TOKENS, 1_200, 128, 8_192);
const providerTimeoutMs = boundedInteger(process.env.SWARM_MODEL_TIMEOUT_MS, 45_000, 5_000, 120_000);
const providerMaximumAttempts = boundedInteger(process.env.SWARM_MODEL_MAX_ATTEMPTS, 1, 1, 5);
const evidenceLevel = "celld-experiment";
const service = "protein-swarm-openai-responses-gateway";
const startedAt = new Date().toISOString();
const store = await createStateStore(statePath, {
  schemaVersion: 1,
  evidenceLevel,
  service,
  startedAt,
  actions: {},
  transcripts: {},
  metrics: freshMetrics(),
});
normalizeState(store.state);
const recorder = createRecorder(logPath, { evidenceLevel, service });
const pending = new Map();

const server = createServer(async (request, response) => {
  const started = performance.now();
  const method = request.method ?? "GET";
  let pathname = "/";
  let status = 500;
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    pathname = url.pathname;
    if (method === "GET" && pathname === "/health") {
      status = 200;
      return sendJson(response, status, {
        status: "ok",
        service,
        evidenceLevel,
        protocol: RESPONSES_PROTOCOL,
        model,
        promptVersion: PROMPT_VERSION,
        toolSchemaVersion: TOOL_SCHEMA_VERSION,
        toolSchemaSha256: TOOL_SCHEMA_SHA256,
      });
    }
    if (method === "GET" && pathname === "/stats") {
      status = 200;
      return sendJson(response, status, stats());
    }
    if (method === "GET" && pathname === "/snapshot") {
      status = 200;
      return sendJson(response, status, redactedSnapshot());
    }
    if (method === "POST" && pathname === "/actions") {
      const body = await bodyJson(request);
      const result = await receiveAction(request, body);
      status = result.status;
      return sendJson(response, status, result.body);
    }
    if (method === "GET" && pathname.startsWith("/actions/")) {
      const actionId = decodeURIComponent(pathname.slice("/actions/".length));
      const action = store.state.actions[actionId];
      if (action?.status === "completed") {
        status = 200;
        return sendJson(response, status, action.result);
      }
      status = 404;
      return sendJson(response, status, { error: action === undefined ? "receipt_not_found" : "receipt_pending" });
    }
    status = 404;
    return sendJson(response, status, { error: "not_found" });
  } catch (error) {
    const visible = publicError(error);
    status = visible.status;
    await recorder.record("request.failed", { method, pathname, status, error: visible.body });
    return sendJson(response, status, visible.body);
  } finally {
    store.state.metrics.requests += 1;
    if (status >= 500) store.state.metrics.serverErrors += 1;
    else if (status >= 400 && status !== 404) store.state.metrics.clientErrors += 1;
    const durationMs = fixed(performance.now() - started);
    store.state.metrics.routeMs.push(durationMs);
    if (store.state.metrics.routeMs.length > 500) store.state.metrics.routeMs.shift();
    void recorder.record("http.request", { method, pathname, status, durationMs });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Protein OpenAI Responses gateway: http://127.0.0.1:${port}`);
  void recorder.record("service.started", { port, pid: process.pid, model, protocol: RESPONSES_PROTOCOL });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => {
      void Promise.all([store.persist(), recorder.record("service.stopped", { signal })]).finally(() => process.exit(0));
    });
  });
}

async function receiveAction(request, body) {
  const validated = validateReceiverRequest(request, body);
  if (validated.kind !== "swarm.model.turn") {
    return { status: 400, body: { error: "unsupported_action_kind" } };
  }
  const existing = store.state.actions[validated.actionId];
  if (existing !== undefined && existing.requestHash !== validated.requestHash) {
    store.state.metrics.conflicts += 1;
    await recorder.record("action.conflict", { actionId: validated.actionId, requestHash: validated.requestHash });
    return { status: 409, body: { error: "action_id_conflict" } };
  }
  if (existing?.status === "completed") {
    store.state.metrics.duplicateActions += 1;
    return { status: 200, body: existing.result };
  }
  if (existing?.status === "rejected") {
    store.state.metrics.duplicateActions += 1;
    return { status: existing.httpStatus, body: existing.result };
  }
  const inflight = pending.get(validated.actionId);
  if (inflight !== undefined) return inflight;
  if (existing?.status === "in_progress" || existing?.status === "retryable") {
    store.state.metrics.ambiguousProviderAttempts += 1;
    await recorder.record("provider.retry_after_unfinished_receipt", { actionId: validated.actionId });
  }
  store.state.actions[validated.actionId] = {
    actionId: validated.actionId,
    requestHash: validated.requestHash,
    agent: validated.agent,
    kind: validated.kind,
    status: "in_progress",
    startedAt: Date.now(),
    providerAttempts: existing?.providerAttempts ?? [],
  };
  await store.persist();
  const operation = executeAction(validated)
    .catch(async (error) => {
      const visible = publicError(error);
      const action = store.state.actions[validated.actionId];
      Object.assign(action, {
        status: "rejected",
        completedAt: Date.now(),
        httpStatus: visible.status,
        result: visible.body,
      });
      await store.persist();
      await recorder.record("action.rejected", {
        actionId: validated.actionId,
        status: visible.status,
        error: visible.body,
      });
      return visible;
    })
    .finally(() => pending.delete(validated.actionId));
  pending.set(validated.actionId, operation);
  return operation;
}

async function executeAction(validated) {
  const payload = validated.payload;
  const loopId = stringValue(payload.loopId, "loopId", 512);
  const turn = integerValue(payload.turn, "turn", 0, 16);
  const maxTurns = integerValue(payload.maxTurns, "maxTurns", 1, 16);
  if (turn >= maxTurns) throw new RequestError(400, "turn_budget_exhausted", "turn must be below maxTurns");
  let transcript = store.state.transcripts[loopId];
  let functionOutputItem = null;
  if (turn === 0) {
    const observation = objectValue(payload.observation, "observation");
    const initialHash = sha256(canonicalJson({ agent: validated.agent, observation }));
    if (transcript === undefined) {
      transcript = {
        loopId,
        agent: validated.agent,
        experimentId: stringValue(observation.experimentId, "observation experimentId"),
        generation: integerValue(observation.generation, "observation generation", 1, 10_000),
        maxTurns,
        initialHash,
        promptVersion: PROMPT_VERSION,
        promptSha256: sha256(buildAgentInstructions(maxTurns)),
        toolSchemaVersion: TOOL_SCHEMA_VERSION,
        toolSchemaSha256: TOOL_SCHEMA_SHA256,
        input: buildInitialInput({ agent: validated.agent, observation }),
        turns: [],
        usage: emptyUsage(),
        rawReplayStored: true,
      };
      store.state.transcripts[loopId] = transcript;
      await store.persist();
    } else if (transcript.initialHash !== initialHash || transcript.agent !== validated.agent) {
      throw new RequestError(409, "loop_identity_conflict", "loopId was reused for a different observation");
    }
  } else {
    if (transcript === undefined) throw new RequestError(409, "missing_transcript", "A continuation turn requires an existing transcript");
    if (transcript.turns.length !== turn) {
      const prior = transcript.turns.find((entry) => entry.actionId === validated.actionId);
      if (prior !== undefined) return completeFromTranscript(validated, prior);
      throw new RequestError(409, "turn_sequence_conflict", `Expected transcript turn ${transcript.turns.length}, received ${turn}`);
    }
    const functionOutput = objectValue(payload.functionCallOutput, "functionCallOutput");
    const callId = stringValue(functionOutput.callId, "functionCallOutput callId", 512);
    const previous = transcript.turns.at(-1);
    if (previous?.functionCall?.callId !== callId) {
      throw new RequestError(409, "call_id_conflict", "function_call_output does not match the previous call_id");
    }
    functionOutputItem = {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(functionOutput.output ?? null),
    };
  }

  const action = store.state.actions[validated.actionId];
  try {
    const result = await createResponsesTurn({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl,
      model,
      input: functionOutputItem === null ? transcript.input : [...transcript.input, functionOutputItem],
      turn,
      maxTurns,
      reasoningEffort,
      maxOutputTokens,
      timeoutMs: providerTimeoutMs,
      maximumAttempts: providerMaximumAttempts,
      metadata: {
        experiment_id: transcript.experimentId.slice(0, 64),
        cell_id_hash: sha256(validated.agent).slice(0, 24),
        generation: String(transcript.generation),
        turn: String(turn),
        protocol: RESPONSES_PROTOCOL,
      },
    });
    if (functionOutputItem !== null) transcript.input.push(functionOutputItem);
    transcript.input.push(...result.output);
    addUsage(transcript.usage, result.usage);
    addUsage(store.state.metrics.usage, result.usage);
    store.state.metrics.providerRequests += result.attempts.length;
    store.state.metrics.providerRetries += Math.max(0, result.attempts.length - 1);
    store.state.metrics.ambiguousProviderAttempts += result.attempts.filter((attempt) => attempt.ambiguous).length;
    const normalized = {
      protocol: RESPONSES_PROTOCOL,
      loopId,
      turn,
      responseId: result.responseId,
      status: result.status,
      model: result.model,
      usage: result.usage,
      functionCall: result.functionCall,
      transcriptRef: `gateway://transcripts/${encodeURIComponent(loopId)}`,
      traceRef: `gateway://actions/${encodeURIComponent(validated.actionId)}`,
      clientRequestId: result.clientRequestId,
      providerRequestId: result.providerRequestId,
      attempts: result.attempts,
      promptVersion: PROMPT_VERSION,
      promptSha256: transcript.promptSha256,
      toolSchemaVersion: TOOL_SCHEMA_VERSION,
      toolSchemaSha256: TOOL_SCHEMA_SHA256,
    };
    const turnRecord = {
      actionId: validated.actionId,
      turn,
      responseId: result.responseId,
      model: result.model,
      usage: result.usage,
      functionCall: result.functionCall,
      outputItemTypes: result.output.map((item) => item?.type ?? "unknown"),
      providerRequestId: result.providerRequestId,
      clientRequestId: result.clientRequestId,
      attempts: result.attempts,
      completedAt: Date.now(),
      result: normalized,
    };
    transcript.turns.push(turnRecord);
    Object.assign(action, {
      status: "completed",
      completedAt: Date.now(),
      providerAttempts: [...(action.providerAttempts ?? []), ...result.attempts],
      result: normalized,
    });
    store.state.metrics.completedActions += 1;
    await store.persist();
    await recorder.record("model.turn.completed", {
      actionId: validated.actionId,
      loopIdHash: sha256(loopId),
      turn,
      responseId: result.responseId,
      model: result.model,
      providerRequestId: result.providerRequestId,
      clientRequestId: result.clientRequestId,
      functionName: result.functionCall.name,
      callIdHash: sha256(result.functionCall.callId),
      argumentsSha256: sha256(result.functionCall.arguments),
      argumentsBytes: Buffer.byteLength(result.functionCall.arguments),
      usage: result.usage,
      attempts: result.attempts,
    });
    return { status: 200, body: normalized };
  } catch (error) {
    const failedUsage = error?.usage !== undefined ? error.usage : null;
    if (failedUsage !== null) {
      addUsage(transcript.usage, failedUsage);
      addUsage(store.state.metrics.usage, failedUsage);
    }
    Object.assign(action, {
      status: "retryable",
      failedAt: Date.now(),
      error: safeProviderFailure(error),
      providerAttempts: [...(action.providerAttempts ?? []), ...(error?.attempts ?? [])],
    });
    store.state.metrics.providerFailures += 1;
    store.state.metrics.providerRequests += Array.isArray(error?.attempts) ? error.attempts.length : 0;
    store.state.metrics.providerRetries += Array.isArray(error?.attempts) ? Math.max(0, error.attempts.length - 1) : 0;
    store.state.metrics.ambiguousProviderAttempts += Array.isArray(error?.attempts)
      ? error.attempts.filter((attempt) => attempt.ambiguous).length
      : 0;
    await store.persist();
    await recorder.record("model.turn.failed", {
      actionId: validated.actionId,
      loopIdHash: sha256(loopId),
      turn,
      failure: safeProviderFailure(error),
    });
    return { status: 502, body: { error: "model_provider_failed", message: String(error?.message ?? error).slice(0, 500) } };
  }
}

async function completeFromTranscript(validated, prior) {
  const action = store.state.actions[validated.actionId];
  Object.assign(action, { status: "completed", completedAt: Date.now(), result: prior.result });
  await store.persist();
  return { status: 200, body: prior.result };
}

function stats() {
  return {
    schemaVersion: 1,
    evidenceLevel,
    service,
    startedAt: store.state.startedAt,
    protocol: RESPONSES_PROTOCOL,
    model,
    reasoningEffort,
    maxOutputTokens,
    providerTimeoutMs,
    providerMaximumAttempts,
    promptVersion: PROMPT_VERSION,
    toolSchemaVersion: TOOL_SCHEMA_VERSION,
    toolSchemaSha256: TOOL_SCHEMA_SHA256,
    actions: Object.keys(store.state.actions).length,
    transcripts: Object.keys(store.state.transcripts).length,
    ...store.state.metrics,
    routeMs: undefined,
    p50RouteMs: fixed(percentile(store.state.metrics.routeMs, 0.5)),
    p95RouteMs: fixed(percentile(store.state.metrics.routeMs, 0.95)),
  };
}

function redactedSnapshot() {
  return {
    schemaVersion: 1,
    evidenceLevel,
    service,
    startedAt: store.state.startedAt,
    actions: Object.fromEntries(Object.entries(store.state.actions).map(([id, action]) => [id, {
      actionId: id,
      requestHash: action.requestHash,
      agent: action.agent,
      status: action.status,
      startedAt: action.startedAt,
      completedAt: action.completedAt ?? null,
      responseId: action.result?.responseId ?? null,
      model: action.result?.model ?? null,
      usage: action.result?.usage ?? null,
      functionName: action.result?.functionCall?.name ?? null,
      callIdHash: typeof action.result?.functionCall?.callId === "string" ? sha256(action.result.functionCall.callId) : null,
      argumentsSha256: typeof action.result?.functionCall?.arguments === "string" ? sha256(action.result.functionCall.arguments) : null,
      providerRequestId: action.result?.providerRequestId ?? null,
      clientRequestId: action.result?.clientRequestId ?? null,
      error: action.error ?? null,
    }])),
    transcripts: Object.fromEntries(Object.entries(store.state.transcripts).map(([id, transcript]) => [id, {
      loopIdHash: sha256(id),
      agentHash: sha256(transcript.agent),
      experimentId: transcript.experimentId,
      generation: transcript.generation,
      turns: transcript.turns.length,
      usage: transcript.usage,
      promptVersion: transcript.promptVersion,
      promptSha256: transcript.promptSha256,
      toolSchemaVersion: transcript.toolSchemaVersion,
      toolSchemaSha256: transcript.toolSchemaSha256,
      rawReplayStored: transcript.rawReplayStored,
    }])),
    metrics: store.state.metrics,
  };
}

function normalizeState(state) {
  state.actions ??= {};
  state.transcripts ??= {};
  state.metrics = { ...freshMetrics(), ...(state.metrics ?? {}) };
  state.metrics.routeMs ??= [];
  state.metrics.usage = { ...emptyUsage(), ...(state.metrics.usage ?? {}) };
  for (const transcript of Object.values(state.transcripts)) {
    transcript.input ??= [];
    transcript.turns ??= [];
    transcript.usage = { ...emptyUsage(), ...(transcript.usage ?? {}) };
  }
}

function freshMetrics() {
  return {
    requests: 0,
    serverErrors: 0,
    clientErrors: 0,
    completedActions: 0,
    duplicateActions: 0,
    conflicts: 0,
    providerRequests: 0,
    providerRetries: 0,
    providerFailures: 0,
    ambiguousProviderAttempts: 0,
    usage: emptyUsage(),
    routeMs: [],
  };
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

function addUsage(target, increment) {
  for (const key of Object.keys(emptyUsage())) target[key] = (target[key] ?? 0) + (increment[key] ?? 0);
}

function safeProviderFailure(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "provider_error",
    status: typeof error?.status === "number" ? error.status : null,
    type: typeof error?.type === "string" ? error.type : null,
    message: String(error?.message ?? error).slice(0, 500),
    attempts: Array.isArray(error?.attempts) ? error.attempts : [],
    usage: error?.usage !== undefined ? error.usage : null,
  };
}

function fixed(value) {
  return Number(Number(value ?? 0).toFixed(3));
}
