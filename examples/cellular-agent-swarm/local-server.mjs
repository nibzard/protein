import { createServer } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import {
  comparison,
  createRun,
  evaluateStrategy,
  findCandidate,
  advanceRun,
  validateRun,
} from "./simulation.mjs";

const root = process.cwd();
const publicDirectory = join(root, "examples/cellular-agent-swarm/public");
const statePath = join(root, ".protein/cellular-agent-swarm.json");
const logDirectory = process.env.PROTEIN_SWARM_LOG_DIR ?? join(root, ".protein/cellular-agent-swarm/logs");
const logPath = join(logDirectory, "harness.jsonl");
const celldRunsDirectory = join(root, ".protein/cellular-agent-swarm/celld-runs");
const celldComparisonsDirectory = join(root, ".protein/cellular-agent-swarm/comparisons");
const port = Number(process.env.SWARM_PORT ?? 8788);
const MILESTONE_KINDS = new Set([
  "run.started",
  "run.finished",
  "phase.changed",
  "capability.started",
  "live.services.started",
  "celld.started",
  "celld.stopped",
  "celld.restart.recovered",
  "event.identity.checked",
  "generation.settled",
]);
let run = await loadRun();
let logQueue = Promise.resolve();
const telemetry = {
  startedAt: new Date().toISOString(),
  requests: 0,
  failures: 0,
  totalRouteMs: 0,
  maxRouteMs: 0,
  recentRouteMs: [],
  peakRssBytes: process.memoryUsage().rss,
  samples: 0,
};

void recordTelemetry("harness.started", { port, runId: run.id, condition: run.condition });
const sampler = setInterval(() => {
  sampleRuntime();
  void recordTelemetry("harness.sample", runtimeSnapshot());
}, 5_000);
sampler.unref();

