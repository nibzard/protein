import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BENCHMARK } from "./artifact-task.mjs";

const runnerPath = fileURLToPath(new URL("./sandbox-runner.mjs", import.meta.url));
const workloadsPath = fileURLToPath(new URL("./artifact-workloads.mjs", import.meta.url));

export async function runArtifactSandbox({
  source,
  cases,
  benchmark = BENCHMARK.measurement,
  image = process.env.SWARM_SANDBOX_IMAGE ?? "node:22-alpine",
  timeoutMs = 8_000,
  invocationTimeoutMs = 750,
}) {
  const containerName = `protein-artifact-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const argumentsList = [
    "run", "--rm", "-i", "--name", containerName,
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--memory", "128m",
    "--cpus", "1",
    "--pids-limit", "64",
    "--user", "65534:65534",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
    "--mount", `type=bind,src=${runnerPath},dst=/runner/sandbox-runner.mjs,readonly`,
    "--mount", `type=bind,src=${workloadsPath},dst=/runner/artifact-workloads.mjs,readonly`,
    image,
    "node", "/runner/sandbox-runner.mjs",
  ];
  const child = spawn("docker", argumentsList, { stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
    spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
  }, timeoutMs);
  child.stdout.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > 2_000_000) child.kill("SIGKILL");
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > 2_000_000) child.kill("SIGKILL");
    else stderr.push(chunk);
  });
  child.stdin.end(JSON.stringify({
    source,
    cases,
    timeoutMs: invocationTimeoutMs,
    benchmark: benchmark === true ? BENCHMARK.measurement : benchmark || null,
  }));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearTimeout(timer);
  if (timedOut) throw new Error(`Artifact sandbox exceeded ${timeoutMs} ms`);
  if (outputBytes > 2_000_000) throw new Error("Artifact sandbox output exceeded 2 MB");
  if (exitCode !== 0) {
    throw new Error(`Artifact sandbox exited ${exitCode}: ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`);
  }
  const text = Buffer.concat(stdout).toString("utf8");
  const result = JSON.parse(text);
  if (result === null || typeof result !== "object" || typeof result.pass !== "boolean") {
    throw new Error("Artifact sandbox returned an invalid result");
  }
  return result;
}

export function inspectSandboxImage(image = process.env.SWARM_SANDBOX_IMAGE ?? "node:22-alpine") {
  const result = spawnSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8" });
  return result.status === 0 ? { image, imageId: result.stdout.trim() } : { image, imageId: null };
}
