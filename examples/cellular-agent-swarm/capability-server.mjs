import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  BENCHMARK,
  evaluateArtifact,
  evidenceDigest,
  strategyKeys,
} from "./artifact-benchmark.mjs";

const root = process.cwd();
const port = Number(process.env.SWARM_CAPABILITY_PORT ?? 19120);
const statePath = resolve(
  process.env.SWARM_CAPABILITY_STATE ??
    join(root, ".protein/cellular-agent-swarm/capability-state.json"),
);
const artifactDirectory = resolve(
  process.env.SWARM_ARTIFACT_DIR ??
    join(root, ".protein/cellular-agent-swarm/artifacts"),
);
const logPath = resolve(
  process.env.SWARM_CAPABILITY_LOG ??
    join(root, ".protein/cellular-agent-swarm/capability.jsonl"),
);
const state = await loadState();
let writeQueue = Promise.resolve();
let logQueue = Promise.resolve();

const server = createServer(async (request, response) => {
  const startedAt = performance.now();
  const method = request.method ?? "GET";
  let pathname = "/";
  let status = 500;
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    pathname = url.pathname;

    if (method === "GET" && pathname === "/health") {
      status = 200;
      return json(response, status, {
        status: "ok",
        service: "protein-swarm-mock-capabilities",
        evidenceLevel: "celld-smoke-mock-services",
        benchmark: BENCHMARK,
      });
    }
    if (method === "GET" && pathname === "/stats") {
      status = 200;
      return json(response, status, stats());
    }
    if (method === "GET" && pathname === "/snapshot") {
      status = 200;
      return json(response, status, state);
    }
    if (method === "POST" && pathname === "/seed") {
      const body = await bodyJson(request);
      const result = await materialize("baseline", "seed", body.experimentId ?? "unscoped");
      await persist();
      status = 200;
      return json(response, status, result);
    }
    if (method === "POST" && pathname === "/actions") {
      const body = await bodyJson(request);
      const result = await actionReceipt(request, body);
      status = result.status;
      return json(response, status, result.body);
    }
    if (method === "GET" && pathname.startsWith("/actions/")) {
      const id = decodeURIComponent(pathname.slice("/actions/".length));
      const receipt = state.actions[id];
      status = receipt === undefined ? 404 : 200;
      return json(response, status, receipt === undefined ? { error: "receipt_not_found" } : receipt.result);
    }
    if (method === "POST" && pathname === "/submissions") {
      const body = await bodyJson(request);
      const result = await submissionReceipt(request, body);
      status = result.status;
      return json(response, status, result.body);
    }
    if (method === "GET" && pathname.startsWith("/submissions/")) {
      const id = decodeURIComponent(pathname.slice("/submissions/".length));
      const receipt = state.submissions[id];
      status = receipt === undefined ? 404 : 200;
      return json(response, status, receipt === undefined ? { error: "receipt_not_found" } : receipt.result);
    }

    status = 404;
    return json(response, status, { error: "not_found" });
  } catch (error) {
    status = 500;
    await record("request.failed", { method, pathname, error: String(error) });
    return json(response, status, { error: "internal_error", message: String(error) });
  } finally {
    state.metrics.requests += 1;
    if (status >= 500) state.metrics.serverErrors += 1;
    else if (status === 404 && method === "GET" && (pathname.startsWith("/actions/") || pathname.startsWith("/submissions/"))) {
      state.metrics.reconciliationMisses += 1;
    } else if (status >= 400) {
      state.metrics.clientErrors += 1;
    }
    const durationMs = Number((performance.now() - startedAt).toFixed(3));
    state.metrics.routeMs.push(durationMs);
    if (state.metrics.routeMs.length > 500) state.metrics.routeMs.shift();
    void record("http.request", { method, pathname, status, durationMs });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Protein swarm mock capabilities: http://127.0.0.1:${port}`);
  void record("service.started", { port, pid: process.pid });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => {
      void Promise.all([persist(), record("service.stopped", { signal })]).finally(() => process.exit(0));
    });
  });
}