const server = createServer(async (request, response) => {
  const startedAt = performance.now();
  let pathname = "/";
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    pathname = url.pathname;
    if (url.pathname === "/api/state" && request.method === "GET") {
      return json(response, 200, present(run));
    }
    if (url.pathname === "/api/telemetry" && request.method === "GET") {
      return json(response, 200, runtimeSnapshot());
    }
    if (url.pathname === "/api/celld/latest" && request.method === "GET") {
      const bundle = await latestCelldBundle();
      return bundle === null
        ? json(response, 404, { error: "no_celld_run" })
        : json(response, 200, { pointer: bundle.pointer, manifest: bundle.manifest, summary: bundle.summary });
    }
    if (url.pathname === "/api/celld/comparison/latest" && request.method === "GET") {
      const bundle = await latestComparisonBundle();
      return bundle === null
        ? json(response, 404, { error: "no_celld_comparison" })
        : json(response, 200, {
          pointer: bundle.pointer,
          summary: bundle.summary,
          lineage: await comparisonLineageProjection(bundle.summary),
        });
    }
    if (url.pathname === "/api/celld/latest/cells" && request.method === "GET") {
      const bundle = await latestCelldBundle();
      return bundle === null
        ? json(response, 404, { error: "no_celld_run" })
        : json(response, 200, await celldCellProjection(bundle));
    }
    if (url.pathname === "/api/celld/latest/timeline" && request.method === "GET") {
      const bundle = await latestCelldBundle();
      if (bundle === null) return json(response, 404, { error: "no_celld_run" });
      const limit = boundedNumber(url.searchParams.get("limit"), 80, 1, 500);
      const mode = url.searchParams.get("mode") ?? "events";
      let events = parseJsonLines(await readFile(join(bundle.outputDirectory, "timeline.jsonl"), "utf8"));
      if (mode === "milestones") {
        events = events.filter((event) => MILESTONE_KINDS.has(event.kind));
      } else if (mode !== "all") {
        events = events.filter((event) => event.kind !== "protein.journal");
      }
      return json(response, 200, {
        mode,
        events: events.slice(-limit).reverse(),
      });
    }
    if (url.pathname === "/api/celld/latest/log" && request.method === "GET") {
      const bundle = await latestCelldBundle();
      if (bundle === null) return json(response, 404, { error: "no_celld_run" });
      const source = url.searchParams.get("source") === "capability" ? "capability" : "celld";
      const limit = boundedNumber(url.searchParams.get("lines"), 120, 1, 500);
      const path = source === "celld"
        ? join(bundle.outputDirectory, "processes/celld.log")
        : join(bundle.outputDirectory, "processes/capability.jsonl");
      const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean).slice(-limit);
      return json(response, 200, { source, lines });
    }
    if (url.pathname === "/actions" && request.method === "POST") {
      const body = await bodyJson(request);
      return json(response, 200, await actionReceipt(body));
    }
    if (url.pathname.startsWith("/actions/") && request.method === "GET") {
      return receiptLookup(response, url.pathname, "/actions/");
    }
    if (url.pathname === "/submissions" && request.method === "POST") {
      const body = await bodyJson(request);
      return json(response, 200, await submissionReceipt(body));
    }
    if (url.pathname.startsWith("/submissions/") && request.method === "GET") {
      return receiptLookup(response, url.pathname, "/submissions/");
    }
    if (url.pathname === "/api/comparison" && request.method === "GET") {
      return json(response, 200, { evidenceLevel: "scripted-simulation", rows: comparison(run.seed) });
    }
    if (url.pathname === "/api/reset" && request.method === "POST") {
      const body = await bodyJson(request);
      run = createRun({
        condition: typeof body.condition === "string" ? body.condition : "local",
        seed: Number.isFinite(body.seed) ? body.seed : 90311,
      });
      await saveRun();
      void recordTelemetry("experiment.reset", experimentSnapshot());
      return json(response, 200, present(run));
    }
    if (url.pathname === "/api/step" && request.method === "POST") {
      advanceRun(run);
      validateRun(run);
      await saveRun();
      void recordTelemetry("generation.advanced", experimentSnapshot());
      return json(response, 200, present(run));
    }
    if (url.pathname.startsWith("/api/candidate/") && request.method === "GET") {
      const candidate = findCandidate(run, decodeURIComponent(url.pathname.slice("/api/candidate/".length)));
      return candidate === null
        ? json(response, 404, { error: "candidate_not_found" })
        : json(response, 200, candidate);
    }
    if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "not_found" });
    return serveStatic(url.pathname, response);
  } catch (error) {
    telemetry.failures += 1;
    void recordTelemetry("request.failed", { method: request.method, pathname, error: String(error) });
    console.error(error);
    return json(response, 500, { error: "internal_error", message: String(error) });
  } finally {
    recordRequest(request.method ?? "GET", pathname, performance.now() - startedAt);
  }
});

