import { createServer } from "node:http";
import { join, resolve } from "node:path";
import {
  RequestError,
  bodyJson,
  boundedInteger,
  canonicalJson,
  createRecorder,
  createStateStore,
  integerValue,
  numberValue,
  objectValue,
  percentile,
  publicError,
  sendJson,
  sha256,
  stringValue,
  validateReceiverRequest,
} from "./service-utils.mjs";

const root = process.cwd();
const port = boundedInteger(process.env.SWARM_BOARD_PORT, 19124, 1_024, 65_535);
const statePath = resolve(
  process.env.SWARM_BOARD_STATE ??
    join(root, ".protein/cellular-agent-swarm/board-state.json"),
);
const logPath = resolve(
  process.env.SWARM_BOARD_LOG ??
    join(root, ".protein/cellular-agent-swarm/board.jsonl"),
);
const evaluatorUrl = normalizedBaseUrl(
  process.env.SWARM_EVALUATOR_URL ?? "http://127.0.0.1:19123",
);
const evaluatorTimeoutMs = boundedInteger(
  process.env.SWARM_BOARD_EVALUATOR_TIMEOUT_MS,
  20_000,
  1_000,
  120_000,
);
const evidenceLevel = "celld-experiment";
const service = "protein-swarm-board";
const protocol = "protein-swarm-board/v1";
const startedAt = new Date().toISOString();

const store = await createStateStore(statePath, {
  schemaVersion: 1,
  evidenceLevel,
  service,
  protocol,
  startedAt,
  seeds: {},
  submissions: {},
  submissionIndex: {},
  evaluations: {},
  snapshots: {},
  metrics: freshMetrics(),
});
normalizeState(store.state);
const recorder = createRecorder(logPath, { evidenceLevel, service, protocol });
const pendingSeeds = new Map();
const pendingSubmissions = new Map();
const pendingSubmissionSlots = new Map();
const pendingSnapshots = new Map();

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
        protocol,
        evaluatorUrl,
      });
    }
    if (method === "GET" && pathname === "/stats") {
      status = 200;
      return sendJson(response, status, stats());
    }
    if (method === "GET" && pathname === "/status") {
      status = 200;
      return sendJson(response, status, boardStatus(url.searchParams.get("experimentId")));
    }
    if (method === "GET" && pathname === "/snapshot") {
      const experimentId = url.searchParams.get("experimentId");
      const generationText = url.searchParams.get("generation");
      if (experimentId !== null || generationText !== null) {
        if (experimentId === null || generationText === null) {
          throw new RequestError(400, "invalid_request", "experimentId and generation must be supplied together");
        }
        const generation = integerValue(Number(generationText), "generation", 0, 10_000);
        const snapshot = snapshotRecord(experimentId, generation);
        if (snapshot === undefined) {
          status = 404;
          return sendJson(response, status, { error: "snapshot_not_found" });
        }
        status = 200;
        return sendJson(response, status, snapshot);
      }
      status = 200;
      return sendJson(response, status, redactedSnapshot());
    }
    if (method === "GET" && pathname.startsWith("/snapshots/")) {
      const match = /^\/snapshots\/([^/]+)\/(\d+)$/.exec(pathname);
      if (match === null) {
        status = 404;
        return sendJson(response, status, { error: "not_found" });
      }
      const experimentId = decodeURIComponent(match[1]);
      const generation = integerValue(Number(match[2]), "generation", 0, 10_000);
      const snapshot = snapshotRecord(experimentId, generation);
      status = snapshot === undefined ? 404 : 200;
      return sendJson(response, status, snapshot ?? { error: "snapshot_not_found" });
    }
    if (
      method === "POST" &&
      (pathname === "/snapshots/freeze" || pathname === "/snapshot/freeze")
    ) {
      const result = await receiveSnapshotFreeze(await bodyJson(request, 128_000));
      status = result.status;
      return sendJson(response, status, result.body);
    }
    if (method === "POST" && pathname === "/seed") {
      const result = await receiveSeed(await bodyJson(request));
      status = result.status;
      return sendJson(response, status, result.body);
    }
    if (method === "POST" && pathname === "/submissions") {
      const result = await receiveSubmission(request, await bodyJson(request));
      status = result.status;
      return sendJson(response, status, result.body);
    }
    if (method === "GET" && pathname.startsWith("/submissions/")) {
      const actionId = decodeURIComponent(pathname.slice("/submissions/".length));
      const submission = submissionRecord(actionId);
      if (submission?.status === "completed") {
        status = 200;
        return sendJson(response, status, submission.result);
      }
      status = 404;
      return sendJson(response, status, {
        error: submission === undefined ? "receipt_not_found" : "receipt_pending",
      });
    }
    status = 404;
    return sendJson(response, status, { error: "not_found" });
  } catch (error) {
    const visible = safePublicError(error);
    status = visible.status;
    await recorder.record("request.failed", {
      method,
      pathname,
      status,
      failure: safeFailure(error),
    });
    return sendJson(response, status, visible.body);
  } finally {
    store.state.metrics.requests += 1;
    if (status >= 500) store.state.metrics.serverErrors += 1;
    else if (status >= 400 && status !== 404) store.state.metrics.clientErrors += 1;
    if (status === 404 && pathname.startsWith("/submissions/")) {
      store.state.metrics.reconciliationMisses += 1;
    }
    const durationMs = fixed(performance.now() - started);
    store.state.metrics.routeMs.push(durationMs);
    if (store.state.metrics.routeMs.length > 500) store.state.metrics.routeMs.shift();
    void recorder.record("http.request", { method, pathname, status, durationMs });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Protein swarm board: http://127.0.0.1:${port}`);
  void recorder.record("service.started", { port, pid: process.pid, evaluatorUrl });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => {
      void Promise.all([store.persist(), recorder.record("service.stopped", { signal })])
        .finally(() => process.exit(0));
    });
  });
}

