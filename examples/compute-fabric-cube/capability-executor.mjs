import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TASKS, taskById } from "../repo-maintenance-swarm/maintenance-tasks.mjs";
import { evaluateSource } from "../repo-maintenance-swarm/maintenance-sandbox.mjs";

const port = Number(process.env.FABRIC_CAPABILITY_PORT ?? 19602);
const maxOutputTokens = Number(process.env.FABRIC_MAX_OUTPUT_TOKENS ?? 1400);
const runtimeMode = process.env.FABRIC_RUNTIME_MODE === "mock" ? "mock" : "openai";
const root = resolve(process.env.FABRIC_RUN_DIR ?? ".protein/compute-fabric/live");
const statePath = join(root, "capability-state.json");
const artifactDir = join(root, "artifacts");
await mkdir(artifactDir, { recursive: true });
let state = await load();
let requests = 0;
let active = 0;

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/stats") return json(response, 200, stats());
    if (request.method === "GET" && request.url?.startsWith("/jobs/")) {
      const key = decodeURIComponent(request.url.slice(6));
      return state.jobs[key] ? json(response, 200, state.jobs[key]) : json(response, 404, { error: "not_found" });
    }
    if (request.method !== "POST" || request.url !== "/jobs") return json(response, 404, { error: "not_found" });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string") return json(response, 400, { error: "missing_idempotency_key" });
    requests += 1;
    if (state.jobs[key]) return json(response, 200, state.jobs[key]);
    const body = await bodyJson(request);
    active += 1;
    state.started[key] = { at: Date.now(), tier: body.assignment?.tier ?? null, capabilityId: body.assignment?.capabilityId ?? null };
    await persist();
    try {
      const result = await execute(body.assignment, body.agent, body.actionId, key);
      state.jobs[key] = result;
      await persist();
      return json(response, 200, result);
    } finally {
      active -= 1;
    }
  } catch (error) {
    return json(response, 500, { error: String(error), stack: String(error?.stack ?? "").slice(0, 1400) });
  }
});
server.listen(port, "127.0.0.1", () => console.log(`fabric capability executor http://127.0.0.1:${port}`));

async function execute(assignment, agent, actionId, key) {
  const started = performance.now();
  const { tier, phase, workId, capabilityId, spec } = assignment;
  if (tier === "model") {
    let call;
    if (phase === "classify") {
      call = await modelOrMock("classify", spec, `Classify this repository incident and recommend the minimum compute needed for investigation. Known tasks are ${TASKS.map((task) => `${task.id}:${task.issue}`).join(" | ")}. Incident:${JSON.stringify(spec.report)}`, [tool("submit_triage", "Submit incident triage", { task_id: { type: "string", enum: TASKS.map((task) => task.id) }, recommended_tier: { type: "string", enum: ["bounded", "sandbox"] }, diagnosis: { type: "string", maxLength: 600 }, expected_evidence: { type: "string", maxLength: 400 } }, ["task_id", "recommended_tier", "diagnosis", "expected_evidence"])]);
    } else if (phase === "patch" || phase === "revise") {
      const task = taskById(spec.taskId);
      const prior = spec.source ?? task.source;
      call = await modelOrMock("patch", spec, `You are a repository repair agent. Fix ${task.file}: ${task.issue}\nReturn a complete dependency-free JavaScript function expression. Current source:\n${prior}\n${spec.feedback ? `Authoritative feedback:${JSON.stringify(spec.feedback)}` : ""}\nApproach label:${spec.approach ?? "direct"}`, [tool("submit_patch", "Submit a complete replacement", { source: { type: "string", maxLength: 12000 }, summary: { type: "string", maxLength: 500 }, risk: { type: "string", maxLength: 400 } }, ["source", "summary", "risk"])]);
    } else if (phase === "resolve-conflict") {
      call = await modelOrMock("resolve-conflict", spec, `Resolve an integration conflict between candidate patches for the same file. Prefer authoritative hidden-test evidence, then simpler source. Return one artifact ID. Candidates:${JSON.stringify(spec.candidates)}`, [tool("select_candidate", "Select the integration winner", { artifact_id: { type: "string", enum: spec.candidates.map((candidate) => candidate.artifactId) }, rationale: { type: "string", maxLength: 700 } }, ["artifact_id", "rationale"])]);
    } else {
      throw new Error(`unsupported model phase ${phase}`);
    }
    const artifact = await storeArtifact({ kind: `model-${phase}`, workId, output: call.arguments });
    return complete(assignment, receipt({ agent, actionId, capabilityId, tier, phase, workId, artifactId: artifact.id, parentArtifactIds: assignment.parentArtifactIds, started, provider: call.provider, resource: { modelCalls: call.provider === null ? 0 : 1, tokens: call.usage.total_tokens ?? 0, inputTokens: call.usage.input_tokens ?? 0, outputTokens: call.usage.output_tokens ?? 0, sandboxAttempts: 0 }, outcome: { status: "completed", output: call.arguments } }));
  }
  if (tier === "sandbox") {
    const task = taskById(spec.taskId);
    if (Number.isFinite(spec.delayMs) && spec.delayMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(spec.delayMs, 10_000)));
    let terminatedAttempt = false;
    if (spec.terminateFirstAttempt === true && !state.faults.terminatedSandboxCapabilities.includes(capabilityId)) {
      await terminateSandbox(capabilityId);
      state.faults.terminatedSandboxCapabilities.push(capabilityId);
      await persist();
      terminatedAttempt = true;
    }
    const evidence = await safeEvaluate(task, spec.source, false);
    const artifact = await storeSource(spec.source, { taskId: task.id, publicEvidence: evidence });
    return complete(assignment, receipt({ agent, actionId, capabilityId, tier, phase, workId, artifactId: artifact.id, parentArtifactIds: assignment.parentArtifactIds, started, resource: { modelCalls: 0, tokens: 0, sandboxAttempts: terminatedAttempt ? 2 : 1, terminatedAttempts: terminatedAttempt ? 1 : 0 }, outcome: { status: evidence.pass ? "completed" : "failed-checks", publicEvidence: evidence, source: spec.source } }));
  }
  if (tier === "bounded") {
    const task = taskById(spec.taskId);
    if (spec.deny === true) {
      return complete(assignment, receipt({ agent, actionId, capabilityId, tier, phase, workId, artifactId: null, parentArtifactIds: assignment.parentArtifactIds, started, resource: { modelCalls: 0, tokens: 0, sandboxAttempts: 0 }, outcome: { status: "denied", reason: "scheduled bounded-tier policy denial" } }));
    }
    const evidence = await safeEvaluate(task, spec.source, true);
    const artifact = await storeArtifact({ kind: "hidden-evaluation", taskId: task.id, candidateArtifactId: spec.candidateArtifactId, evidence });
    return complete(assignment, receipt({ agent, actionId, capabilityId, tier, phase, workId, artifactId: artifact.id, parentArtifactIds: assignment.parentArtifactIds, started, resource: { modelCalls: 0, tokens: 0, sandboxAttempts: 1 }, outcome: { status: evidence.pass ? "completed" : "failed-checks", hiddenEvidence: evidence, candidateArtifactId: spec.candidateArtifactId, source: spec.source } }));
  }
  throw new Error(`unsupported capability tier ${tier}`);
}

