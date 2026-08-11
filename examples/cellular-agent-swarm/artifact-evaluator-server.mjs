import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HIDDEN_CASES } from "./artifact-hidden.mjs";
import { BENCHMARK, PUBLIC_CASES } from "./artifact-task.mjs";
import { inspectSandboxImage, runArtifactSandbox } from "./artifact-sandbox.mjs";
import { sanitizeBenchmarkResult } from "./artifact-workloads.mjs";
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
const port = boundedInteger(process.env.SWARM_EVALUATOR_PORT, 19123, 1_024, 65_535);
const statePath = resolve(
  process.env.SWARM_EVALUATOR_STATE ??
    join(root, ".protein/cellular-agent-swarm/evaluator-state.json"),
);
const logPath = resolve(
  process.env.SWARM_EVALUATOR_LOG ??
    join(root, ".protein/cellular-agent-swarm/evaluator.jsonl"),
);
const artifactDirectory = resolve(
  process.env.SWARM_ARTIFACT_DIR ??
    join(root, ".protein/cellular-agent-swarm/artifacts"),
);
const sandboxImage = process.env.SWARM_SANDBOX_IMAGE ?? "node:22-alpine";
const sandbox = inspectSandboxImage(sandboxImage);
const evidenceLevel = "celld-experiment";
const service = "protein-swarm-hidden-evaluator";
const protocol = "protein-swarm-hidden-evaluation/v1";
const startedAt = new Date().toISOString();

const store = await createStateStore(statePath, {
  schemaVersion: 1,
  evidenceLevel,
  service,
  protocol,
  startedAt,
  actions: {},
  evidence: {},
  metrics: freshMetrics(),
});
normalizeState(store.state);
const recorder = createRecorder(logPath, { evidenceLevel, service, protocol });
const pending = new Map();
let benchmarkQueue = Promise.resolve();

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
        benchmarkId: BENCHMARK.id,
        evaluatorVersion: BENCHMARK.evaluatorVersion,
        hiddenCaseCount: HIDDEN_CASES.length,
        sandbox,
      });
    }
    if (method === "GET" && pathname === "/stats") {
      status = 200;
      return sendJson(response, status, stats());
    }
    if (method === "GET" && pathname === "/snapshot") {
      status = 200;
      return sendJson(response, status, aggregateSnapshot());
    }
    if (method === "POST" && pathname === "/actions") {
      const result = await receiveAction(request, await bodyJson(request));
      status = result.status;
      return sendJson(response, status, result.body);
    }
    if (method === "GET" && pathname.startsWith("/actions/")) {
      const actionId = decodeURIComponent(pathname.slice("/actions/".length));
      const action = actionRecord(actionId);
      if (action?.status === "completed") {
        status = 200;
        return sendJson(response, status, action.result);
      }
      status = 404;
      return sendJson(response, status, {
        error: action === undefined ? "receipt_not_found" : "receipt_pending",
      });
    }
    if (method === "GET" && pathname.startsWith("/evidence/")) {
      const evidenceId = decodeURIComponent(pathname.slice("/evidence/".length));
      const record = evidenceRecord(evidenceId);
      if (record !== undefined) {
        status = 200;
        return sendJson(response, status, record);
      }
      status = 404;
      return sendJson(response, status, { error: "evidence_not_found" });
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
    if (status === 404 && pathname.startsWith("/actions/")) {
      store.state.metrics.reconciliationMisses += 1;
    }
    const durationMs = fixed(performance.now() - started);
    store.state.metrics.routeMs.push(durationMs);
    if (store.state.metrics.routeMs.length > 500) store.state.metrics.routeMs.shift();
    void recorder.record("http.request", { method, pathname, status, durationMs });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Protein hidden evaluator: http://127.0.0.1:${port}`);
  void recorder.record("service.started", { port, pid: process.pid, sandbox });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => {
      void Promise.all([store.persist(), recorder.record("service.stopped", { signal })])
        .finally(() => process.exit(0));
    });
  });
}

