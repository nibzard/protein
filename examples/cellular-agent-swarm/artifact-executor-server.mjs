import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BASELINE_SOURCE, BENCHMARK, PUBLIC_CASES } from "./artifact-task.mjs";
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
const port = boundedInteger(process.env.SWARM_TOOL_EXECUTOR_PORT, 19122, 1_024, 65_535);
const statePath = resolve(
  process.env.SWARM_TOOL_EXECUTOR_STATE ??
    join(root, ".protein/cellular-agent-swarm/tool-executor-state.json"),
);
const logPath = resolve(
  process.env.SWARM_TOOL_EXECUTOR_LOG ??
    join(root, ".protein/cellular-agent-swarm/tool-executor.jsonl"),
);
const artifactDirectory = resolve(
  process.env.SWARM_ARTIFACT_DIR ??
    join(root, ".protein/cellular-agent-swarm/artifacts"),
);
const sandboxImage = process.env.SWARM_SANDBOX_IMAGE ?? "node:22-alpine";
const sandbox = inspectSandboxImage(sandboxImage);
const evidenceLevel = "celld-experiment";
const service = "protein-swarm-artifact-executor";
const protocol = "protein-swarm-artifact-tools/v1";
const startedAt = new Date().toISOString();

const store = await createStateStore(statePath, {
  schemaVersion: 1,
  evidenceLevel,
  service,
  protocol,
  startedAt,
  actions: {},
  artifacts: {},
  seeds: {},
  metrics: freshMetrics(),
});
normalizeState(store.state);
const recorder = createRecorder(logPath, { evidenceLevel, service, protocol });
const pendingActions = new Map();
const pendingSeeds = new Map();
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
        benchmark: BENCHMARK,
        sandbox,
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
    if (method === "POST" && pathname === "/seed") {
      const result = await receiveSeed(await bodyJson(request, 32_000));
      status = result.status;
      return sendJson(response, status, result.body);
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
  console.log(`Protein artifact executor: http://127.0.0.1:${port}`);
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
  if (validated.kind !== "swarm.tool.execute") {
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
  const inflight = pendingActions.get(validated.actionId);
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
  })().finally(() => pendingActions.delete(validated.actionId));
  pendingActions.set(validated.actionId, operation);
  return operation;
}

async function executeAction(validated) {
  const action = actionRecord(validated.actionId);
  try {
    const payload = objectValue(validated.payload, "tool action payload");
    const experimentId = stringValue(payload.experimentId, "experimentId", 512);
    const generation = integerValue(payload.generation, "generation", 1, 10_000);
    const loopId = stringValue(payload.loopId, "loopId", 512);
    const callId = stringValue(payload.callId, "callId", 512);
    const tool = objectValue(payload.tool, "tool");
    const toolName = stringValue(tool.name, "tool name", 80);
    const argumentsValue = objectValue(tool.arguments, "tool arguments");
    const visibleCandidateIds = candidateIdArray(payload.visibleCandidateIds ?? [], "visibleCandidateIds", 64);
    const scope = {
      actionId: validated.actionId,
      requestHash: validated.requestHash,
      agent: validated.agent,
      experimentId,
      generation,
      loopId,
      callId,
    };
    let result;
    if (toolName === "read_candidate") {
      result = await readCandidate(argumentsValue, visibleCandidateIds);
    } else if (toolName === "run_public_checks") {
      result = await serializeBenchmark(() => runPublicChecks(argumentsValue, scope));
    } else {
      throw new RequestError(400, "unsupported_tool", `Unsupported artifact tool ${toolName}`);
    }
    const normalized = {
      protocol,
      callId,
      toolName,
      ...result,
      executorActionId: validated.actionId,
    };
    Object.assign(action, {
      status: "completed",
      completedAt: Date.now(),
      result: normalized,
    });
    store.state.metrics.completedActions += 1;
    if (toolName === "read_candidate") store.state.metrics.candidateReads += 1;
    else store.state.metrics.publicChecks += 1;
    await store.persist();
    await recorder.record("tool.completed", {
      actionId: validated.actionId,
      agent: validated.agent,
      experimentId,
      generation,
      loopIdHash: sha256(loopId),
      callIdHash: sha256(callId),
      toolName,
      candidateId: normalized.candidateId ?? null,
      publicPass: normalized.publicPass ?? null,
      publicEvidenceId: normalized.publicEvidence?.evidenceId ?? null,
    });
    return { status: 200, body: normalized };
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
    await recorder.record("tool.failed", {
      actionId: validated.actionId,
      failure: safeFailure(error),
    });
    return visible;
  }
}