async function actionReceipt(request, body) {
  const validated = validateReceiverRequest(request, body);
  const existing = state.actions[validated.actionId];
  if (existing !== undefined) {
    if (existing.requestHash !== validated.requestHash) {
      state.metrics.conflicts += 1;
      await record("action.conflict", { actionId: validated.actionId });
      return { status: 409, body: { error: "action_id_conflict" } };
    }
    state.metrics.duplicateActions += 1;
    await record("action.duplicate", { actionId: validated.actionId, actionKind: body.kind });
    return { status: 200, body: existing.result };
  }

  const createdAt = Date.now();
  let result;
  if (body.kind === "swarm.decide") {
    result = await decide(body.agent, body.payload);
  } else if (body.kind === "swarm.materialize") {
    const decision = objectValue(objectValue(body.payload, "action payload").decision, "decision");
    result = await materialize(
      stringValue(decision.strategy, "decision strategy"),
      stringValue(decision.behavior, "decision behavior"),
      validated.actionId,
    );
  } else if (body.kind === "swarm.challenge") {
    const payload = objectValue(body.payload, "challenge payload");
    result = await materialize(
      stringValue(payload.strategy, "challenge strategy"),
      "challenge",
      validated.actionId,
    );
  } else {
    return { status: 400, body: { error: "unsupported_action_kind" } };
  }

  state.actions[validated.actionId] = {
    actionId: validated.actionId,
    requestHash: validated.requestHash,
    agent: body.agent,
    kind: body.kind,
    createdAt,
    result,
  };
  state.metrics.createdActions += 1;
  await persist();
  await record("action.created", {
    actionId: validated.actionId,
    agent: body.agent,
    actionKind: body.kind,
    result,
  });
  return { status: 200, body: result };
}

async function submissionReceipt(request, body) {
  const validated = validateReceiverRequest(request, body);
  const existing = state.submissions[validated.actionId];
  if (existing !== undefined) {
    if (existing.requestHash !== validated.requestHash) {
      state.metrics.conflicts += 1;
      await record("submission.conflict", { actionId: validated.actionId });
      return { status: 409, body: { error: "action_id_conflict" } };
    }
    state.metrics.duplicateSubmissions += 1;
    await record("submission.duplicate", { actionId: validated.actionId });
    return { status: 200, body: existing.result };
  }

  const payload = objectValue(body.payload, "submission payload");
  const cell = objectValue(payload.cell, "submission cell snapshot");
  const result = {
    accepted: true,
    submissionId: `submission:${sha256(validated.actionId).slice(0, 24)}`,
    experimentId: stringValue(payload.experimentId, "experimentId"),
    generation: numberValue(payload.generation, "generation"),
    agent: stringValue(payload.agent, "agent"),
    candidateId: stringValue(cell.candidateId, "cell candidateId"),
    score: numberValue(cell.score, "cell score"),
    receivedAt: Date.now(),
  };
  state.submissions[validated.actionId] = {
    actionId: validated.actionId,
    requestHash: validated.requestHash,
    agent: body.agent,
    kind: body.kind,
    createdAt: Date.now(),
    payload,
    result,
  };
  state.metrics.createdSubmissions += 1;
  await persist();
  await record("submission.created", { actionId: validated.actionId, result });
  return { status: 200, body: result };
}

async function decide(agent, rawObservation) {
  const observation = objectValue(rawObservation, "observation");
  const generation = numberValue(observation.generation, "generation");
  const credits = numberValue(observation.credits, "credits");
  const currentScore = numberValue(observation.score, "score");
  const condition = stringValue(observation.condition, "condition");
  const neighborhood = Array.isArray(observation.neighborhood)
    ? observation.neighborhood.map((value) => objectValue(value, "neighbor"))
    : [];

  if (credits <= 0) {
    return { behavior: "wait", rationale: "The durable budget grant is exhausted." };
  }

  const best = [...neighborhood]
    .filter((candidate) => typeof candidate.score === "number")
    .sort((left, right) => Number(right.score) - Number(left.score))[0];
  if (
    condition === "local" &&
    generation > 1 &&
    best !== undefined &&
    Number(best.score) > currentScore * 1.04 &&
    typeof best.candidateId === "string"
  ) {
    return {
      behavior: "adopt",
      targetCandidateId: best.candidateId,
      rationale: "A candidate in the frozen local neighborhood has materially stronger evaluator evidence.",
    };
  }

  const slot = stableSlot(agent, 4);
  const firstStrategies = ["sort_scan", "chunk_merge", "adaptive_runs", "sparse_bitmap"];
  let strategy = firstStrategies[slot];
  if (generation > 1) {
    const visibleStrategies = new Set(
      neighborhood.map((candidate) => candidate.strategy).filter((value) => typeof value === "string"),
    );
    strategy =
      condition === "local" && visibleStrategies.has("chunk_merge") && visibleStrategies.has("adaptive_runs")
        ? "radix_int32"
        : slot % 2 === 0
          ? "sort_scan"
          : "adaptive_runs";
  }
  if (!strategyKeys().includes(strategy)) strategy = "sort_scan";
  return {
    behavior: generation === 1 ? "explore" : "improve",
    strategy,
    rationale:
      generation === 1
        ? "Explore a bounded implementation family and submit measured evaluator evidence."
        : "Use the current cell and visible evidence to select the next bounded implementation family.",
  };
}