async function receiveAction(request, body) {
  const validated = validateReceiverRequest(request, body);
  if (validated.kind !== "swarm.evaluate" && validated.kind !== "swarm.reevaluate") {
    return { status: 400, body: { error: "unsupported_action_kind" } };
  }
  const existing = actionRecord(validated.actionId);
  if (existing !== undefined && existing.requestHash !== validated.requestHash) {
    store.state.metrics.conflicts += 1;
    await recorder.record("action.conflict", {
      actionId: validated.actionId,
      requestHash: validated.requestHash,
    });
    return { status: 409, body: { error: "action_id_conflict" } };
  }
  if (existing?.status === "completed") {
    store.state.metrics.duplicateActions += 1;
    return { status: 200, body: existing.result };
  }
  if (existing?.status === "rejected") {
    store.state.metrics.duplicateActions += 1;
    return { status: existing.responseStatus, body: existing.error };
  }
  const inflight = pending.get(validated.actionId);
  if (inflight !== undefined) {
    store.state.metrics.coalescedActions += 1;
    return inflight;
  }
  setActionRecord(validated.actionId, {
    actionId: validated.actionId,
    requestHash: validated.requestHash,
    agent: validated.agent,
    kind: validated.kind,
    status: "in_progress",
    startedAt: Date.now(),
    attempts: (existing?.attempts ?? 0) + 1,
  });
  const operation = (async () => {
    await store.persist();
    return executeAction(validated);
  })().finally(() => pending.delete(validated.actionId));
  pending.set(validated.actionId, operation);
  return operation;
}

async function executeAction(validated) {
  const action = actionRecord(validated.actionId);
  try {
    const payload = normalizedEvaluationPayload(validated.payload);
    const digest = candidateDigest(payload.candidateId);
    if (payload.candidateRef !== candidateRef(digest)) {
      throw new RequestError(
        409,
        "candidate_reference_conflict",
        "candidateRef does not match the content-addressed candidateId",
      );
    }
    const source = await boundedCandidateSource(digest);
    const evidenceId = evaluationEvidenceId(validated);
    let document = await readJsonIfPresent(evidencePath(evidenceId));
    if (document === null) {
      const sandboxResult = await serializeBenchmark(() => hiddenSandboxResult(source));
      const aggregates = aggregateChecks(sandboxResult);
      const benchmark = sanitizeBenchmark(sandboxResult.benchmark);
      const benchmarkGate = sanitizeBenchmarkGate(sandboxResult.benchmarkGate);
      const benchmarkPass = sandboxResult.pass === true &&
        benchmark !== null &&
        benchmarkGate?.failed === 0;
      const publicPass = aggregates.public.passed === aggregates.public.total && benchmarkPass;
      const hiddenPass = aggregates.hidden.passed === aggregates.hidden.total && publicPass;
      const score = hiddenPass ? benchmark.aggregate.score : 0;
      const result = {
        experimentId: payload.experimentId,
        generation: payload.generation,
        candidateId: payload.candidateId,
        strategy: payload.strategy,
        score,
        evidenceId,
        artifactRef: payload.candidateRef,
        behavior: payload.behavior,
        publicPass,
        hiddenPass,
        benchmarkGate,
        benchmark,
        evaluationActionId: validated.actionId,
        purpose: payload.purpose,
      };
      document = {
        schemaVersion: 1,
        evidenceLevel,
        kind: "hidden-evaluation",
        protocol,
        benchmarkId: BENCHMARK.id,
        evaluatorVersion: BENCHMARK.evaluatorVersion,
        actionId: validated.actionId,
        requestHash: validated.requestHash,
        agent: validated.agent,
        experimentId: payload.experimentId,
        generation: payload.generation,
        candidateId: payload.candidateId,
        candidateRef: payload.candidateRef,
        sourceSha256: digest,
        behavior: payload.behavior,
        strategy: payload.strategy,
        rationaleSha256: sha256(payload.rationale),
        parentCandidateIds: payload.parentCandidateIds,
        purpose: payload.purpose,
        publicEvidence: aggregates.public,
        hiddenEvidence: aggregates.hidden,
        benchmarkGate,
        benchmark,
        score,
        sandbox: { image: sandbox.image, imageId: sandbox.imageId },
        result,
        evaluatedAt: new Date().toISOString(),
      };
      await writeImmutable(evidencePath(evidenceId), `${JSON.stringify(document, null, 2)}\n`);
    } else {
      validateRecoveredEvidence(document, validated, payload, digest, evidenceId);
    }
    setEvidenceRecord(evidenceId, aggregateEvidenceRecord(document));
    Object.assign(action, {
      status: "completed",
      completedAt: Date.now(),
      result: document.result,
    });
    store.state.metrics.completedActions += 1;
    store.state.metrics.evaluationsByPurpose[payload.purpose] =
      (store.state.metrics.evaluationsByPurpose[payload.purpose] ?? 0) + 1;
    if (document.result.hiddenPass) store.state.metrics.hiddenPasses += 1;
    else store.state.metrics.hiddenFailures += 1;
    await store.persist();
    await recorder.record("evaluation.completed", {
      actionId: validated.actionId,
      agent: validated.agent,
      experimentId: payload.experimentId,
      generation: payload.generation,
      candidateId: payload.candidateId,
      evidenceId,
      behavior: payload.behavior,
      publicPass: document.result.publicPass,
      hiddenPass: document.result.hiddenPass,
      hiddenCaseCount: document.hiddenEvidence.total,
      hiddenPassedCount: document.hiddenEvidence.passed,
      score: document.result.score,
      purpose: document.purpose,
    });
    return { status: 200, body: document.result };
  } catch (error) {
    const visible = safePublicError(error);
    Object.assign(action, {
      status: visible.status >= 500 ? "retryable" : "rejected",
      responseStatus: visible.status,
      failedAt: Date.now(),
      error: visible.body,
    });
    store.state.metrics.failedActions += 1;
    await store.persist();
    await recorder.record("evaluation.failed", {
      actionId: validated.actionId,
      failure: safeFailure(error),
    });
    return visible;
  }
}