function receipt(value) {
  return { receiptId: `receipt:${value.capabilityId}`, capabilityId: value.capabilityId, actionId: value.actionId, tier: value.tier, phase: value.phase, workId: value.workId, agent: value.agent, status: value.outcome.status, artifactId: value.artifactId, parentArtifactIds: value.parentArtifactIds, provider: value.provider ?? null, resource: { ...value.resource, durationMs: Number((performance.now() - value.started).toFixed(2)) }, outcome: value.outcome, completedAt: Date.now() };
}
function complete(assignment, capabilityReceipt) { return { jobId: randomUUID(), status: "completed", summary: `${assignment.tier} ${assignment.phase} ${assignment.workId}`, assignment, receipt: capabilityReceipt }; }
async function safeEvaluate(task, source, hidden) { try { return await evaluateSource(task, source, hidden); } catch (error) { const total = hidden ? task.publicCases.length + task.hiddenCases.length : task.publicCases.length; return { pass: false, passed: 0, total, failures: [{ index: null, args: null, expected: null, actual: String(error).slice(0, 1000) }] }; } }
async function storeArtifact(value) { const body = JSON.stringify(value); const hash = createHash("sha256").update(body).digest("hex"); await writeFile(join(artifactDir, `${hash}.json`), JSON.stringify(value, null, 2)); return { id: `sha256:${hash}` }; }
async function storeSource(source, metadata) { const hash = createHash("sha256").update(source).digest("hex"); await writeFile(join(artifactDir, `${hash}.js`), source); await writeFile(join(artifactDir, `${hash}.meta.json`), JSON.stringify(metadata, null, 2)); return { id: `sha256:${hash}` }; }

