import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const celldBin = process.env.CELLD_BIN ?? "celld";
const runId = `${process.pid}-${Date.now()}`;
const minioName = `protein-celld-e2e-${process.pid}`;
const bucket = `protein-e2e-${process.pid}`;
const minioPort = Number(process.env.PROTEIN_MINIO_PORT ?? 19010);
const nodePort = Number(process.env.PROTEIN_CELLD_PORT ?? 18090);
const executorPort = Number(process.env.PROTEIN_EXECUTOR_PORT ?? 19110);
const fleetSize = Number(process.env.PROTEIN_FLEET_SIZE ?? 100);
const endpoint = `http://127.0.0.1:${minioPort}`;
const baseUrl = `http://127.0.0.1:${nodePort}`;
const credentials = {
  AWS_ACCESS_KEY_ID: "protein-e2e",
  AWS_SECRET_ACCESS_KEY: "protein-e2e-secret",
  AWS_REGION: "us-east-1",
};

let celldProcess;
let executorProcess;
let minioStarted = false;
const temporaryDirectories = [];
let celldLog = "";
let probeRecoveryMs = 0;
let repoRecoveryMs = 0;
let peakCelldRssKb = 0;
let rssTimer;
let signalCleanupStarted = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (signalCleanupStarted) return;
    signalCleanupStarted = true;
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

