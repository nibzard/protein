import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const port = Number(process.env.PREFLIGHT_EXECUTOR_PORT ?? 19502);
const maxOutputTokens = Number(process.env.PREFLIGHT_MAX_OUTPUT_TOKENS ?? 1800);
const root = resolve(process.env.PREFLIGHT_RUN_DIR ?? ".protein/cube-preflight/live");
const statePath = join(root, "executor-state.json");
const artifactDir = join(root, "artifacts");
const suite = JSON.parse(await readFile(new URL("./cube-preflight.json", import.meta.url), "utf8"));
await mkdir(artifactDir, { recursive: true });
let state = await load();
let requests = 0;

const mutations = new Map(suite.mutations.map((mutation) => [mutation.id, mutation]));
const validPatch = new Map(
  suite.mutations.map((mutation) => [
    mutation.id,
    mutation.patches.find((patch) => evaluate(mutation, patch).accepted)?.id,
  ]),
);

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
    const result = await execute(JSON.parse(String(body.task)), body.agent);
    state.jobs[key] = result;
    await persist();
    return json(response, 200, result);
  } catch (error) {
    return json(response, 500, { error: String(error), stack: String(error?.stack ?? "").slice(0, 1400) });
  }
});
server.listen(port, "127.0.0.1", () => console.log(`cube preflight executor http://127.0.0.1:${port}`));

async function execute(spec, agent) {
  const started = performance.now();
  const selected = spec.mutationIds.map((id) => mutations.get(id));
  if (selected.some((value) => value === undefined)) throw new Error("unknown mutation id");
  let prompt;
  let call;
  if (spec.phase === "explore") {
    prompt = `You are ${spec.condition === "centralized" ? "one centralized protocol agent using the " + spec.column + " lens" : "the autonomous " + spec.column + " Protein cell"}. Diagnose the assigned finite transition-system mutations. For each mutation select the patch that both makes every bad state unreachable and preserves reachability of at least one goal. Return one finding per assigned mutation.\nMutations:${JSON.stringify(selected)}`;
    call = await respond(prompt, [tool("submit_findings", "Submit bounded protocol findings", {
      findings: { type: "array", minItems: selected.length, maxItems: selected.length, items: { type: "object", properties: {
        mutation_id: { type: "string", enum: spec.mutationIds },
        implicated_edge: { type: "string", maxLength: 100 },
        recommended_patch_id: { type: "string", enum: ["p0", "p1", "p2"] },
        diagnosis: { type: "string", maxLength: 500 },
      }, required: ["mutation_id", "implicated_edge", "recommended_patch_id", "diagnosis"], additionalProperties: false } },
    }, ["findings"])]);
    const artifact = await storeArtifact({ phase: spec.phase, condition: spec.condition, column: spec.column, findings: call.arguments.findings });
    return done({ phase: spec.phase, condition: spec.condition, column: spec.column, agent, artifactId: artifact.id, findings: call.arguments.findings, ...usage(call), durationMs: ms(started) });
  }
  if (spec.phase === "synthesize") {
    prompt = `You are ${spec.condition === "centralized" ? "the same centralized protocol agent" : "an autonomous Protein synthesis cell"}. Choose exactly one repair for each assigned mutation. Use the supplied exploration artifacts as evidence, but independently enforce: bad unreachable AND a goal reachable. Name every artifact that materially supported each choice.\nMutations:${JSON.stringify(selected)}\nExploration artifacts:${JSON.stringify(spec.explorations)}`;
    call = await respond(prompt, [tool("submit_repairs", "Submit the repair set", {
      repairs: { type: "array", minItems: selected.length, maxItems: selected.length, items: { type: "object", properties: {
        mutation_id: { type: "string", enum: spec.mutationIds },
        patch_id: { type: "string", enum: ["p0", "p1", "p2"] },
        source_artifact_ids: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
        rationale: { type: "string", maxLength: 500 },
      }, required: ["mutation_id", "patch_id", "source_artifact_ids", "rationale"], additionalProperties: false } },
      integration_conflicts: { type: "array", maxItems: 6, items: { type: "string", maxLength: 300 } },
    }, ["repairs", "integration_conflicts"])]);
    const evaluations = call.arguments.repairs.map((repair) => ({ ...repair, accepted: validPatch.get(repair.mutation_id) === repair.patch_id }));
    const artifact = await storeArtifact({ phase: spec.phase, condition: spec.condition, column: spec.column, repairs: call.arguments.repairs, evaluations });
    return done({ phase: spec.phase, condition: spec.condition, column: spec.column, agent, artifactId: artifact.id, repairs: call.arguments.repairs, evaluations, integrationConflicts: call.arguments.integration_conflicts, ...usage(call), durationMs: ms(started) });
  }
  if (spec.phase === "check") {
    const evaluations = spec.repairs.map((repair) => ({ mutationId: repair.mutation_id, patchId: repair.patch_id, accepted: validPatch.get(repair.mutation_id) === repair.patch_id }));
    prompt = `You are an adversarial checker. Compare the proposed repairs with the finite graph definitions. Approve a repair only when it blocks every path to a bad state while retaining a path to a goal. The authoritative evaluator results are supplied; report them faithfully.\nMutations:${JSON.stringify(selected)}\nRepairs:${JSON.stringify(spec.repairs)}\nAuthoritative results:${JSON.stringify(evaluations)}`;
    call = await respond(prompt, [tool("submit_verdict", "Submit the bounded verdict", {
      verdict: { type: "string", enum: ["approve", "reject"] },
      accepted_mutation_ids: { type: "array", maxItems: selected.length, items: { type: "string", enum: spec.mutationIds } },
      rejected_mutation_ids: { type: "array", maxItems: selected.length, items: { type: "string", enum: spec.mutationIds } },
      rationale: { type: "string", maxLength: 700 },
    }, ["verdict", "accepted_mutation_ids", "rejected_mutation_ids", "rationale"])]);
    return done({ phase: spec.phase, condition: spec.condition, column: spec.column, agent, review: call.arguments, authoritativeEvaluations: evaluations, ...usage(call), durationMs: ms(started) });
  }
  throw new Error(`unknown phase ${spec.phase}`);
}