server.listen(port, () => {
  console.log(`Cellular Agent Swarm scripted scenario: http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    clearInterval(sampler);
    void recordTelemetry("harness.stopped", runtimeSnapshot()).finally(() => process.exit(0));
  });
}

async function loadRun() {
  if (!existsSync(statePath)) return createRun();
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    parsed.actionReceipts ??= {};
    validateRun(parsed);
    return parsed;
  } catch (error) {
    console.warn("Could not restore previous swarm run; starting a new one.", error);
    return createRun();
  }
}

async function saveRun() {
  await mkdir(join(root, ".protein"), { recursive: true });
  await writeFile(statePath, JSON.stringify(run, null, 2));
}

function recordRequest(method, pathname, durationMs) {
  telemetry.requests += 1;
  telemetry.totalRouteMs += durationMs;
  telemetry.maxRouteMs = Math.max(telemetry.maxRouteMs, durationMs);
  telemetry.recentRouteMs.push(durationMs);
  if (telemetry.recentRouteMs.length > 200) telemetry.recentRouteMs.shift();
  sampleRuntime();
  void recordTelemetry("http.request", {
    method,
    pathname,
    durationMs: Number(durationMs.toFixed(2)),
  });
}

function sampleRuntime() {
  telemetry.peakRssBytes = Math.max(telemetry.peakRssBytes, process.memoryUsage().rss);
  telemetry.samples += 1;
}

function runtimeSnapshot() {
  const ordered = [...telemetry.recentRouteMs].sort((left, right) => left - right);
  const p95 = ordered.length === 0 ? 0 : ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))];
  return {
    layer: "node-local-harness",
    startedAt: telemetry.startedAt,
    requests: telemetry.requests,
    failures: telemetry.failures,
    averageRouteMs: telemetry.requests === 0 ? 0 : Number((telemetry.totalRouteMs / telemetry.requests).toFixed(2)),
    p95RouteMs: Number(p95.toFixed(2)),
    maxRouteMs: Number(telemetry.maxRouteMs.toFixed(2)),
    peakRssMb: Number((telemetry.peakRssBytes / 1024 / 1024).toFixed(1)),
    samples: telemetry.samples,
    experiment: experimentSnapshot(),
  };
}

function experimentSnapshot() {
  return {
    runId: run.id,
    condition: run.condition,
    status: run.status,
    generation: run.generation,
    bestScore: Math.max(...run.cells.map((cell) => cell.score)),
    credits: run.usage.credits,
    modelTurns: run.usage.modelTurns,
    evaluations: run.usage.evaluations,
  };
}

function recordTelemetry(kind, data) {
  logQueue = logQueue
    .then(async () => {
      await mkdir(logDirectory, { recursive: true });
      await appendFile(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), kind, ...data })}\n`);
    })
    .catch((error) => console.error("Could not write swarm telemetry", error));
  return logQueue;
}

async function latestCelldBundle() {
  const pointerPath = join(celldRunsDirectory, "latest.json");
  if (!existsSync(pointerPath)) return null;
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  if (typeof pointer.outputDirectory !== "string") throw new Error("Invalid celld run pointer");
  const outputDirectory = resolve(pointer.outputDirectory);
  const runsRoot = resolve(celldRunsDirectory);
  if (outputDirectory !== runsRoot && !outputDirectory.startsWith(`${runsRoot}${sep}`)) {
    throw new Error("Celld run pointer escapes the run directory");
  }
  const [manifest, summary] = await Promise.all([
    readJson(join(outputDirectory, "manifest.json")),
    readJson(join(outputDirectory, "summary.json")),
  ]);
  return { pointer, outputDirectory, manifest, summary };
}

async function latestComparisonBundle() {
  const pointerPath = join(celldComparisonsDirectory, "latest.json");
  if (!existsSync(pointerPath)) return null;
  const pointer = await readJson(pointerPath);
  if (typeof pointer.outputDirectory !== "string") throw new Error("Invalid comparison pointer");
  const outputDirectory = safeChildPath(pointer.outputDirectory, celldComparisonsDirectory, "Comparison pointer");
  const summary = await readJson(join(outputDirectory, "summary.json"));
  if (summary?.evidenceLevel !== "celld-comparison") {
    throw new Error("Latest comparison has an unsupported evidence level");
  }
  return { pointer, outputDirectory, summary };
}

