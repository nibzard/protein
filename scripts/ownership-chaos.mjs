import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import {
  deploy,
  getJson,
  pollJson,
  postJson,
  requireCommand,
  root,
  run,
  sleep,
  startCelld,
  startMinio,
  stopChild,
  stopMinio,
  waitForHttp,
} from "./celld-proof-support.mjs";

const celldBin = process.env.CELLD_BIN ?? "celld";
const suffix = `${process.pid}-${Date.now()}`;
const minioName = `protein-ownership-${process.pid}`;
const bucket = `protein-ownership-${process.pid}`;
const minioPort = Number(process.env.PROTEIN_OWNERSHIP_MINIO_PORT ?? 19040);
const nodeAPort = Number(process.env.PROTEIN_OWNERSHIP_NODE_A_PORT ?? 18040);
const nodeBPort = Number(process.env.PROTEIN_OWNERSHIP_NODE_B_PORT ?? 18041);
const proxyAPort = Number(process.env.PROTEIN_OWNERSHIP_PROXY_A_PORT ?? 18140);
const proxyBPort = Number(process.env.PROTEIN_OWNERSHIP_PROXY_B_PORT ?? 18141);
const storeAPort = Number(process.env.PROTEIN_OWNERSHIP_STORE_A_PORT ?? 18940);
const storeBPort = Number(process.env.PROTEIN_OWNERSHIP_STORE_B_PORT ?? 18941);
const proofPort = Number(process.env.PROTEIN_OWNERSHIP_PROOF_PORT ?? 19240);
const endpoint = `http://127.0.0.1:${minioPort}`;
const proofUrl = `http://127.0.0.1:${proofPort}`;
const nodeAUrl = `http://127.0.0.1:${nodeAPort}`;
const nodeBUrl = `http://127.0.0.1:${nodeBPort}`;
const credentials = {
  AWS_ACCESS_KEY_ID: "protein-ownership",
  AWS_SECRET_ACCESS_KEY: "protein-ownership-secret",
  AWS_REGION: "us-east-1",
};
const ttlMs = 12_000;
const clockOffsetMs = 9_000;
const clockShim = `/tmp/protein-clock-offset-${process.pid}.so`;
const agent = `ownership-${suffix}`;
const agentPath = `/agents/${encodeURIComponent(agent)}`;
const identityPath = `${agentPath}/identity`;
const runId = `split-${suffix}`;
const actionId = `run:${runId}:execute`;
const results = [];