async function readCandidate(argumentsValue, visibleCandidateIds) {
  const candidateId = candidateIdValue(argumentsValue.candidate_id, "candidate_id");
  if (!visibleCandidateIds.includes(candidateId)) {
    throw new RequestError(
      403,
      "candidate_not_visible",
      "read_candidate may only inspect a candidate in the frozen visibleCandidateIds allowlist",
    );
  }
  const digest = candidateDigest(candidateId);
  const artifact = store.state.artifacts[digest];
  if (artifact === undefined) {
    throw new RequestError(404, "candidate_not_found", "The visible candidate is not present in the executor registry");
  }
  const source = await boundedCandidateSource(digest);
  const evidence = await publicEvidenceById(artifact.publicEvidenceId);
  return {
    candidateId,
    candidateRef: candidateRef(digest),
    draftRef: draftRef(digest),
    source,
    strategy: artifact.strategy,
    summary: artifact.summary,
    publicPass: evidence.publicPass,
    publicEvidence: evidence.publicEvidence,
  };
}

async function runPublicChecks(argumentsValue, scope) {
  const source = stringValue(argumentsValue.source, "source", 16_384);
  const strategy = stringValue(argumentsValue.strategy, "strategy", 80);
  const summary = stringValue(argumentsValue.summary, "summary", 320);
  const digest = sha256(source);
  const id = `sha256:${digest}`;
  const ref = candidateRef(digest);
  const publicEvidenceId = `sha256:${sha256(canonicalJson({
    protocol,
    kind: "public-checks",
    actionId: scope.actionId,
    requestHash: scope.requestHash,
    evaluatorVersion: BENCHMARK.evaluatorVersion,
    candidateId: id,
  }))}`;
  await writeImmutable(candidatePath(digest), source);
  let evidenceDocument = await readJsonIfPresent(publicEvidencePath(publicEvidenceId));
  if (evidenceDocument === null) {
    const sandboxResult = await publicSandboxResult(source);
    const checks = sanitizePublicChecks(sandboxResult.checks);
    const benchmark = sanitizeBenchmark(sandboxResult.benchmark);
    const benchmarkGate = sanitizeBenchmarkGate(sandboxResult.benchmarkGate);
    const publicPass = sandboxResult.pass === true &&
      checks.every((check) => check.passed) &&
      benchmark !== null &&
      benchmarkGate?.failed === 0;
    const publicEvidence = {
      schemaVersion: 1,
      evidenceId: publicEvidenceId,
      evidenceRef: publicEvidenceRef(publicEvidenceId),
      evaluatorVersion: BENCHMARK.evaluatorVersion,
      publicPass,
      checks,
      benchmarkGate,
      benchmark: publicPass ? benchmark : null,
      compileMs: finiteOrNull(sandboxResult.compileMs),
      sandbox: { image: sandbox.image, imageId: sandbox.imageId },
    };
    evidenceDocument = {
      schemaVersion: 1,
      evidenceLevel,
      kind: "public-checks",
      protocol,
      actionId: scope.actionId,
      requestHash: scope.requestHash,
      agent: scope.agent,
      experimentId: scope.experimentId,
      generation: scope.generation,
      candidateId: id,
      candidateRef: ref,
      sourceSha256: digest,
      strategy,
      summary,
      publicPass,
      publicEvidence,
      createdAt: new Date().toISOString(),
    };
    await writeImmutable(publicEvidencePath(publicEvidenceId), `${JSON.stringify(evidenceDocument, null, 2)}\n`);
  } else {
    validateRecoveredPublicEvidence(evidenceDocument, scope, id, digest);
  }
  store.state.artifacts[digest] ??= {
    candidateId: id,
    candidateRef: ref,
    draftRef: draftRef(digest),
    sourceSha256: digest,
    sourceBytes: Buffer.byteLength(source),
    strategy,
    summary,
    publicEvidenceId,
    createdAt: Date.now(),
  };
  const artifact = store.state.artifacts[digest];
  if (artifact.publicEvidenceId === undefined || evidenceDocument.publicPass) {
    artifact.publicEvidenceId = publicEvidenceId;
  }
  return {
    candidateId: id,
    candidateRef: ref,
    draftRef: draftRef(digest),
    artifactRef: ref,
    sourceSha256: digest,
    strategy,
    summary,
    publicPass: evidenceDocument.publicPass,
    publicEvidence: evidenceDocument.publicEvidence,
  };
}