function normalizedEvaluationPayload(value) {
  const payload = objectValue(value, "evaluation payload");
  const experimentId = stringValue(payload.experimentId, "experimentId", 512);
  const generation = integerValue(payload.generation, "generation", 0, 10_000);
  const candidateId = candidateIdValue(payload.candidateId, "candidateId");
  const candidateRefValue = stringValue(payload.candidateRef, "candidateRef", 120);
  const behavior = stringValue(payload.behavior, "behavior", 32);
  if (!["seed", "explore", "improve", "challenge", "recheck"].includes(behavior)) {
    throw new RequestError(400, "invalid_behavior", "behavior must be seed, explore, improve, challenge, or recheck");
  }
  const strategy = stringValue(payload.strategy, "strategy", 80);
  const rationale = stringValue(payload.rationale, "rationale", 500);
  const parentCandidateIds = candidateIdArray(payload.parentCandidateIds ?? [], "parentCandidateIds", 2);
  const purpose = payload.purpose === undefined
    ? behavior === "seed" ? "seed" : "agent_discovery"
    : stringValue(payload.purpose, "purpose", 80);
  if (!["seed", "agent_discovery", "quality_target_candidate_recheck", "quality_target_baseline_recheck"].includes(purpose)) {
    throw new RequestError(400, "invalid_purpose", "Unsupported evaluation purpose");
  }
  return {
    experimentId,
    generation,
    candidateId,
    candidateRef: candidateRefValue,
    behavior,
    strategy,
    rationale,
    parentCandidateIds,
    purpose,
  };
}

async function hiddenSandboxResult(source) {
  try {
    return await runArtifactSandbox({
      source,
      cases: [...PUBLIC_CASES, ...HIDDEN_CASES],
      benchmark: BENCHMARK.measurement,
      image: sandboxImage,
    });
  } catch (error) {
    if (!isCandidateSandboxFailure(error)) throw error;
    return {
      pass: false,
      checks: [...PUBLIC_CASES, ...HIDDEN_CASES].map(() => ({ passed: false })),
      benchmarkGate: null,
      benchmark: null,
    };
  }
}