async function receiveSeed(body) {
  const value = objectValue(body, "seed request");
  const experimentId = stringValue(value.experimentId, "experimentId", 512);
  const candidate = candidateResultValue(value.candidate, "seed candidate");
  const requestHash = sha256(canonicalJson({ experimentId, candidate }));
  const key = experimentKey(experimentId);
  const existing = store.state.seeds[key];
  if (existing !== undefined && existing.requestHash !== requestHash) {
    store.state.metrics.conflicts += 1;
    return { status: 409, body: { error: "seed_conflict" } };
  }
  if (existing?.status === "completed") return { status: 200, body: existing.result };
  if (existing?.status === "rejected") return { status: existing.responseStatus, body: existing.error };
  const inflight = pendingSeeds.get(key);
  if (inflight !== undefined) {
    store.state.metrics.coalescedSeeds += 1;
    return inflight;
  }
  store.state.seeds[key] = {
    experimentId,
    requestHash,
    status: "in_progress",
    startedAt: Date.now(),
    attempts: (existing?.attempts ?? 0) + 1,
  };
  const operation = (async () => {
    await store.persist();
    return executeSeed(experimentId, candidate, key);
  })()
    .finally(() => pendingSeeds.delete(key));
  pendingSeeds.set(key, operation);
  return operation;
}

async function executeSeed(experimentId, candidate, key) {
  const seed = store.state.seeds[key];
  try {
    const evaluation = await verifiedEvaluation(candidate, {
      experimentId,
      generation: 0,
      requireExactGeneration: true,
    });
    if (evaluation.result.behavior !== "seed") {
      throw new RequestError(409, "invalid_seed_evaluation", "Seed evaluator receipt must have seed behavior");
    }
    const result = evaluation.result;
    Object.assign(seed, {
      status: "completed",
      completedAt: Date.now(),
      evaluationActionId: result.evaluationActionId,
      result,
    });
    store.state.metrics.completedSeeds += 1;
    await store.persist();
    await recorder.record("seed.completed", {
      experimentId,
      candidateId: result.candidateId,
      evidenceId: result.evidenceId,
      evaluationActionId: result.evaluationActionId,
    });
    return { status: 200, body: result };
  } catch (error) {
    const visible = safePublicError(error);
    Object.assign(seed, {
      status: visible.status >= 500 ? "retryable" : "rejected",
      responseStatus: visible.status,
      failedAt: Date.now(),
      error: visible.body,
    });
    await store.persist();
    await recorder.record("seed.failed", { experimentId, failure: safeFailure(error) });
    return visible;
  }
}

