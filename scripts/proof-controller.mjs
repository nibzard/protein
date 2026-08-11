import { createServer } from "node:http";

const port = Number(process.env.PROTEIN_PROOF_PORT ?? 19200);
const defaultDelayMs = Number(process.env.PROTEIN_PROOF_EXECUTOR_DELAY_MS ?? 0);
const jobs = new Map();
const keyStats = new Map();
const checkpointEvents = [];
let activeGate = null;
let requestSequence = 0;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      const key = url.searchParams.get("key");
      return json(response, 200, stats(key));
    }

    if (request.method === "GET" && url.pathname === "/control/status") {
      return json(response, 200, {
        gate: serializableGate(activeGate),
        events: checkpointEvents.slice(-100),
      });
    }

    if (request.method === "POST" && url.pathname === "/control/arm") {
      if (activeGate !== null) {
        return json(response, 409, { error: "gate_already_armed" });
      }
      const body = await readJson(request);
      if (typeof body.checkpoint !== "string" || body.checkpoint.length === 0) {
        return json(response, 400, { error: "checkpoint_required" });
      }
      activeGate = {
        checkpoint: body.checkpoint,
        match: objectOrEmpty(body.match),
        expectedHits: positiveInteger(body.expectedHits, 1),
        hits: [],
        waiters: [],
        armedAt: Date.now(),
      };
      return json(response, 200, { gate: serializableGate(activeGate) });
    }

    if (request.method === "POST" && url.pathname === "/control/release") {
      if (activeGate === null) {
        return json(response, 200, { released: false, hits: 0 });
      }
      const gate = activeGate;
      activeGate = null;
      for (const resolve of gate.waiters.splice(0)) resolve();
      return json(response, 200, { released: true, hits: gate.hits.length });
    }

    if (request.method === "POST" && url.pathname === "/control/reset") {
      if (activeGate !== null) {
        return json(response, 409, { error: "release_gate_before_reset" });
      }
      jobs.clear();
      keyStats.clear();
      checkpointEvents.length = 0;
      requestSequence = 0;
      return json(response, 200, { reset: true });
    }

    if (request.method === "POST" && url.pathname === "/checkpoints") {
      const body = await readJson(request);
      if (typeof body.checkpoint !== "string") {
        return json(response, 400, { error: "checkpoint_required" });
      }
      const details = {
        ...objectOrEmpty(body.context),
        agent: typeof body.agent === "string" ? body.agent : null,
        node: typeof body.node === "string" ? body.node : null,
      };
      await checkpoint(body.checkpoint, details);
      return json(response, 200, { continue: true });
    }

    const lookup = /^\/jobs\/(.+)$/.exec(url.pathname);
    if (request.method === "GET" && lookup?.[1] !== undefined) {
      const key = decodeURIComponent(lookup[1]);
      const entry = statsForKey(key);
      entry.lookups += 1;
      entry.origins.add(header(request, "x-protein-node") ?? "unknown");
      const job = jobs.get(key);
      return job === undefined
        ? json(response, 404, { error: "job_not_found" })
        : json(response, 200, job);
    }

    if (request.method === "POST" && url.pathname === "/jobs") {
      return handleJob(request, response);
    }

    return json(response, 404, { error: "not_found" });
  } catch (error) {
    return json(response, 500, {
      error: "proof_controller_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`protein proof controller listening on http://127.0.0.1:${port}`);
});

async function handleJob(request, response) {
  const key = header(request, "idempotency-key");
  if (key === undefined || key.length === 0) {
    return json(response, 400, { error: "missing_idempotency_key" });
  }

  const entry = statsForKey(key);
  entry.requests += 1;
  const requestId = ++requestSequence;
  const origin = header(request, "x-protein-node") ?? "unknown";
  entry.origins.add(origin);
  const baseDetails = { actionId: key, requestId, node: origin };

  await checkpoint("executor.request_received", baseDetails);
  if (request.aborted || response.destroyed) return;

  const body = await readJson(request);
  let result = jobs.get(key);
  if (result === undefined) {
    result = {
      jobId: key,
      status: "completed",
      repository: body.repository ?? null,
      summary: `Executor completed: ${String(body.task ?? "unknown task")}`,
      tests: { status: "passed", command: "proof-controller" },
    };
    jobs.set(key, result);
    entry.creates += 1;
  } else {
    entry.duplicates += 1;
  }

  await checkpoint("executor.accepted", {
    ...baseDetails,
    created: entry.creates === 1 && entry.requests === 1,
  });
  if (request.aborted || response.destroyed) return;

  if (defaultDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, defaultDelayMs));
  }
  return json(response, 200, result);
}

async function checkpoint(name, details) {
  const event = { name, details, at: Date.now() };
  checkpointEvents.push(event);
  if (checkpointEvents.length > 1_000) checkpointEvents.shift();

  const gate = activeGate;
  if (
    gate === null ||
    gate.checkpoint !== name ||
    !matches(details, gate.match)
  ) {
    return;
  }
  gate.hits.push(event);
  await new Promise((resolve) => gate.waiters.push(resolve));
}

function matches(details, expected) {
  return Object.entries(expected).every(([key, value]) => details[key] === value);
}

function stats(key) {
  if (key !== null) {
    const entry = statsForKey(key);
    return {
      key,
      requests: entry.requests,
      creates: entry.creates,
      duplicates: entry.duplicates,
      lookups: entry.lookups,
      origins: [...entry.origins].sort(),
      job: jobs.get(key) ?? null,
    };
  }
  return {
    requests: [...keyStats.values()].reduce((sum, entry) => sum + entry.requests, 0),
    jobs: jobs.size,
    lookups: [...keyStats.values()].reduce((sum, entry) => sum + entry.lookups, 0),
    keys: [...keyStats.keys()].sort(),
  };
}

function statsForKey(key) {
  let entry = keyStats.get(key);
  if (entry === undefined) {
    entry = { requests: 0, creates: 0, duplicates: 0, lookups: 0, origins: new Set() };
    keyStats.set(key, entry);
  }
  return entry;
}

function serializableGate(gate) {
  return gate === null
    ? null
    : {
        checkpoint: gate.checkpoint,
        match: gate.match,
        expectedHits: gate.expectedHits,
        hits: gate.hits,
        reached: gate.hits.length >= gate.expectedHits,
        armedAt: gate.armedAt,
      };
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function objectOrEmpty(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function header(request, name) {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? {} : JSON.parse(text);
}

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