try {
  requireCommand(celldBin, ["--version"]);
  requireCommand("docker", ["version", "--format", "{{.Server.Version}}"]);

  run("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    minioName,
    "-p",
    `127.0.0.1:${minioPort}:9000`,
    "-e",
    `MINIO_ROOT_USER=${credentials.AWS_ACCESS_KEY_ID}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${credentials.AWS_SECRET_ACCESS_KEY}`,
    "minio/minio:latest",
    "server",
    "/data",
  ]);
  minioStarted = true;
  await waitForHttp(endpoint, { acceptedStatuses: [403] });
  run("docker", [
    "run",
    "--rm",
    "--network",
    "host",
    "-e",
    `MC_HOST_local=http://${credentials.AWS_ACCESS_KEY_ID}:${credentials.AWS_SECRET_ACCESS_KEY}@127.0.0.1:${minioPort}`,
    "minio/mc:latest",
    "mb",
    "--ignore-existing",
    `local/${bucket}`,
  ]);

  run("npm", ["run", "probe:build"]);
  deploy("probes/cloudflare-agents");
  await startCelld();

  const probeName = `probe-${runId}`;
  const probeRoot = `/?name=${encodeURIComponent(probeName)}`;
  assertEqual((await getJson(probeRoot)).count, 0, "probe initial state");
  assertEqual(
    (await getJson(`/increment?name=${encodeURIComponent(probeName)}`)).count,
    1,
    "probe state update",
  );
  await getJson(`/schedule?name=${encodeURIComponent(probeName)}`);
  const scheduled = await pollJson(probeRoot, (value) => value.count === 3);
  assertEqual(scheduled.scheduledCount, 1, "probe durable schedule");
  await verifyWebSocket(`ws://127.0.0.1:${nodePort}/?name=${probeName}`);

  await stopCelld();
  let recoveryStartedAt = performance.now();
  await startCelld();
  assertEqual(
    (await pollJson(probeRoot, (value) => value.count === 3)).count,
    3,
    "probe restart recovery",
  );
  probeRecoveryMs = Math.round(performance.now() - recoveryStartedAt);
  await stopCelld();

  run("npm", ["run", "example:build"]);
  deploy("examples/repo-agent");
  executorProcess = spawn(
    process.execPath,
    [join(root, "scripts/mock-executor.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        MOCK_EXECUTOR_PORT: String(executorPort),
        MOCK_EXECUTOR_DELAY_MS: "1500",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForHttp(`http://127.0.0.1:${executorPort}/stats`);
  await startCelld({
    CELLD_VAR_EXECUTOR_URL: `http://127.0.0.1:${executorPort}`,
    CELLD_VAR_PROTEIN_LEASE_MS: "3000",
  });

  const agentName = `repo-${runId}`;
  const agentBase = `/agents/${agentName}`;
  const runPath = `${agentBase}/runs/run-1`;
  const goal = {
    id: "run-1",
    goal: { repository: "acme/api", task: "repair the build" },
  };
  await postJson(`${agentBase}/runs`, goal, 202);
  const completed = await pollJson(
    runPath,
    (value) => value.status === "completed",
  );
  assertEqual(completed.result.tests.status, "passed", "repo executor result");
  await postJson(`${agentBase}/runs`, goal, 202);
  await postJson(
    `${agentBase}/runs`,
    { ...goal, goal: { ...goal.goal, task: "conflicting task" } },
    409,
  );
  const stats = await getAbsoluteJson(
    `http://127.0.0.1:${executorPort}/stats`,
  );
  assertEqual(stats.requests, 1, "executor logical delivery count");
  assertEqual(stats.jobs, 1, "executor idempotency count");

  await verifyProteinWebSocket(
    `ws://127.0.0.1:${nodePort}/agents/${agentName}/state`,
    agentName,
  );

  const recoveryGoal = {
    id: "run-recovery",
    goal: { repository: "acme/api", task: "survive executor interruption" },
  };
  await postJson(`${agentBase}/runs`, recoveryGoal, 202);
  await pollAbsoluteJson(
    `http://127.0.0.1:${executorPort}/stats`,
    (value) => value.requests >= 2,
  );

  await stopCelld();
  recoveryStartedAt = performance.now();
  await startCelld({
    CELLD_VAR_EXECUTOR_URL: `http://127.0.0.1:${executorPort}`,
    CELLD_VAR_PROTEIN_LEASE_MS: "3000",
  });
  assertEqual(
    (await pollJson(runPath, (value) => value.status === "completed")).status,
    "completed",
    "repo restart recovery",
  );
  assertEqual(
    (
      await pollJson(
        `${agentBase}/runs/run-recovery`,
        (value) => value.status === "completed",
      )
    ).status,
    "completed",
    "in-flight action recovery",
  );
  repoRecoveryMs = Math.round(performance.now() - recoveryStartedAt);
  const recoveredStats = await getAbsoluteJson(
    `http://127.0.0.1:${executorPort}/stats`,
  );
  assertEqual(recoveredStats.jobs, 2, "recovered executor job count");
  if (recoveredStats.requests < 3) {
    throw new Error("Interrupted action did not exercise idempotent redelivery");
  }

  const fleetStartedAt = performance.now();
  const fleetResults = await mapConcurrent(
    Array.from({ length: fleetSize }, (_, index) => index),
    32,
    async (index) => {
      const name = `fleet-${runId}-${String(index).padStart(5, "0")}`;
      const response = await getJson(`/agents/${name}/state`);
      return response.agent === name;
    },
  );
  const fleetMs = Math.round(performance.now() - fleetStartedAt);
  const fleetSucceeded = fleetResults.filter(Boolean).length;
  assertEqual(fleetSucceeded, fleetSize, "fleet activations");

  console.log(
    JSON.stringify(
      {
        celld: commandOutput(celldBin, ["--version"]).trim(),
        agentsPackage: "0.20.1",
        probe: {
          state: "passed",
          schedule: "passed",
          websocket: "passed",
          restart: "passed",
          recoveryMs: probeRecoveryMs,
        },
        repoAgent: {
          eventDeduplication: "passed",
          conflictDetection: "passed",
          externalAction: "passed",
          websocket: "passed",
          inFlightActionRecovery: "passed",
          restart: "passed",
          recoveryMs: repoRecoveryMs,
        },
        fleet: { requested: fleetSize, succeeded: fleetSucceeded, elapsedMs: fleetMs },
        peakCelldRssMb: Math.round(peakCelldRssKb / 1024),
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (celldLog.length > 0) {
    console.error("\nLast celld output:\n", celldLog.slice(-20_000));
  }
  throw error;
} finally {
  await cleanup();
}

async function cleanup() {
  await stopCelld();
  await stopChild(executorProcess);
  executorProcess = undefined;
  if (minioStarted) {
    minioStarted = false;
    spawnSync("docker", ["stop", minioName], { stdio: "ignore" });
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
}

function deploy(project) {
  run(
    celldBin,
    [
      "deploy",
      project,
      "--bucket",
      `s3://${bucket}`,
      "--endpoint",
      endpoint,
      "--region",
      "us-east-1",
    ],
    {
      ...credentials,
      CELLD_ESBUILD: join(root, "node_modules/.bin/esbuild"),
    },
  );
}

async function startCelld(extraEnvironment = {}) {
  const watch = await mkdtemp(join(tmpdir(), "protein-celld-e2e-"));
  temporaryDirectories.push(watch);
  celldLog = "";
  celldProcess = spawn(
    celldBin,
    [
      "--bucket",
      `s3://${bucket}`,
      "--endpoint",
      endpoint,
      "--region",
      "us-east-1",
      "--listen",
      `127.0.0.1:${nodePort}`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        ...credentials,
        ...extraEnvironment,
        CELLD_WATCH: watch,
        CELLD_FETCH_TIMEOUT_S: "10",
        CELLD_TTL_MS: "2000",
        RUST_LOG: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  celldProcess.stdout.on("data", (chunk) => (celldLog += chunk.toString()));
  celldProcess.stderr.on("data", (chunk) => (celldLog += chunk.toString()));
  rssTimer = setInterval(() => sampleRss(celldProcess?.pid), 100);
  await waitForHttp(baseUrl, { acceptedStatuses: [200, 404] });
}

async function stopCelld() {
  const processToStop = celldProcess;
  celldProcess = undefined;
  clearInterval(rssTimer);
  rssTimer = undefined;
  await stopChild(processToStop);
}

async function stopChild(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGINT");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function run(command, args, environment = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...environment },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function requireCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} is required for the celld integration test`);
  }
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

async function waitForHttp(url, options = {}) {
  const statuses = options.acceptedStatuses ?? [200];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (statuses.includes(response.status)) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function getJson(path) {
  return getAbsoluteJson(`${baseUrl}${path}`);
}

async function getAbsoluteJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function postJson(path, body, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== expectedStatus) {
    throw new Error(
      `POST ${path} returned ${response.status}, expected ${expectedStatus}: ${await response.text()}`,
    );
  }
  return response.json();
}

async function pollJson(path, predicate) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const value = await getJson(path);
      if (predicate(value)) return value;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out polling ${path}`);
}

async function pollAbsoluteJson(url, predicate) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const value = await getAbsoluteJson(url);
      if (predicate(value)) return value;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out polling ${url}`);
}

async function verifyWebSocket(url) {
  const messages = [];
  await new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      rejectSocket(new Error("WebSocket probe timed out"));
    }, 5_000);
    socket.onmessage = (event) => {
      const message = String(event.data);
      messages.push(message);
      if (message.includes('"type":"connected"')) socket.send("ping");
      if (message.includes('"type":"echo"')) {
        clearTimeout(timeout);
        socket.close();
      }
    };
    socket.onerror = () => rejectSocket(new Error("WebSocket probe failed"));
    socket.onclose = () => resolveSocket();
  });
  if (!messages.some((message) => message.includes("cf_agent_identity"))) {
    throw new Error("WebSocket identity frame was not received");
  }
  if (!messages.some((message) => message.includes('"type":"echo"'))) {
    throw new Error("WebSocket echo frame was not received");
  }
}

async function verifyProteinWebSocket(url, agentName) {
  const message = await new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      rejectSocket(new Error("Protein WebSocket probe timed out"));
    }, 5_000);
    socket.onmessage = (event) => {
      clearTimeout(timeout);
      const data = String(event.data);
      socket.close();
      resolveSocket(data);
    };
    socket.onerror = () => rejectSocket(new Error("Protein WebSocket failed"));
  });
  const parsed = JSON.parse(message);
  assertEqual(parsed.type, "protein.connected", "Protein WebSocket frame");
  assertEqual(parsed.agent, agentName, "Protein WebSocket identity");
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(values[index]);
      }
    }),
  );
  return results;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function sampleRss(pid) {
  if (pid === undefined) return;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (match?.[1] !== undefined) {
      peakCelldRssKb = Math.max(peakCelldRssKb, Number(match[1]));
    }
  } catch {}
}