async function receiveSeed(body) {
  const value = objectValue(body, "seed request");
  const experimentId = stringValue(value.experimentId, "experimentId", 512);
  const key = sha256(experimentId);
  const existing = store.state.seeds[key];
  if (existing?.status === "completed") return { status: 200, body: existing.result };
  const inflight = pendingSeeds.get(key);
  if (inflight !== undefined) return inflight;
  store.state.seeds[key] = {
    experimentId,
    status: "in_progress",
    startedAt: Date.now(),
    attempts: (existing?.attempts ?? 0) + 1,
  };
  const operation = (async () => {
    await store.persist();
    return executeSeed(experimentId, key);
  })().finally(() => pendingSeeds.delete(key));
  pendingSeeds.set(key, operation);
  return operation;
}

async function executeSeed(experimentId, key) {
  const seed = store.state.seeds[key];
  try {
    const actionId = `executor:seed:${key}`;
    const result = await serializeBenchmark(() => runPublicChecks({
      source: BASELINE_SOURCE,
      strategy: "baseline",
      summary: "Trusted baseline supplied by the versioned artifact task.",
    }, {
      actionId,
      requestHash: sha256(canonicalJson({ experimentId, source: BASELINE_SOURCE })),
      agent: "board",
      experimentId,
      generation: 0,
      loopId: `seed:${experimentId}`,
      callId: actionId,
    }));
    if (!result.publicPass) {
      throw new Error("The trusted baseline failed its public checks");
    }
    const normalized = { protocol, experimentId, ...result };
    Object.assign(seed, { status: "completed", completedAt: Date.now(), result: normalized });
    store.state.metrics.completedSeeds += 1;
    await store.persist();
    await recorder.record("seed.completed", {
      experimentId,
      candidateId: normalized.candidateId,
      publicEvidenceId: normalized.publicEvidence.evidenceId,
    });
    return { status: 200, body: normalized };
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

async function publicSandboxResult(source) {
  try {
    return await runArtifactSandbox({
      source,
      cases: PUBLIC_CASES,
      benchmark: BENCHMARK.measurement,
      image: sandboxImage,
    });
  } catch (error) {
    if (!isCandidateSandboxFailure(error)) throw error;
    return {
      pass: false,
      checks: PUBLIC_CASES.map((testCase) => ({
        name: testCase.name,
        passed: false,
        error: "candidate execution failed within the sandbox limits",
      })),
      benchmark: null,
      benchmarkGate: null,
      compileMs: null,
    };
  }
}

function stats() {
  return {
    schemaVersion: 1,
    evidenceLevel,
    service,
    protocol,
    startedAt: store.state.startedAt,
    benchmark: BENCHMARK,
    benchmarkConcurrency: 1,
    sandbox,
    actions: Object.keys(store.state.actions).length,
    artifacts: Object.keys(store.state.artifacts).length,
    seeds: Object.keys(store.state.seeds).length,
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

function redactedSnapshot() {
  return {
    schemaVersion: 1,
    evidenceLevel,
    service,
    protocol,
    startedAt: store.state.startedAt,
    actions: Object.fromEntries(Object.values(store.state.actions).map((action) => [action.actionId, {
      actionId: action.actionId,
      requestHash: action.requestHash,
      agent: action.agent,
      kind: action.kind,
      status: action.status,
      startedAt: action.startedAt,
      completedAt: action.completedAt ?? null,
      toolName: action.result?.toolName ?? null,
      candidateId: action.result?.candidateId ?? null,
      publicPass: action.result?.publicPass ?? null,
      publicEvidenceId: action.result?.publicEvidence?.evidenceId ?? null,
      error: action.error ?? null,
    }])) ,
    artifacts: store.state.artifacts,
    seeds: Object.fromEntries(Object.values(store.state.seeds).map((seed) => [seed.experimentId, {
      experimentId: seed.experimentId,
      status: seed.status,
      candidateId: seed.result?.candidateId ?? null,
      publicEvidenceId: seed.result?.publicEvidence?.evidenceId ?? null,
    }])),
    metrics: store.state.metrics,
  };
}

function normalizeState(state) {
  state.actions ??= {};
  state.artifacts ??= {};
  state.seeds ??= {};
  state.metrics = { ...freshMetrics(), ...(state.metrics ?? {}) };
  state.metrics.routeMs ??= [];
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
    candidateReads: 0,
    publicChecks: 0,
    completedSeeds: 0,
    routeMs: [],
  };
}

function actionRecord(actionId) {
  return store.state.actions[sha256(actionId)];
}

function setActionRecord(actionId, record) {
  store.state.actions[sha256(actionId)] = record;
}

function candidateIdArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RequestError(400, "invalid_request", `${label} must be an array of at most ${maximum} candidate IDs`);
  }
  const result = value.map((item, index) => candidateIdValue(item, `${label}[${index}]`));
  return [...new Set(result)];
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

function draftRef(digest) {
  return `draft://sha256/${digest}`;
}

function publicEvidenceRef(evidenceId) {
  return `artifact://evidence/public/${evidenceId.slice("sha256:".length)}`;
}

function candidatePath(digest) {
  return join(artifactDirectory, "candidates", `${digest}.mjs`);
}

function publicEvidencePath(evidenceId) {
  return join(artifactDirectory, "evidence", "public", `${evidenceId.slice("sha256:".length)}.json`);
}

async function boundedCandidateSource(digest) {
  const source = await readFile(candidatePath(digest), "utf8");
  if (Buffer.byteLength(source) > 16_384 || sha256(source) !== digest) {
    throw new Error("Candidate artifact failed its content-addressed integrity check");
  }
  return source;
}

async function publicEvidenceById(evidenceId) {
  if (typeof evidenceId !== "string") throw new Error("Candidate has no public evidence reference");
  const document = await readJsonIfPresent(publicEvidencePath(evidenceId));
  if (document === null || document.publicEvidence?.evidenceId !== evidenceId) {
    throw new Error("Candidate public evidence is unavailable or invalid");
  }
  return document;
}

async function writeImmutable(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  try {
    await writeFile(path, value, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(path);
    const expected = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!existing.equals(expected)) throw new Error("Immutable artifact content conflict");
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

function validateRecoveredPublicEvidence(document, scope, candidateId, digest) {
  if (
    document.kind !== "public-checks" ||
    document.actionId !== scope.actionId ||
    document.requestHash !== scope.requestHash ||
    document.candidateId !== candidateId ||
    document.sourceSha256 !== digest
  ) {
    throw new Error("Recovered public evidence failed its immutable identity check");
  }
}

function sanitizePublicChecks(value) {
  if (!Array.isArray(value) || value.length !== PUBLIC_CASES.length) {
    throw new Error("Artifact sandbox returned the wrong number of public checks");
  }
  return PUBLIC_CASES.map((testCase, index) => ({
    name: testCase.name,
    passed: value[index]?.passed === true,
    ...(value[index]?.passed === true ? {} : {
      error: typeof value[index]?.error === "string" ? value[index].error.slice(0, 240) : "public check failed",
    }),
  }));
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
  return { status: 500, body: { error: "internal_error", message: "Artifact executor operation failed" } };
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