async function receiveSubmission(request, body) {
  const validated = validateReceiverRequest(request, body);
  if (validated.kind !== "swarm.submit") {
    return { status: 400, body: { error: "unsupported_action_kind" } };
  }
  const existing = submissionRecord(validated.actionId);
  if (existing !== undefined && existing.requestHash !== validated.requestHash) {
    store.state.metrics.conflicts += 1;
    await recorder.record("submission.conflict", {
      actionId: validated.actionId,
      requestHash: validated.requestHash,
    });
    return { status: 409, body: { error: "action_id_conflict" } };
  }
  if (existing?.status === "completed") {
    store.state.metrics.duplicateSubmissions += 1;
    return { status: 200, body: existing.result };
  }
  if (existing?.status === "rejected") {
    store.state.metrics.duplicateSubmissions += 1;
    return { status: existing.responseStatus, body: existing.error };
  }
  const inflight = pendingSubmissions.get(validated.actionId);
  if (inflight !== undefined) {
    store.state.metrics.coalescedSubmissions += 1;
    return inflight;
  }
  setSubmissionRecord(validated.actionId, {
    actionId: validated.actionId,
    requestHash: validated.requestHash,
    agent: validated.agent,
    kind: validated.kind,
    payload: validated.payload,
    status: "in_progress",
    startedAt: Date.now(),
    attempts: (existing?.attempts ?? 0) + 1,
  });
  const operation = (async () => {
    await store.persist();
    return executeSubmission(validated);
  })()
    .finally(() => pendingSubmissions.delete(validated.actionId));
  pendingSubmissions.set(validated.actionId, operation);
  return operation;
}

async function executeSubmission(validated) {
  const submission = submissionRecord(validated.actionId);
  let slot = null;
  try {
    const payload = normalizedSubmissionPayload(validated.payload, validated.agent);
    slot = submissionSlot(payload.experimentId, payload.generation, payload.agent);
    const pendingActionId = pendingSubmissionSlots.get(slot);
    if (pendingActionId !== undefined && pendingActionId !== validated.actionId) {
      throw new RequestError(409, "submission_slot_busy", "Another submission is active for this cell and generation");
    }
    pendingSubmissionSlots.set(slot, validated.actionId);
    const seed = store.state.seeds[experimentKey(payload.experimentId)];
    if (seed?.status !== "completed") {
      throw new RequestError(409, "experiment_not_seeded", "The board has no verified seed for this experiment");
    }
    if (snapshotRecord(payload.experimentId, payload.generation) !== undefined) {
      throw new RequestError(409, "generation_frozen", "The generation snapshot is already frozen");
    }
    const incumbentActionId = store.state.submissionIndex[slot];
    if (incumbentActionId !== undefined && incumbentActionId !== validated.actionId) {
      throw new RequestError(409, "submission_already_recorded", "The cell already submitted this generation");
    }

    let submittedEvaluation = null;
    if (payload.candidate !== null) {
      submittedEvaluation = await verifiedEvaluation(payload.candidate, {
        experimentId: payload.experimentId,
        generation: payload.generation,
        requireExactGeneration: ["explore", "improve", "challenge"].includes(payload.candidate.behavior),
      });
    }
    const cellCandidate = candidateFromCell(payload.cell);
    const cellEvaluation = await verifiedEvaluation(cellCandidate, {
      experimentId: payload.experimentId,
      generation: payload.generation,
      requireExactGeneration: false,
    });
    if (
      payload.candidate !== null &&
      payload.candidate.behavior !== "challenge" &&
      payload.candidate.candidateId !== payload.cell.candidateId
    ) {
      throw new RequestError(409, "cell_candidate_conflict", "Submitted candidate does not match the cell snapshot");
    }
    if (
      payload.candidate?.behavior === "challenge" &&
      submittedEvaluation?.result.behavior !== "challenge"
    ) {
      throw new RequestError(409, "challenge_evidence_conflict", "Challenge submission lacks challenge evaluation evidence");
    }

    const result = {
      accepted: true,
      submissionId: `submission:${sha256(validated.actionId).slice(0, 24)}`,
      experimentId: payload.experimentId,
      generation: payload.generation,
      agent: payload.agent,
      candidateId: payload.cell.candidateId,
      strategy: payload.cell.strategy,
      score: payload.cell.score,
      evidenceId: payload.cell.evidenceId,
      artifactRef: payload.cell.artifactRef,
      behavior: payload.cell.behavior,
      evaluationActionId: cellEvaluation.result.evaluationActionId,
      challengedEvaluationActionId: submittedEvaluation?.result.behavior === "challenge"
        ? submittedEvaluation.result.evaluationActionId
        : null,
      receivedAt: Date.now(),
    };
    Object.assign(submission, {
      status: "completed",
      completedAt: Date.now(),
      payload: validated.payload,
      result,
    });
    store.state.submissionIndex[slot] = validated.actionId;
    store.state.metrics.acceptedSubmissions += 1;
    await store.persist();
    await recorder.record("submission.accepted", {
      actionId: validated.actionId,
      experimentId: payload.experimentId,
      generation: payload.generation,
      agent: payload.agent,
      candidateId: result.candidateId,
      evidenceId: result.evidenceId,
      behavior: result.behavior,
      evaluationActionId: result.evaluationActionId,
      challengedEvaluationActionId: result.challengedEvaluationActionId,
    });
    return { status: 200, body: result };
  } catch (error) {
    const visible = safePublicError(error);
    Object.assign(submission, {
      status: visible.status >= 500 ? "retryable" : "rejected",
      responseStatus: visible.status,
      failedAt: Date.now(),
      error: visible.body,
    });
    store.state.metrics.rejectedSubmissions += 1;
    await store.persist();
    await recorder.record("submission.rejected", {
      actionId: validated.actionId,
      failure: safeFailure(error),
    });
    return visible;
  } finally {
    if (slot !== null && pendingSubmissionSlots.get(slot) === validated.actionId) {
      pendingSubmissionSlots.delete(slot);
    }
  }
}