async function materialize(strategy, behavior, scope) {
  const evaluation = evaluateArtifact(strategy);
  const candidateId = `sha256:${evaluation.sourceSha256}`;
  const evidence = {
    schemaVersion: 1,
    evidenceLevel: "celld-smoke-mock-services",
    evaluatorIsolation: "none-in-process-smoke-only",
    scope,
    evaluatedAt: new Date().toISOString(),
    ...evaluation,
    source: undefined,
  };
  const evidenceId = `sha256:${evidenceDigest(evidence)}`;
  await mkdir(artifactDirectory, { recursive: true });
  const sourcePath = join(artifactDirectory, `${evaluation.sourceSha256}.mjs`);
  const evidencePath = join(artifactDirectory, `${evidenceId.slice("sha256:".length)}.evidence.json`);
  await Promise.all([
    writeFile(sourcePath, evaluation.source),
    writeFile(evidencePath, JSON.stringify({ ...evidence, evidenceId }, null, 2)),
  ]);
  state.artifacts[candidateId] = {
    candidateId,
    strategy,
    artifactRef: `artifact://sha256/${evaluation.sourceSha256}`,
    evidenceId,
    sourcePath,
    evidencePath,
  };
  return {
    candidateId,
    strategy,
    score: evaluation.score,
    evidenceId,
    artifactRef: `artifact://sha256/${evaluation.sourceSha256}`,
    behavior,
    publicPass: evaluation.publicPass,
    hiddenPass: evaluation.hiddenPass,
    benchmark: evaluation.benchmark,
  };
}

function validateReceiverRequest(request, body) {
  const object = objectValue(body, "receiver request");
  const actionId = stringValue(object.actionId, "actionId");
  const headerId = request.headers["idempotency-key"];
  if (headerId !== undefined && headerId !== actionId) {
    throw new Error("Idempotency-Key header does not match actionId");
  }
  stringValue(object.agent, "agent");
  stringValue(object.kind, "kind");
  objectValue(object.payload, "payload");
  return { actionId, requestHash: sha256(canonicalJson(object)) };
}

function stats() {
  const ordered = [...state.metrics.routeMs].sort((left, right) => left - right);
  const percentile = (ratio) =>
    ordered.length === 0 ? 0 : ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))];
  return {
    evidenceLevel: "celld-smoke-mock-services",
    service: "protein-swarm-mock-capabilities",
    startedAt: state.startedAt,
    ...state.metrics,
    routeMs: undefined,
    p50RouteMs: Number(percentile(0.5).toFixed(3)),
    p95RouteMs: Number(percentile(0.95).toFixed(3)),
    actions: Object.keys(state.actions).length,
    submissions: Object.keys(state.submissions).length,
    artifacts: Object.keys(state.artifacts).length,
  };
}

async function loadState() {
  if (existsSync(statePath)) {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    parsed.actions ??= {};
    parsed.submissions ??= {};
    parsed.artifacts ??= {};
    parsed.metrics = { ...freshMetrics(), ...(parsed.metrics ?? {}) };
    parsed.metrics.routeMs ??= [];
    return parsed;
  }
  return {
    schemaVersion: 1,
    evidenceLevel: "celld-smoke-mock-services",
    startedAt: new Date().toISOString(),
    actions: {},
    submissions: {},
    artifacts: {},
    metrics: freshMetrics(),
  };
}

function freshMetrics() {
  return {
    requests: 0,
    serverErrors: 0,
    clientErrors: 0,
    reconciliationMisses: 0,
    createdActions: 0,
    duplicateActions: 0,
    createdSubmissions: 0,
    duplicateSubmissions: 0,
    conflicts: 0,
    routeMs: [],
  };
}

function persist() {
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(state, null, 2));
    await rename(temporaryPath, statePath);
  });
  return writeQueue;
}

function record(kind, data) {
  logQueue = logQueue.then(async () => {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify({
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      ...data,
      kind,
    })}\n`);
  });
  return logQueue;
}

async function bodyJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2_000_000) throw new Error("Request body is too large");
  }
  return body.length === 0 ? {} : JSON.parse(body);
}

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function objectValue(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function stringValue(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function numberValue(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function stableSlot(value, slots) {
  const digest = createHash("sha256").update(value).digest();
  return digest.readUInt32BE(0) % slots;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
