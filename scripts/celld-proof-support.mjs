import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");

export function requireCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} is required for the celld proof suite`);
  }
}

export function run(command, args, environment = {}) {
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

export async function startMinio({ name, port, bucket, credentials }) {
  run("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "-p",
    `127.0.0.1:${port}:9000`,
    "-e",
    `MINIO_ROOT_USER=${credentials.AWS_ACCESS_KEY_ID}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${credentials.AWS_SECRET_ACCESS_KEY}`,
    "--tmpfs",
    "/data:rw,size=256m",
    "minio/minio:latest",
    "server",
    "/data",
  ]);
  await waitForHttp(`http://127.0.0.1:${port}`, { acceptedStatuses: [403] });
  run("docker", [
    "run",
    "--rm",
    "--network",
    "host",
    "-e",
    `MC_HOST_local=http://${credentials.AWS_ACCESS_KEY_ID}:${credentials.AWS_SECRET_ACCESS_KEY}@127.0.0.1:${port}`,
    "minio/mc:latest",
    "mb",
    "--ignore-existing",
    `local/${bucket}`,
  ]);
}

export function stopMinio(name) {
  spawnSync("docker", ["stop", name], { stdio: "ignore" });
}

export function deploy({ celldBin, project, bucket, endpoint, credentials }) {
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

export async function startCelld({
  celldBin,
  bucket,
  endpoint,
  credentials,
  port,
  advertise,
  node,
  ttlMs,
  fetchTimeoutSeconds = 10,
  handlerBudgetSeconds = 30,
  variables = {},
  environment = {},
}) {
  const watch = await mkdtemp(join(tmpdir(), "protein-proof-celld-"));
  const args = [
    "--bucket",
    `s3://${bucket}`,
    "--endpoint",
    endpoint,
    "--region",
    "us-east-1",
    "--listen",
    `127.0.0.1:${port}`,
  ];
  if (advertise !== undefined) args.push("--advertise", advertise);
  let output = "";
  const child = spawn(celldBin, args, {
    cwd: root,
    env: {
      ...process.env,
      ...credentials,
      ...environment,
      ...Object.fromEntries(
        Object.entries(variables).map(([key, value]) => [
          `CELLD_VAR_${key}`,
          String(value),
        ]),
      ),
      ...(node === undefined ? {} : { CELLD_NODE: node }),
      CELLD_WATCH: watch,
      CELLD_FETCH_TIMEOUT_S: String(fetchTimeoutSeconds),
      CELLD_HANDLER_BUDGET_S: String(handlerBudgetSeconds),
      CELLD_TTL_MS: String(ttlMs),
      RUST_LOG: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  await waitForHttp(`http://127.0.0.1:${port}`, {
    acceptedStatuses: [200, 404],
    attempts: 200,
  });
  return {
    child,
    watch,
    output: () => output,
    async cleanup() {
      await stopChild(child);
      await rm(watch, { recursive: true, force: true });
    },
  };
}

export async function stopChild(child, signal = "SIGINT") {
  if (child === undefined || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill(signal);
  const graceful = await Promise.race([
    exited.then(() => true),
    sleep(2_000).then(() => false),
  ]);
  if (!graceful && child.exitCode === null) child.kill("SIGKILL");
  if (child.exitCode === null) {
    await Promise.race([exited, sleep(2_000)]);
  }
}

export async function hardKill(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

export async function waitForHttp(url, options = {}) {
  const statuses = options.acceptedStatuses ?? [200];
  const attempts = options.attempts ?? 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (statuses.includes(response.status)) return;
    } catch {}
    await sleep(options.delayMs ?? 100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

export async function postJson(url, body, expectedStatus = 200) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== expectedStatus) {
    throw new Error(
      `POST ${url} returned ${response.status}, expected ${expectedStatus}: ${await response.text()}`,
    );
  }
  return response.json();
}

export async function pollJson(url, predicate, options = {}) {
  const attempts = options.attempts ?? 400;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await getJson(url);
      if (predicate(value)) return value;
    } catch {}
    await sleep(options.delayMs ?? 100);
  }
  throw new Error(`Timed out polling ${url}`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
