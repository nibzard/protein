import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertEqual,
  deploy,
  getJson,
  hardKill,
  pollJson,
  postJson,
  requireCommand,
  root,
  run,
  startCelld,
  startMinio,
  stopChild,
  stopMinio,
  waitForHttp,
} from "./celld-proof-support.mjs";
import { checkRuntimeConformance } from "../examples/formal-protocol-swarm/runtime-conformance.mjs";

const celldBin = process.env.CELLD_BIN ?? "celld";
const suffix = `${process.pid}-${Date.now()}`;
const minioName = `protein-crash-matrix-${process.pid}`;
const bucket = `protein-crash-${process.pid}`;
const minioPort = Number(process.env.PROTEIN_CRASH_MINIO_PORT ?? 19030);
const celldPort = Number(process.env.PROTEIN_CRASH_CELLD_PORT ?? 18030);
const proofPort = Number(process.env.PROTEIN_CRASH_PROOF_PORT ?? 19230);
const endpoint = `http://127.0.0.1:${minioPort}`;
const baseUrl = `http://127.0.0.1:${celldPort}`;
const proofUrl = `http://127.0.0.1:${proofPort}`;
const credentials = {
  AWS_ACCESS_KEY_ID: "protein-crash",
  AWS_SECRET_ACCESS_KEY: "protein-crash-secret",
  AWS_REGION: "us-east-1",
};
const actionLeaseMs = 1_000;
const results = [];