async function comparisonLineageProjection(summary) {
  const trials = Array.isArray(summary?.trials) ? summary.trials : [];
  const lineage = [];
  const collectionErrors = [];
  for (const trial of trials) {
    for (const condition of ["local", "isolated"]) {
      const run = trial?.conditions?.[condition];
      if (typeof run?.summaryPath !== "string") continue;
      try {
        const summaryPath = safeChildPath(run.summaryPath, celldRunsDirectory, "Comparison run summary");
        const boardPath = join(dirname(summaryPath), "board-state.json");
        if (!existsSync(boardPath)) continue;
        const board = await readJson(boardPath);
        const snapshots = Object.values(board?.snapshots ?? {})
          .filter((snapshot) => snapshot !== null && typeof snapshot === "object")
          .sort((left, right) => Number(left.generation ?? 0) - Number(right.generation ?? 0));
        lineage.push({
          trial: trial.trial,
          condition,
          runId: run.runId,
          generations: snapshots.map(lineageGeneration),
        });
      } catch (error) {
        collectionErrors.push({
          trial: trial?.trial ?? null,
          condition,
          runId: run?.runId ?? null,
          message: String(error),
        });
      }
    }
  }
  return { runs: lineage, collectionErrors };
}

function lineageGeneration(snapshot) {
  const cells = Object.entries(snapshot.cells ?? {});
  const expectedAgents = Array.isArray(snapshot.expectedAgents) ? snapshot.expectedAgents : cells.map(([agent]) => agent);
  const candidates = new Map();
  let adoptions = 0;
  for (const [agent, record] of cells) {
    if (record?.behavior === "adopt") adoptions += 1;
    const candidateId = typeof record?.candidateId === "string" ? record.candidateId : "unknown";
    const candidate = candidates.get(candidateId) ?? {
      candidateId,
      strategy: typeof record?.strategy === "string" ? record.strategy : "unrecorded strategy",
      score: Number(record?.score ?? 0),
      holders: 0,
      adoptedBy: 0,
      originAgent: null,
    };
    candidate.holders += 1;
    if (record?.behavior === "adopt") candidate.adoptedBy += 1;
    candidate.score = Math.max(candidate.score, Number(record?.score ?? 0));
    if (candidate.originAgent === null && typeof record?.evaluationActionId === "string") {
      candidate.originAgent = expectedAgents.find((id) => record.evaluationActionId.includes(id)) ?? null;
    }
    if (candidate.originAgent === null && record?.behavior !== "adopt" && record?.behavior !== "wait") {
      candidate.originAgent = agent;
    }
    candidates.set(candidateId, candidate);
  }
  const ordered = [...candidates.values()].sort((left, right) => right.score - left.score || right.holders - left.holders);
  return {
    generation: Number(snapshot.generation ?? 0),
    cells: cells.length,
    candidates: ordered.length,
    adoptions,
    leader: ordered[0] ?? null,
  };
}

function safeChildPath(value, parent, label) {
  const path = resolve(value);
  const allowedRoot = resolve(parent);
  if (path !== allowedRoot && !path.startsWith(`${allowedRoot}${sep}`)) {
    throw new Error(`${label} escapes its evidence directory`);
  }
  return path;
}