async function verifiedEvaluation(candidate, scope) {
  let cached = evaluationRecord(candidate.evidenceId);
  let evidence = null;
  let actionId = candidate.evaluationActionId ?? cached?.result?.evaluationActionId ?? null;
  if (cached === undefined && actionId === null) {
    evidence = await evaluatorGet(`/evidence/${encodeURIComponent(candidate.evidenceId)}`, "evaluator evidence");
    actionId = stringValue(evidence.actionId, "evaluator evidence actionId", 512);
  }
  if (cached === undefined) {
    const resultValue = await evaluatorGet(`/actions/${encodeURIComponent(actionId)}`, "evaluator receipt");
    const result = evaluatorResultValue(resultValue);
    if (result.evaluationActionId !== actionId) {
      throw new RequestError(409, "evaluation_action_conflict", "Evaluator receipt action identity does not match");
    }
    cached = {
      evidenceId: result.evidenceId,
      actionId,
      experimentId: result.experimentId,
      generation: result.generation,
      candidateId: result.candidateId,
      result,
      verifiedAt: Date.now(),
    };
    if (evidence !== null) {
      if (
        evidence.evidenceId !== result.evidenceId ||
        evidence.candidateId !== result.candidateId ||
        evidence.experimentId !== result.experimentId ||
        evidence.generation !== result.generation
      ) {
        throw new RequestError(409, "evaluation_evidence_conflict", "Evaluator evidence mapping does not match its action receipt");
      }
    }
    setEvaluationRecord(result.evidenceId, cached);
    store.state.metrics.verifiedEvaluations += 1;
    await store.persist();
  }
  assertCandidateMatchesEvaluation(candidate, cached.result);
  if (cached.experimentId !== scope.experimentId) {
    throw new RequestError(409, "evaluation_experiment_conflict", "Evaluator receipt belongs to another experiment");
  }
  if (cached.generation > scope.generation) {
    throw new RequestError(409, "evaluation_generation_conflict", "Evaluator receipt is from a future generation");
  }
  if (scope.requireExactGeneration && cached.generation !== scope.generation) {
    throw new RequestError(409, "evaluation_generation_conflict", "Submission requires an evaluator receipt from this generation");
  }
  return cached;
}