let minioStarted = false;
let controller;
let nodeA;
let nodeB;
let proxyA;
let proxyB;
let storeA;
let storeB;
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
  requireCommand("gcc", ["--version"]);
  run("gcc", ["-shared", "-fPIC", "-O2", "-o", clockShim, "scripts/clock-offset.c", "-ldl"]);

  await startMinio({ name: minioName, port: minioPort, bucket, credentials });
  minioStarted = true;
  run("npm", ["run", "example:build"]);
  deploy({ celldBin, project: "examples/repo-agent", bucket, endpoint, credentials });

  controller = spawn(process.execPath, ["scripts/proof-controller.mjs"], {
    cwd: root,
    env: { ...process.env, PROTEIN_PROOF_PORT: String(proofPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHttp(`${proofUrl}/health`);

  proxyA = await startProxy(proxyAPort, nodeAPort);
  proxyB = await startProxy(proxyBPort, nodeBPort);
  storeA = await startProxy(storeAPort, minioPort);
  storeB = await startProxy(storeBPort, minioPort);
  nodeA = await startNode("A", nodeAPort, proxyAPort, storeAPort);

  const initial = await pollIdentity(nodeAUrl, "A");
  nodeB = await startNode("B", nodeBPort, proxyBPort, storeBPort);
  const forwarded = await pollIdentity(nodeBUrl, "A");
  results.push({
    invariant: "healthy routing uses the elected owner",
    status: initial.node === "A" && forwarded.node === "A" ? "passed" : "failed",
    observations: { directA: initial.node, viaB: forwarded.node },
  });

  proxyA.disable();
  const partitionResult = await identityWithTimeout(nodeBUrl, 800);
  results.push({
    invariant: "partition alone does not immediately create a second owner",
    status:
      partitionResult.kind !== "response" || partitionResult.value.node !== "B"
        ? "passed"
        : "failed",
    observations: partitionResult,
  });
  proxyA.enable();
  await pollIdentity(nodeBUrl, "A");

  await nodeB.cleanup();
  nodeB = await startNode("B", nodeBPort, proxyBPort, storeBPort, clockOffsetMs);
  proxyA.disable();
  proxyB.disable();
  storeA.disable();

  // Do not touch B until A's last published lease is expired in B's shifted
  // wall-clock view. A first request made earlier would legitimately cache A
  // as the remote owner for that cell.
  await sleep(3_500);
  const skewedB = await pollIdentity(nodeBUrl, "B", 160);
  const staleA = await pollIdentity(nodeAUrl, "A", 40);
  const dualAuthority = skewedB.node === "B" && staleA.node === "A";
  results.push({
    invariant: "one active owner under partition plus bounded wall-clock skew",
    status: dualAuthority ? "failed" : "passed",
    observations: {
      nodeAClaims: staleA.node,
      nodeBClaims: skewedB.node,
      ttlMs,
      clockOffsetMs,
    },
    finding: dualAuthority
      ? "Both isolated nodes served the same durable object locally."
      : null,
  });

  await postJson(`${proofUrl}/control/arm`, {
    checkpoint: "action.dispatch_started",
    match: { actionId },
    expectedHits: 2,
  });
  const goal = {
    id: runId,
    goal: {
      repository: "acme/protein-proof",
      task: "prove split-brain dispatch containment",
      safety: "idempotent",
    },
  };
  const starts = await Promise.allSettled([
    postJson(`${nodeAUrl}${agentPath}/runs`, goal, 202),
    postJson(`${nodeBUrl}${agentPath}/runs`, goal, 202),
  ]);
  const gate = await pollJson(
    `${proofUrl}/control/status`,
    (status) => status.gate?.reached === true,
    { attempts: 300 },
  );
  const dispatchNodes = [
    ...new Set(gate.gate.hits.map((hit) => hit.details.node).filter(Boolean)),
  ].sort();
  await postJson(`${proofUrl}/control/release`, {});
  const stats = await pollJson(
    `${proofUrl}/stats?key=${encodeURIComponent(actionId)}`,
    (value) => value.requests >= 2,
    { attempts: 300 },
  );
  const containmentPassed =
    dispatchNodes.includes("A") &&
    dispatchNodes.includes("B") &&
    stats.requests >= 2 &&
    stats.creates === 1 &&
    stats.origins.includes("A") &&
    stats.origins.includes("B");
  results.push({
    invariant: "idempotency contains duplicate effects during dual dispatch",
    status: containmentPassed ? "passed" : "failed",
    observations: {
      startRequests: starts.map((entry) => entry.status),
      dispatchNodes,
      executorRequests: stats.requests,
      logicalJobs: stats.creates,
      origins: stats.origins,
    },
  });

  await nodeA.cleanup();
  nodeA = undefined;
  await nodeB.cleanup();
  nodeB = undefined;
  proxyA.enable();
  proxyB.enable();
  storeA.enable();
  nodeB = await startNode("B", nodeBPort, proxyBPort, storeBPort);
  const finalRun = await pollJson(
    `${nodeBUrl}${agentPath}/runs/${encodeURIComponent(runId)}`,
    (record) => record.status === "completed" || record.status === "failed",
    { attempts: 600 },
  );
  results.push({
    invariant: "a fresh owner converges to one terminal run",
    status: finalRun.status === "completed" ? "passed" : "failed",
    observations: { runStatus: finalRun.status },
  });

  const failed = results.filter((result) => result.status === "failed");
  console.log(
    JSON.stringify(
      {
        celld: run(celldBin, ["--version"]).trim(),
        topology: {
          nodes: 2,
          ttlMs,
          skewedNode: "B",
          wallClockOffsetMs: clockOffsetMs,
          peerPartition: true,
          staleOwnerStorePartition: true,
        },
        results,
        summary: {
          passed: results.length - failed.length,
          failed: failed.length,
          total: results.length,
        },
      },
      null,
      2,
    ),
  );
  if (failed.length > 0 && process.env.PROTEIN_PROOF_ALLOW_FAILURES !== "1") {
    process.exitCode = 1;
  }
} catch (error) {
  if (nodeA !== undefined) console.error("\nNode A output:\n", nodeA.output().slice(-20_000));
  if (nodeB !== undefined) console.error("\nNode B output:\n", nodeB.output().slice(-20_000));
  throw error;
} finally {
  await cleanup();
}

async function startNode(label, port, advertisePort, storePort, offsetMs = 0) {
  return startCelld({
    celldBin,
    bucket,
    endpoint: `http://127.0.0.1:${storePort}`,
    credentials,
    port,
    advertise: `127.0.0.1:${advertisePort}`,
    node: `protein-node-${label.toLowerCase()}`,
    ttlMs,
    variables: {
      EXECUTOR_URL: proofUrl,
      PROTEIN_CHECKPOINT_URL: proofUrl,
      PROTEIN_LEASE_MS: 1_000,
      PROTEIN_NODE_ID: label,
    },
    environment:
      offsetMs === 0
        ? {}
        : {
            LD_PRELOAD: clockShim,
            PROTEIN_CLOCK_OFFSET_MS: String(offsetMs),
          },
  });
}

async function pollIdentity(baseUrl, expectedNode, attempts = 120) {
  return pollJson(
    `${baseUrl}${identityPath}`,
    (value) => value.node === expectedNode,
    { attempts, delayMs: 100 },
  );
}

async function identityWithTimeout(baseUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${identityPath}`, {
      signal: controller.signal,
    });
    const body = await response.text();
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      value = { body: body.slice(0, 500) };
    }
    return { kind: "response", status: response.status, value };
  } catch (error) {
    return {
      kind: error instanceof Error && error.name === "AbortError" ? "timeout" : "error",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function startProxy(listenPort, targetPort) {
  let enabled = true;
  const sockets = new Set();
  const server = createServer((incoming) => {
    if (!enabled) return incoming.destroy();
    const outgoing = connect(targetPort, "127.0.0.1");
    sockets.add(incoming);
    sockets.add(outgoing);
    incoming.pipe(outgoing).pipe(incoming);
    const close = () => {
      sockets.delete(incoming);
      sockets.delete(outgoing);
      incoming.destroy();
      outgoing.destroy();
    };
    incoming.once("error", close);
    outgoing.once("error", close);
    incoming.once("close", close);
    outgoing.once("close", close);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", resolveListen);
  });
  return {
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
      for (const socket of [...sockets]) socket.destroy();
      sockets.clear();
    },
    async close() {
      for (const socket of [...sockets]) socket.destroy();
      sockets.clear();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

async function cleanup() {
  if (nodeA !== undefined) await nodeA.cleanup();
  nodeA = undefined;
  if (nodeB !== undefined) await nodeB.cleanup();
  nodeB = undefined;
  if (proxyA !== undefined) await proxyA.close();
  proxyA = undefined;
  if (proxyB !== undefined) await proxyB.close();
  proxyB = undefined;
  if (storeA !== undefined) await storeA.close();
  storeA = undefined;
  if (storeB !== undefined) await storeB.close();
  storeB = undefined;
  await stopChild(controller);
  controller = undefined;
  if (minioStarted) {
    minioStarted = false;
    stopMinio(minioName);
  }
  await rm(clockShim, { force: true });
  await sleep(10);
}