function aggregateChecks(sandboxResult) {
  const expected = PUBLIC_CASES.length + HIDDEN_CASES.length;
  if (!Array.isArray(sandboxResult.checks) || sandboxResult.checks.length !== expected) {
    throw new Error("Artifact sandbox returned the wrong number of evaluator checks");
  }
  const publicChecks = sandboxResult.checks.slice(0, PUBLIC_CASES.length);
  const hiddenChecks = sandboxResult.checks.slice(PUBLIC_CASES.length);
  return {
    public: aggregate(publicChecks),
    hidden: aggregate(hiddenChecks),
  };
}

function aggregate(checks) {
  const passed = checks.filter((check) => check?.passed === true).length;
  return { total: checks.length, passed, failed: checks.length - passed };
}

function evaluationEvidenceId(validated) {
  return `sha256:${sha256(canonicalJson({
    protocol,
    evaluatorVersion: BENCHMARK.evaluatorVersion,
    actionId: validated.actionId,
    requestHash: validated.requestHash,
  }))}`;
}

function aggregateEvidenceRecord(document) {
  return {
    evidenceId: document.result.evidenceId,
    actionId: document.actionId,
    agent: document.agent,
    experimentId: document.experimentId,
    generation: document.generation,
    candidateId: document.candidateId,
    candidateRef: document.candidateRef,
    evaluatorVersion: document.evaluatorVersion,
    publicEvidence: document.publicEvidence,
    hiddenEvidence: document.hiddenEvidence,
    benchmarkGate: document.benchmarkGate,
    score: document.score,
    benchmark: document.benchmark,
    behavior: document.behavior,
    strategy: document.strategy,
    purpose: document.purpose ?? (document.behavior === "seed" ? "seed" : "agent_discovery"),
    parentCandidateIds: document.parentCandidateIds,
    evaluatedAt: document.evaluatedAt,
  };
}

function validateRecoveredEvidence(document, validated, payload, digest, evidenceId) {
  if (
    document.kind !== "hidden-evaluation" ||
    document.actionId !== validated.actionId ||
    document.requestHash !== validated.requestHash ||
    document.candidateId !== payload.candidateId ||
    document.candidateRef !== payload.candidateRef ||
    document.sourceSha256 !== digest ||
    document.result?.evidenceId !== evidenceId
  ) {
    throw new Error("Recovered evaluator evidence failed its immutable identity check");
  }
}

function stats() {
  return {
    schemaVersion: 1,
    evidenceLevel,
    service,
    protocol,
    startedAt: store.state.startedAt,
    benchmarkId: BENCHMARK.id,
    evaluatorVersion: BENCHMARK.evaluatorVersion,
    hiddenCaseCount: HIDDEN_CASES.length,
    benchmarkConcurrency: 1,
    sandbox,
    actions: Object.keys(store.state.actions).length,
    evidence: Object.keys(store.state.evidence).length,
    passedEvaluations: store.state.metrics.hiddenPasses,
    failedEvaluations: store.state.metrics.hiddenFailures,
    ...store.state.metrics,
    routeMs: undefined,
    p50RouteMs: fixed(percentile(store.state.metrics.routeMs, 0.5)),
    p95RouteMs: fixed(percentile(store.state.metrics.routeMs, 0.95)),
  };
}

function serializeBenchmark(operation) {
  const result = benchmarkQueue.then(operation, operation);
  benchmarkQueue = result.then(() => undefined, () => undefined);
  return result;
}

function aggregateSnapshot() {
  return {
    schemaVersion: 1,
    evidenceLevel,
    service,
    protocol,
    startedAt: store.state.startedAt,
    evaluatorVersion: BENCHMARK.evaluatorVersion,
    actions: Object.fromEntries(Object.values(store.state.actions).map((action) => [action.actionId, {
      actionId: action.actionId,
      requestHash: action.requestHash,
      agent: action.agent,
      status: action.status,
      startedAt: action.startedAt,
      completedAt: action.completedAt ?? null,
      candidateId: action.result?.candidateId ?? null,
      evidenceId: action.result?.evidenceId ?? null,
      publicPass: action.result?.publicPass ?? null,
      hiddenPass: action.result?.hiddenPass ?? null,
      score: action.result?.score ?? null,
      purpose: action.result?.purpose ?? null,
      error: action.error ?? null,
    }])),
    evidence: store.state.evidence,
    metrics: store.state.metrics,
  };
}

