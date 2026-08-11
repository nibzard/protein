import { createServer } from "node:http";

const port = Number(process.env.MOCK_EXECUTOR_PORT ?? 19100);
const delayMs = Number(process.env.MOCK_EXECUTOR_DELAY_MS ?? 0);
const jobs = new Map();
let requests = 0;

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/stats") {
    return json(response, 200, { requests, jobs: jobs.size });
  }

  if (request.method !== "POST" || request.url !== "/jobs") {
    return json(response, 404, { error: "not_found" });
  }

  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || key.length === 0) {
    return json(response, 400, { error: "missing_idempotency_key" });
  }

  requests += 1;
  const previous = jobs.get(key);
  if (previous !== undefined) {
    return json(response, 200, previous);
  }

  const body = await readJson(request);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const result = {
    jobId: key,
    status: "completed",
    repository: body.repository ?? null,
    summary: `Executor completed: ${String(body.task ?? "unknown task")}`,
    tests: { status: "passed", command: "mock" },
  };
  jobs.set(key, result);
  return json(response, 200, result);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock executor listening on http://127.0.0.1:${port}`);
});

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? {} : JSON.parse(text);
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