async function respond(prompt, tools) {
  const response = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/responses`, { method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna", reasoning: { effort: process.env.OPENAI_REASONING_EFFORT ?? "low" }, input: [{ role: "user", content: prompt }], tools, tool_choice: "required", parallel_tool_calls: false, max_tool_calls: 1, max_output_tokens: maxOutputTokens, store: false }) });
  const raw = await response.json();
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${JSON.stringify(raw).slice(0, 900)}`);
  const item = raw.output?.find((entry) => entry.type === "function_call");
  if (!item) throw new Error("model did not call a function");
  return { arguments: JSON.parse(item.arguments), usage: raw.usage ?? {}, provider: { responseId: raw.id, model: raw.model } };
}
async function modelOrMock(kind, spec, prompt, tools) {
  if (runtimeMode === "openai") return respond(prompt, tools);
  if (kind === "classify") return { arguments: { task_id: spec.report.taskId, recommended_tier: "sandbox", diagnosis: `Deterministic triage for ${spec.report.taskId}`, expected_evidence: "public and hidden evaluator receipts" }, usage: {}, provider: null };
  if (kind === "patch") return { arguments: { source: spec.taskId === "retry-delay" && String(spec.approach).includes("alternative") ? `(attempt, base, max) => { const valid = Number.isInteger(attempt) && attempt >= 0 && Number.isFinite(base) && base > 0 && Number.isFinite(max) && max > 0; if (!valid) return null; const computed = base * Math.pow(2, attempt); return computed > max ? max : computed; }` : MOCK_SOURCES[spec.taskId], summary: `Deterministic repair for ${spec.taskId}`, risk: "rehearsal fixture" }, usage: {}, provider: null };
  if (kind === "resolve-conflict") return { arguments: { artifact_id: spec.candidates.find((candidate) => candidate.hiddenPass)?.artifactId ?? spec.candidates[0].artifactId, rationale: "Select an authoritatively passing rehearsal candidate." }, usage: {}, provider: null };
  throw new Error(`unsupported mock model operation ${kind}`);
}
function tool(name, description, properties, required) { return { type: "function", name, description, strict: true, parameters: { type: "object", properties, required, additionalProperties: false } }; }

async function terminateSandbox(capabilityId) {
  const name = `protein-fabric-fault-${process.pid}-${capabilityId.replace(/[^a-z0-9]/gi, "-").slice(-30)}`.toLowerCase();
  const child = spawn("docker", ["run", "--rm", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "64m", "--cpus", "0.5", "--pids-limit", "32", "node:22-alpine", "node", "-e", "setTimeout(()=>{},10000)"], { stdio: "ignore" });
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await new Promise((resolveDone) => { const killer = spawn("docker", ["kill", name], { stdio: "ignore" }); killer.once("close", resolveDone); killer.once("error", resolveDone); });
  await new Promise((resolveDone) => { if (child.exitCode !== null) resolveDone(); else child.once("close", resolveDone); });
}

function stats() {
  const jobs = Object.values(state.jobs);
  const receipts = jobs.map((job) => job.receipt);
  return { requests, active, jobs: jobs.length, started: Object.keys(state.started).length, modelCalls: receipts.reduce((sum, item) => sum + (item.resource?.modelCalls ?? 0), 0), tokens: receipts.reduce((sum, item) => sum + (item.resource?.tokens ?? 0), 0), sandboxAttempts: receipts.reduce((sum, item) => sum + (item.resource?.sandboxAttempts ?? 0), 0), tiers: Object.fromEntries(["model", "bounded", "sandbox"].map((tier) => [tier, receipts.filter((item) => item.tier === tier).length])), denied: receipts.filter((item) => item.status === "denied").length, terminatedSandboxAttempts: receipts.reduce((sum, item) => sum + (item.resource?.terminatedAttempts ?? 0), 0), faults: state.faults, runtimeMode, model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna", maxOutputTokens };
}
async function load() { try { return JSON.parse(await readFile(statePath, "utf8")); } catch { return { schemaVersion: 1, jobs: {}, started: {}, faults: { terminatedSandboxCapabilities: [] } }; } }
async function persist() { await writeFile(statePath, JSON.stringify(state, null, 2)); }
async function bodyJson(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
function json(response, status, value) { const body = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); response.end(body); }

const MOCK_SOURCES = {
  "slugify": `(value) => { const normalized = String(value).normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); return normalized || "item"; }`,
  "merge-headers": `(base, extra) => { const out = {}; for (const source of [base, extra]) for (const [key, value] of Object.entries(source)) { const prior = Object.keys(out).find((name) => name.toLowerCase() === key.toLowerCase()); if (value === undefined) continue; if (prior !== undefined) delete out[prior]; out[key] = value; } return out; }`,
  "parse-duration": `(text) => { const match = /^\\s*(\\d+(?:\\.\\d+)?)\\s*(ms|s|m|h)\\s*$/.exec(String(text)); if (!match) return null; const factors = { ms: 1, s: 1000, m: 60000, h: 3600000 }; const value = Number(match[1]) * factors[match[2]]; return Number.isFinite(value) && value >= 0 ? Math.round(value) : null; }`,
  "retry-delay": `(attempt, base, max) => { if (!Number.isInteger(attempt) || attempt < 0 || !Number.isFinite(base) || base <= 0 || !Number.isFinite(max) || max <= 0) return null; return Math.min(max, base * (2 ** attempt)); }`,
};