function normalizeState(state) {
  state.actions ??= {};
  state.evidence ??= {};
  state.metrics = { ...freshMetrics(), ...(state.metrics ?? {}) };
  state.metrics.routeMs ??= [];
  state.metrics.evaluationsByPurpose ??= {};
}

function freshMetrics() {
  return {
    requests: 0,
    serverErrors: 0,
    clientErrors: 0,
    reconciliationMisses: 0,
    completedActions: 0,
    duplicateActions: 0,
    coalescedActions: 0,
    conflicts: 0,
    failedActions: 0,
    hiddenPasses: 0,
    hiddenFailures: 0,
    evaluationsByPurpose: {},
    routeMs: [],
  };
}

function actionRecord(actionId) {
  return store.state.actions[sha256(actionId)];
}

function setActionRecord(actionId, record) {
  store.state.actions[sha256(actionId)] = record;
}

function evidenceRecord(evidenceId) {
  if (!/^sha256:[a-f0-9]{64}$/.test(evidenceId)) return undefined;
  return store.state.evidence[evidenceId.slice("sha256:".length)];
}

function setEvidenceRecord(evidenceId, record) {
  store.state.evidence[evidenceId.slice("sha256:".length)] = record;
}

function candidateIdArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RequestError(400, "invalid_request", `${label} must be an array of at most ${maximum} candidate IDs`);
  }
  return [...new Set(value.map((item, index) => candidateIdValue(item, `${label}[${index}]`)))];
}

function candidateIdValue(value, label) {
  const id = stringValue(value, label, 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) {
    throw new RequestError(400, "invalid_candidate_id", `${label} must be a sha256 candidate ID`);
  }
  return id;
}

function candidateDigest(candidateId) {
  return candidateId.slice("sha256:".length);
}

function candidateRef(digest) {
  return `artifact://sha256/${digest}`;
}

function candidatePath(digest) {
  return join(artifactDirectory, "candidates", `${digest}.mjs`);
}

function evidencePath(evidenceId) {
  return join(artifactDirectory, "evidence", "hidden", `${evidenceId.slice("sha256:".length)}.json`);
}

async function boundedCandidateSource(digest) {
  let source;
  try {
    source = await readFile(candidatePath(digest), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new RequestError(404, "candidate_not_found", "Candidate artifact is not present in the evaluator store");
    }
    throw error;
  }
  if (Buffer.byteLength(source) > 16_384 || sha256(source) !== digest) {
    throw new Error("Candidate artifact failed its content-addressed integrity check");
  }
  return source;
}

async function writeImmutable(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  try {
    await writeFile(path, value, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(path);
    const expected = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!existing.equals(expected)) throw new Error("Immutable evaluator evidence conflict");
  }
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sanitizeBenchmark(value) {
  return sanitizeBenchmarkResult(value, BENCHMARK.measurement);
}

function sanitizeBenchmarkGate(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const expected = BENCHMARK.measurement.regimes.length;
  if (
    value.total !== expected ||
    !Number.isInteger(value.passed) ||
    !Number.isInteger(value.failed) ||
    value.passed < 0 ||
    value.failed < 0 ||
    value.passed + value.failed !== expected
  ) return null;
  return { total: expected, passed: value.passed, failed: value.failed };
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isCandidateSandboxFailure(error) {
  const message = String(error?.message ?? error);
  return message.startsWith("Artifact sandbox exited 1:") ||
    message.startsWith("Artifact sandbox exceeded") ||
    message.startsWith("Artifact sandbox output exceeded");
}

function safePublicError(error) {
  if (error instanceof RequestError) return publicError(error);
  return { status: 500, body: { error: "internal_error", message: "Hidden evaluator operation failed" } };
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