let minioStarted = false;
let controller;
let celld;
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
  await startMinio({
    name: minioName,
    port: minioPort,
    bucket,
    credentials,
  });
  minioStarted = true;

  run("npm", ["run", "example:build"]);
  deploy({
    celldBin,
    project: "examples/repo-agent",
    bucket,
    endpoint,
    credentials,
  });

  controller = spawn(process.execPath, ["scripts/proof-controller.mjs"], {
    cwd: root,
    env: { ...process.env, PROTEIN_PROOF_PORT: String(proofPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHttp(`${proofUrl}/health`);
  celld = await startNode();

  const idempotentMatrix = [
    { checkpoint: "event.before_commit", minRequests: 1, maxRequests: 1 },
    { checkpoint: "event.committed", minRequests: 1, maxRequests: 1 },
    { checkpoint: "action.claimed", minRequests: 1, maxRequests: 1 },
    { checkpoint: "action.dispatch_started", minRequests: 1, maxRequests: 1 },
    { checkpoint: "executor.request_received", minRequests: 2 },
    { checkpoint: "executor.accepted", minRequests: 2 },
    { checkpoint: "action.response_received", minRequests: 2 },
    { checkpoint: "action.committed", minRequests: 2 },
  ];

  for (const scenario of idempotentMatrix) {
    results.push(
      await crashScenario({
        ...scenario,
        safety: "idempotent",
        expectedRunStatus: "completed",
        expectedActionStatus: "delivered",
        expectedJobs: 1,
      }),
    );
  }

  results.push(
    await crashScenario({
      checkpoint: "executor.accepted",
      safety: "reconcilable",
      expectedRunStatus: "completed",
      expectedActionStatus: "delivered",
      expectedJobs: 1,
      minRequests: 1,
      maxRequests: 1,
      minLookups: 2,
    }),
  );

  results.push(
    await crashScenario({
      checkpoint: "action.claimed",
      safety: "unsafe",
      expectedRunStatus: "completed",
      expectedActionStatus: "delivered",
      expectedJobs: 1,
      minRequests: 1,
      maxRequests: 1,
    }),
  );

  results.push(
    await crashScenario({
      checkpoint: "action.dispatch_started",
      safety: "unsafe",
      expectedRunStatus: "failed",
      expectedActionStatus: "ambiguous",
      expectedJobs: 0,
      minRequests: 0,
      maxRequests: 0,
    }),
  );

  for (const checkpoint of ["executor.request_received", "executor.accepted"]) {
    results.push(
      await crashScenario({
        checkpoint,
        safety: "unsafe",
        expectedRunStatus: "failed",
        expectedActionStatus: "ambiguous",
        // At request arrival the remote effect is inherently uncertain: the
        // legitimate outcome is zero or one job, never a second dispatch.
        expectedJobs: checkpoint === "executor.accepted" ? 1 : undefined,
        minRequests: 1,
        maxRequests: 1,
      }),
    );
  }

  const seededUnsafeTrace = await checkRuntimeConformance({checkpoint:"seeded_direct_retry",safety:"unsafe",actionStatus:"delivered",uncertainReceipt:true,seededDirectRetry:true,executorRequests:2,executorCreates:1,reconciliations:0,journal:[]});
  if (seededUnsafeTrace.accepted) throw new Error("seeded direct ambiguous retry unexpectedly conformed");
  const report = {
        celld: run(celldBin, ["--version"]).trim(),
        schemaVersion: 3,
        actionLeaseMs,
        scenarios: results,
        formalConformance: {
          specId: "protein-crash-retry-protocol/v1",
          checkedScenarios: results.filter((result) => result.conformance !== null).length,
          acceptedScenarios: results.filter((result) => result.conformance?.accepted === true).length,
          seededUnsafeTrace,
        },
        summary: {
          passed: results.filter((result) => result.status === "passed").length,
          failed: results.filter((result) => result.status === "failed").length,
          total: results.length,
        },
      };
  const outputPath = resolve(process.env.PROTEIN_CRASH_OUTPUT ?? join(root,".protein/formal-protocol/conformance",`action-crash-${suffix}.json`));
  await mkdir(dirname(outputPath),{recursive:true});await writeFile(outputPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,outputPath},null,2));
  if (
    results.some((result) => result.status === "failed") &&
    process.env.PROTEIN_PROOF_ALLOW_FAILURES !== "1"
  ) {
    process.exitCode = 1;
  }
} catch (error) {
  if (celld !== undefined) {
    console.error("\nLast celld output:\n", celld.output().slice(-20_000));
  }
  throw error;
} finally {
  await cleanup();
}

async function crashScenario({
  checkpoint,
  safety,
  expectedRunStatus,
  expectedActionStatus,
  expectedJobs,
  minRequests,
  maxRequests,
  minLookups = 0,
}) {
  const slug = checkpoint.replaceAll(".", "-");
  const runId = `${safety}-${slug}-${suffix}`;
  const actionId = `run:${runId}:execute`;
  const agent = `matrix-${runId}`;
  const agentBase = `${baseUrl}/agents/${encodeURIComponent(agent)}`;
  await postJson(`${proofUrl}/control/arm`, {
    checkpoint,
    match: checkpoint.startsWith("event.") ? { runId } : { actionId },
    expectedHits: 1,
  });

  await postJson(
    `${agentBase}/runs`,
    {
      id: runId,
      goal: {
        repository: "acme/protein-proof",
        task: `crash at ${checkpoint}`,
        safety,
      },
    },
    202,
  );

  const reached = await pollJson(
    `${proofUrl}/control/status`,
    (status) => status.gate?.reached === true,
  );
  assertEqual(reached.gate.checkpoint, checkpoint, `${runId} checkpoint`);

  await hardKill(celld.child);
  await celld.cleanup();
  celld = undefined;
  await postJson(`${proofUrl}/control/release`, {});
  celld = await startNode();

  const runRecord = await pollJson(
    `${agentBase}/runs/${encodeURIComponent(runId)}`,
    (record) => record.status === "completed" || record.status === "failed",
    { attempts: 600 },
  );
  const actions = await getJson(`${agentBase}/actions`);
  const action = actions.actions.find((candidate) => candidate.id === actionId);
  if (action === undefined) throw new Error(`${runId} action was not found`);
  const stats = await getJson(
    `${proofUrl}/stats?key=${encodeURIComponent(actionId)}`,
  );
  const journal = await getJson(`${agentBase}/journal?limit=100`);
  const uncertainReceipt = ["action.dispatch_started", "executor.request_received", "executor.accepted", "action.response_received"].includes(checkpoint);
  const conformance = safety === "idempotent" ? null : await checkRuntimeConformance({
    checkpoint,
    safety,
    actionStatus: action.status,
    uncertainReceipt,
    executorRequests: stats.requests,
    executorCreates: stats.creates,
    reconciliations: stats.lookups,
    journal: journal.journal,
  });
  const violations = [];
  if (runRecord.status !== expectedRunStatus) {
    violations.push(
      `expected run ${expectedRunStatus}, observed ${runRecord.status}`,
    );
  }
  if (action.status !== expectedActionStatus) {
    violations.push(
      `expected action ${expectedActionStatus}, observed ${action.status}`,
    );
  }
  if (expectedJobs !== undefined && stats.creates !== expectedJobs) {
    violations.push(
      `expected ${expectedJobs} logical executor jobs, observed ${stats.creates}`,
    );
  }
  if (stats.requests < minRequests) {
    violations.push(
      `expected at least ${minRequests} executor requests, observed ${stats.requests}`,
    );
  }
  if (maxRequests !== undefined && stats.requests > maxRequests) {
    violations.push(
      `expected at most ${maxRequests} executor requests, observed ${stats.requests}`,
    );
  }
  if (stats.lookups < minLookups) {
    violations.push(
      `expected at least ${minLookups} reconciliations, observed ${stats.lookups}`,
    );
  }
  if (conformance !== null && !conformance.accepted) {
    violations.push("runtime trace did not conform to the proved reconciliation protocol");
  }

  return {
    checkpoint,
    safety,
    status: violations.length === 0 ? "passed" : "failed",
    runStatus: runRecord.status,
    actionStatus: action.status,
    attempts: action.attempts,
    executorRequests: stats.requests,
    executorJobs: stats.creates,
    reconciliations: stats.lookups,
    conformance,
    violations,
  };
}

async function startNode() {
  return startCelld({
    celldBin,
    bucket,
    endpoint,
    credentials,
    port: celldPort,
    node: "protein-crash-node",
    ttlMs: 1_500,
    variables: {
      EXECUTOR_URL: proofUrl,
      PROTEIN_CHECKPOINT_URL: proofUrl,
      PROTEIN_LEASE_MS: actionLeaseMs,
      PROTEIN_NODE_ID: "crash-node",
    },
  });
}

async function cleanup() {
  if (celld !== undefined) await celld.cleanup();
  celld = undefined;
  await stopChild(controller);
  controller = undefined;
  if (minioStarted) {
    minioStarted = false;
    stopMinio(minioName);
  }
}