async function celldCellProjection(bundle) {
  const ids = Array.isArray(bundle.manifest?.topology?.cells) ? bundle.manifest.topology.cells : [];
  const results = await Promise.all(ids.map(async (cellId) => {
    if (typeof cellId !== "string" || !/^[A-Za-z0-9._-]+$/.test(cellId)) {
      throw new Error("Invalid cell ID in celld manifest");
    }
    try {
      const directory = join(bundle.outputDirectory, "cells", cellId);
      const [stateResult, actionResult] = await Promise.all([
        readJson(join(directory, "final-state.json")),
        readJson(join(directory, "actions.json")),
      ]);
      const actions = Array.isArray(actionResult.actions) ? actionResult.actions : [];
      const state = stateResult.state ?? {};
      return {
        cell: {
          id: cellId,
          generation: state.generation ?? 0,
          status: state.status ?? "unknown",
          strategy: state.strategy ?? null,
          score: state.score ?? 0,
          credits: state.credits ?? 0,
          behavior: state.lastBehavior ?? null,
          actions: actions.length,
          redeliveries: actions.filter((action) => Number(action.attempts) > 1).length,
        },
      };
    } catch (error) {
      return { error: { cellId, message: String(error) } };
    }
  }));
  return {
    cells: results.flatMap((result) => result.cell === undefined ? [] : [result.cell]),
    collectionErrors: results.flatMap((result) => result.error === undefined ? [] : [result.error]),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseJsonLines(value) {
  return value.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

async function actionReceipt(body) {
  run.actionReceipts ??= {};
  const actionId = requireActionId(body);
  const existing = run.actionReceipts[actionId];
  if (existing) return existing.result;
  const kind = typeof body.kind === "string" ? body.kind : "";
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  let result;
  if (kind === "swarm.decide") {
    result = decideFromObservation(payload);
  } else if (kind === "swarm.materialize") {
    const decision = payload.decision && typeof payload.decision === "object" ? payload.decision : {};
    const strategy = typeof decision.strategy === "string" ? decision.strategy : "stream_scan";
    const evaluated = evaluateStrategy(strategy);
    result = {
      candidateId: `external-${strategy}-${actionId.slice(-10)}`,
      score: evaluated.score,
      evidenceId: `evidence-${actionId}`,
      behavior: typeof decision.behavior === "string" ? decision.behavior : "explore",
      evaluator: evaluated,
    };
  } else {
    throw new Error(`Unsupported executor action ${kind}`);
  }
  run.actionReceipts[actionId] = { kind, result };
  await saveRun();
  return result;
}

async function submissionReceipt(body) {
  run.actionReceipts ??= {};
  const actionId = requireActionId(body);
  const existing = run.actionReceipts[actionId];
  if (existing) return existing.result;
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const result = {
    accepted: true,
    submissionId: `submission-${actionId.slice(-10)}`,
    generation: typeof payload.generation === "number" ? payload.generation : null,
  };
  run.actionReceipts[actionId] = { kind: "swarm.submit", result };
  await saveRun();
  return result;
}

function receiptLookup(response, pathname, prefix) {
  run.actionReceipts ??= {};
  const actionId = decodeURIComponent(pathname.slice(prefix.length));
  const receipt = run.actionReceipts[actionId];
  return receipt === undefined
    ? json(response, 404, { error: "receipt_not_found" })
    : json(response, 200, receipt.result);
}

function decideFromObservation(observation) {
  const neighborhood = Array.isArray(observation.neighborhood) ? observation.neighborhood : [];
  const best = neighborhood
    .filter((item) => item && typeof item === "object" && typeof item.score === "number")
    .sort((left, right) => right.score - left.score)[0];
  if (best && best.score > (typeof observation.score === "number" ? observation.score : 0) + 80) {
    return {
      behavior: "adopt",
      targetCandidateId: typeof best.candidateId === "string" ? best.candidateId : null,
      rationale: "A neighboring verifier result is materially stronger than the local candidate.",
    };
  }
  return {
    behavior: "improve",
    strategy: neighborhood.some((item) => item?.strategy === "chunk_merge") ? "radix_window" : "stream_scan",
    rationale: "The deterministic gateway selected the next bounded improvement from the permitted observation.",
  };
}

function requireActionId(body) {
  if (typeof body.actionId !== "string" || body.actionId.length === 0) {
    throw new Error("actionId is required");
  }
  return body.actionId;
}

function present(current) {
  const candidates = Object.fromEntries(current.candidates.map((candidate) => [candidate.id, candidate]));
  return {
    ...current,
    evidenceLevel: "scripted-simulation",
    candidates,
    events: [...current.events].reverse(),
  };
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = resolve(publicDirectory, `.${requested}`);
  if (!safePath.startsWith(resolve(publicDirectory))) return json(response, 403, { error: "forbidden" });
  try {
    const content = await readFile(safePath);
    response.writeHead(200, {
      "content-type": contentType(extname(safePath)),
      "cache-control": "no-store",
    });
    response.end(content);
  } catch {
    json(response, 404, { error: "not_found" });
  }
}

function contentType(extension) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  }[extension] ?? "application/octet-stream";
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