async function evaluatorGet(pathname, label) {
  let response;
  try {
    response = await fetch(`${evaluatorUrl}${pathname}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(evaluatorTimeoutMs),
    });
  } catch {
    throw new RequestError(502, "evaluator_unavailable", "The board could not reach the hidden evaluator");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > 1_000_000) {
    throw new RequestError(502, "invalid_evaluator_response", "Evaluator response exceeded 1 MB");
  }
  let value;
  try {
    value = text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new RequestError(502, "invalid_evaluator_response", "Evaluator returned invalid JSON");
  }
  if (response.status === 404) {
    throw new RequestError(409, "evaluation_receipt_missing", `${label} was not found`);
  }
  if (!response.ok) {
    throw new RequestError(502, "evaluator_unavailable", `${label} lookup returned HTTP ${response.status}`);
  }
  return objectValue(value, label);
}

async function receiveSnapshotFreeze(body) {
  const value = objectValue(body, "snapshot freeze request");
  const experimentId = stringValue(value.experimentId, "experimentId", 512);
  const generation = integerValue(value.generation, "generation", 0, 10_000);
  const expectedAgents = optionalStringArray(value.expectedAgents, "expectedAgents", 144);
  const key = snapshotKey(experimentId, generation);
  const existing = store.state.snapshots[key];
  if (existing !== undefined) return { status: 200, body: existing };
  const inflight = pendingSnapshots.get(key);
  if (inflight !== undefined) return inflight;
  const operation = freezeSnapshot(experimentId, generation, expectedAgents, key)
    .finally(() => pendingSnapshots.delete(key));
  pendingSnapshots.set(key, operation);
  return operation;
}

async function freezeSnapshot(experimentId, generation, expectedAgents, key) {
  try {
    const submissions = completedSubmissions(experimentId, generation);
    const byAgent = new Map(submissions.map((submission) => [submission.result.agent, submission]));
    if (expectedAgents !== null) {
      const missing = expectedAgents.filter((agent) => !byAgent.has(agent));
      if (missing.length > 0) {
        throw new RequestError(409, "snapshot_incomplete", `Missing ${missing.length} expected submissions`);
      }
    }
    const cells = Object.fromEntries([...byAgent.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agent, submission]) => [agent, {
        candidateId: submission.result.candidateId,
        strategy: submission.result.strategy,
        score: submission.result.score,
        evidenceId: submission.result.evidenceId,
        artifactRef: submission.result.artifactRef,
        behavior: submission.result.behavior,
        credits: submission.payload.cell.credits,
        evaluationActionId: submission.result.evaluationActionId,
        submissionId: submission.result.submissionId,
      }]));
    const core = {
      schemaVersion: 1,
      protocol,
      experimentId,
      generation,
      expectedAgents,
      cells,
    };
    const snapshot = {
      ...core,
      snapshotId: `snapshot:${sha256(canonicalJson(core))}`,
      frozenAt: Date.now(),
    };
    store.state.snapshots[key] = snapshot;
    store.state.metrics.frozenSnapshots += 1;
    await store.persist();
    await recorder.record("snapshot.frozen", {
      experimentId,
      generation,
      snapshotId: snapshot.snapshotId,
      cells: Object.keys(cells).length,
    });
    return { status: 200, body: snapshot };
  } catch (error) {
    return safePublicError(error);
  }
}

function normalizedSubmissionPayload(value, receiverAgent) {
  const payload = objectValue(value, "submission payload");
  const experimentId = stringValue(payload.experimentId, "experimentId", 512);
  const generation = integerValue(payload.generation, "generation", 1, 10_000);
  const agent = stringValue(payload.agent, "agent", 512);
  if (agent !== receiverAgent) {
    throw new RequestError(409, "agent_identity_conflict", "Submission payload agent does not match receiver agent");
  }
  const cell = cellSnapshotValue(payload.cell);
  const candidate = payload.candidate === null || payload.candidate === undefined
    ? null
    : candidateResultValue(payload.candidate, "submission candidate");
  return {
    experimentId,
    generation,
    agent,
    decision: payload.decision ?? null,
    candidate,
    cell,
  };
}

function cellSnapshotValue(value) {
  const cell = objectValue(value, "submission cell snapshot");
  return {
    candidateId: candidateIdValue(cell.candidateId, "cell candidateId"),
    strategy: stringValue(cell.strategy, "cell strategy", 80),
    score: numberValue(cell.score, "cell score"),
    evidenceId: evidenceIdValue(cell.evidenceId, "cell evidenceId"),
    artifactRef: candidateRefValue(cell.artifactRef, "cell artifactRef"),
    credits: numberValue(cell.credits, "cell credits"),
    behavior: stringValue(cell.behavior, "cell behavior", 32),
  };
}

function candidateFromCell(cell) {
  return {
    candidateId: cell.candidateId,
    strategy: cell.strategy,
    score: cell.score,
    evidenceId: cell.evidenceId,
    artifactRef: cell.artifactRef,
    behavior: cell.behavior,
    evaluationActionId: null,
  };
}

function candidateResultValue(value, label) {
  const candidate = objectValue(value, label);
  return {
    candidateId: candidateIdValue(candidate.candidateId, `${label} candidateId`),
    strategy: stringValue(candidate.strategy, `${label} strategy`, 80),
    score: numberValue(candidate.score, `${label} score`),
    evidenceId: evidenceIdValue(candidate.evidenceId, `${label} evidenceId`),
    artifactRef: candidateRefValue(candidate.artifactRef, `${label} artifactRef`),
    behavior: stringValue(candidate.behavior, `${label} behavior`, 32),
    evaluationActionId: typeof candidate.evaluationActionId === "string"
      ? stringValue(candidate.evaluationActionId, `${label} evaluationActionId`, 512)
      : null,
    ...(typeof candidate.publicPass === "boolean" ? { publicPass: candidate.publicPass } : {}),
    ...(typeof candidate.hiddenPass === "boolean" ? { hiddenPass: candidate.hiddenPass } : {}),
    ...(candidate.benchmark === null || isObject(candidate.benchmark) ? { benchmark: candidate.benchmark ?? null } : {}),
    ...(typeof candidate.experimentId === "string" ? { experimentId: candidate.experimentId } : {}),
    ...(Number.isInteger(candidate.generation) ? { generation: candidate.generation } : {}),
  };
}

function evaluatorResultValue(value) {
  const result = candidateResultValue(value, "evaluator result");
  const object = objectValue(value, "evaluator result");
  const experimentId = stringValue(object.experimentId, "evaluator result experimentId", 512);
  const generation = integerValue(object.generation, "evaluator result generation", 0, 10_000);
  if (result.evaluationActionId === null) {
    throw new RequestError(502, "invalid_evaluator_response", "Evaluator result lacks evaluationActionId");
  }
  if (typeof object.publicPass !== "boolean" || typeof object.hiddenPass !== "boolean") {
    throw new RequestError(502, "invalid_evaluator_response", "Evaluator result lacks aggregate pass evidence");
  }
  return {
    ...result,
    experimentId,
    generation,
    publicPass: object.publicPass,
    hiddenPass: object.hiddenPass,
    benchmark: object.benchmark === null || isObject(object.benchmark) ? object.benchmark ?? null : null,
  };
}

function assertCandidateMatchesEvaluation(candidate, evaluation) {
  if (
    candidate.candidateId !== evaluation.candidateId ||
    candidate.strategy !== evaluation.strategy ||
    candidate.score !== evaluation.score ||
    candidate.evidenceId !== evaluation.evidenceId ||
    candidate.artifactRef !== evaluation.artifactRef
  ) {
    throw new RequestError(409, "candidate_evidence_conflict", "Candidate fields do not match the evaluator receipt");
  }
  if (candidate.publicPass !== undefined && candidate.publicPass !== evaluation.publicPass) {
    throw new RequestError(409, "candidate_evidence_conflict", "Candidate publicPass does not match evaluator evidence");
  }
  if (candidate.hiddenPass !== undefined && candidate.hiddenPass !== evaluation.hiddenPass) {
    throw new RequestError(409, "candidate_evidence_conflict", "Candidate hiddenPass does not match evaluator evidence");
  }
}

function boardStatus(experimentIdValue) {
  const experimentId = experimentIdValue === null
    ? null
    : stringValue(experimentIdValue, "experimentId", 512);
  const submissions = Object.values(store.state.submissions).filter((entry) =>
    entry.status === "completed" &&
    (experimentId === null || entry.result.experimentId === experimentId)
  );
  const snapshots = Object.values(store.state.snapshots).filter((entry) =>
    experimentId === null || entry.experimentId === experimentId
  );
  return {
    status: "ok",
    service,
    evidenceLevel,
    protocol,
    experimentId,
    seeded: experimentId === null
      ? Object.values(store.state.seeds).filter((seed) => seed.status === "completed").length
      : store.state.seeds[experimentKey(experimentId)]?.status === "completed",
    acceptedSubmissions: submissions.length,
    frozenSnapshots: snapshots.length,
    generations: [...new Set(submissions.map((entry) => entry.result.generation))].sort((left, right) => left - right),
  };
}

function stats() {
  return {
    schemaVersion: 1,
    evidenceLevel,
    service,
    protocol,
    startedAt: store.state.startedAt,
    seeds: Object.keys(store.state.seeds).length,
    submissions: Object.keys(store.state.submissions).length,
    evaluations: Object.keys(store.state.evaluations).length,
    snapshots: Object.keys(store.state.snapshots).length,
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
    protocol,
    startedAt: store.state.startedAt,
    seeds: Object.fromEntries(Object.values(store.state.seeds).map((seed) => [seed.experimentId, {
      experimentId: seed.experimentId,
      status: seed.status,
      result: seed.result ?? null,
      evaluationActionId: seed.evaluationActionId ?? null,
      error: seed.error ?? null,
    }])),
    submissions: Object.fromEntries(Object.values(store.state.submissions)
      .filter((submission) => submission.status === "completed")
      .map((submission) => [submission.actionId, redactedSubmissionRecord(submission)])),
    rejectedSubmissions: Object.fromEntries(Object.values(store.state.submissions)
      .filter((submission) => submission.status !== "completed")
      .map((submission) => [submission.actionId, redactedSubmissionRecord(submission)])),
    evaluations: Object.fromEntries(Object.values(store.state.evaluations).map((evaluation) => [evaluation.evidenceId, {
      evidenceId: evaluation.evidenceId,
      actionId: evaluation.actionId,
      experimentId: evaluation.experimentId,
      generation: evaluation.generation,
      candidateId: evaluation.candidateId,
      result: evaluation.result,
      verifiedAt: evaluation.verifiedAt,
    }])),
    snapshots: Object.fromEntries(Object.values(store.state.snapshots).map((snapshot) => [snapshot.snapshotId, snapshot])),
    metrics: store.state.metrics,
  };
}

function normalizeState(state) {
  state.seeds ??= {};
  state.submissions ??= {};
  state.submissionIndex ??= {};
  state.evaluations ??= {};
  state.snapshots ??= {};
  state.metrics = { ...freshMetrics(), ...(state.metrics ?? {}) };
  state.metrics.routeMs ??= [];
}

function freshMetrics() {
  return {
    requests: 0,
    serverErrors: 0,
    clientErrors: 0,
    reconciliationMisses: 0,
    completedSeeds: 0,
    duplicateSubmissions: 0,
    coalescedSeeds: 0,
    coalescedSubmissions: 0,
    conflicts: 0,
    verifiedEvaluations: 0,
    acceptedSubmissions: 0,
    rejectedSubmissions: 0,
    frozenSnapshots: 0,
    routeMs: [],
  };
}

function experimentKey(experimentId) {
  return sha256(experimentId);
}

function submissionRecord(actionId) {
  return store.state.submissions[sha256(actionId)];
}

function setSubmissionRecord(actionId, record) {
  store.state.submissions[sha256(actionId)] = record;
}

function submissionSlot(experimentId, generation, agent) {
  return sha256(canonicalJson({ experimentId, generation, agent }));
}

function evaluationRecord(evidenceId) {
  return store.state.evaluations[evidenceDigest(evidenceId)];
}

function setEvaluationRecord(evidenceId, record) {
  store.state.evaluations[evidenceDigest(evidenceId)] = record;
}

function evidenceDigest(evidenceId) {
  return evidenceId.slice("sha256:".length);
}

function snapshotKey(experimentId, generation) {
  return sha256(canonicalJson({ experimentId, generation }));
}

function snapshotRecord(experimentId, generation) {
  return store.state.snapshots[snapshotKey(experimentId, generation)];
}

function completedSubmissions(experimentId, generation) {
  return Object.values(store.state.submissions).filter((entry) =>
    entry.status === "completed" &&
    entry.result.experimentId === experimentId &&
    entry.result.generation === generation
  );
}

function candidateIdValue(value, label) {
  const id = stringValue(value, label, 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) {
    throw new RequestError(400, "invalid_candidate_id", `${label} must be a sha256 candidate ID`);
  }
  return id;
}

function redactedSubmissionPayload(value) {
  if (!isObject(value)) return null;
  const cell = isObject(value.cell) ? {
    candidateId: value.cell.candidateId ?? null,
    strategy: value.cell.strategy ?? null,
    score: value.cell.score ?? null,
    evidenceId: value.cell.evidenceId ?? null,
    artifactRef: value.cell.artifactRef ?? null,
    credits: value.cell.credits ?? null,
    behavior: value.cell.behavior ?? null,
  } : null;
  const candidate = isObject(value.candidate) ? {
    candidateId: value.candidate.candidateId ?? null,
    strategy: value.candidate.strategy ?? null,
    score: value.candidate.score ?? null,
    evidenceId: value.candidate.evidenceId ?? null,
    artifactRef: value.candidate.artifactRef ?? null,
    behavior: value.candidate.behavior ?? null,
    evaluationActionId: value.candidate.evaluationActionId ?? null,
  } : null;
  const decision = isObject(value.decision) ? {
    behavior: value.decision.behavior ?? null,
    targetCandidateId: value.decision.targetCandidateId ?? null,
    strategy: value.decision.strategy ?? null,
    rationaleSha256: typeof value.decision.rationale === "string"
      ? sha256(value.decision.rationale)
      : null,
  } : null;
  return {
    experimentId: value.experimentId ?? null,
    generation: value.generation ?? null,
    agent: value.agent ?? null,
    cell,
    candidate,
    decision,
  };
}

function redactedSubmissionRecord(submission) {
  return {
    actionId: submission.actionId,
    requestHash: submission.requestHash,
    agent: submission.agent,
    kind: submission.kind,
    status: submission.status,
    startedAt: submission.startedAt,
    completedAt: submission.completedAt ?? null,
    payload: redactedSubmissionPayload(submission.payload),
    result: submission.result ?? null,
    error: submission.error ?? null,
  };
}

function evidenceIdValue(value, label) {
  const id = stringValue(value, label, 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) {
    throw new RequestError(400, "invalid_evidence_id", `${label} must be a sha256 evidence ID`);
  }
  return id;
}

function candidateRefValue(value, label) {
  const ref = stringValue(value, label, 120);
  const match = /^artifact:\/\/sha256\/([a-f0-9]{64})$/.exec(ref);
  if (match === null) {
    throw new RequestError(400, "invalid_candidate_ref", `${label} must be a content-addressed artifact reference`);
  }
  return ref;
}

function optionalStringArray(value, label, maximum) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RequestError(400, "invalid_request", `${label} must be an array of at most ${maximum} strings`);
  }
  return [...new Set(value.map((item, index) => stringValue(item, `${label}[${index}]`, 512)))];
}

function normalizedBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SWARM_EVALUATOR_URL must be an absolute URL");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("SWARM_EVALUATOR_URL must use HTTP or HTTPS");
  return url.toString().replace(/\/$/, "");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safePublicError(error) {
  if (error instanceof RequestError) return publicError(error);
  return { status: 500, body: { error: "internal_error", message: "Board operation failed" } };
}

function safeFailure(error) {
  return {
    name: typeof error?.name === "string" ? error.name : "Error",
    code: typeof error?.code === "string" ? error.code : null,
    message: String(error?.message ?? error).slice(0, 500),
  };
}

function fixed(value) {
  return Number(Number(value ?? 0).toFixed(3));
}