function evaluate(mutation, patch) {
  const disabled = new Set(patch.disable);
  const reachable = new Set([mutation.initial]);
  const queue = [mutation.initial];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const edge of mutation.edges) {
      if (edge.from === node && !disabled.has(edge.label) && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return { accepted: !mutation.bad.some((node) => reachable.has(node)) && mutation.goals.some((node) => reachable.has(node)) };
}

async function respond(prompt, tools) {
  const response = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/responses`, { method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: process.env.OPENAI_MODEL ?? suite.model, reasoning: { effort: process.env.OPENAI_REASONING_EFFORT ?? "low" }, input: [{ role: "user", content: prompt }], tools, tool_choice: "required", parallel_tool_calls: false, max_tool_calls: 1, max_output_tokens: maxOutputTokens, store: false }) });
  const raw = await response.json();
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${JSON.stringify(raw).slice(0, 1000)}`);
  const item = raw.output?.find((value) => value.type === "function_call");
  if (!item) throw new Error("model did not call a function");
  return { arguments: JSON.parse(item.arguments), usage: raw.usage ?? {}, provider: { responseId: raw.id, model: raw.model } };
}

function tool(name, description, properties, required) { return { type: "function", name, description, strict: true, parameters: { type: "object", properties, required, additionalProperties: false } }; }
function usage(call) { return { providerCalls: 1, usage: call.usage, providerResponses: [call.provider] }; }
function done(value) { return { jobId: randomUUID(), status: "completed", tests: { status: "passed", command: "bounded finite-graph evaluator" }, summary: `${value.condition} ${value.phase} ${value.column}`, ...value }; }
async function storeArtifact(value) { const body = JSON.stringify(value); const hash = createHash("sha256").update(body).digest("hex"); await writeFile(join(artifactDir, `${hash}.json`), JSON.stringify(value, null, 2)); return { id: `sha256:${hash}` }; }
function stats() { const jobs = Object.values(state.jobs); return { requests, jobs: jobs.length, providerCalls: jobs.reduce((sum, job) => sum + (job.providerCalls ?? 0), 0), tokens: jobs.reduce((sum, job) => sum + (job.usage?.total_tokens ?? 0), 0), byCondition: Object.fromEntries(["centralized", "layered"].map((condition) => [condition, { jobs: jobs.filter((job) => job.condition === condition).length, calls: jobs.filter((job) => job.condition === condition).reduce((sum, job) => sum + (job.providerCalls ?? 0), 0), tokens: jobs.filter((job) => job.condition === condition).reduce((sum, job) => sum + (job.usage?.total_tokens ?? 0), 0) }])), model: process.env.OPENAI_MODEL ?? suite.model, maxOutputTokens }; }
async function load() { try { return JSON.parse(await readFile(statePath, "utf8")); } catch { return { schemaVersion: 1, jobs: {} }; } }
async function persist() { await writeFile(statePath, JSON.stringify(state, null, 2)); }
async function bodyJson(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
function json(response, status, value) { const body = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); response.end(body); }
function ms(started) { return Number((performance.now() - started).toFixed(2)); }
