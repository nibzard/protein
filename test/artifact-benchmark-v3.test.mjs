import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BENCHMARK as ACTIVE_BENCHMARK } from "../examples/cellular-agent-swarm/artifact-task.mjs";
import { BENCHMARK as V2_BENCHMARK } from "../examples/cellular-agent-swarm/artifact-task-v2.mjs";
import {
  BASELINE_SOURCE,
  BENCHMARK as V3_BENCHMARK,
  PUBLIC_CASES,
} from "../examples/cellular-agent-swarm/artifact-task-v3.mjs";
import { HIDDEN_CASES } from "../examples/cellular-agent-swarm/artifact-hidden-v3.mjs";
import {
  buildBenchmarkValues,
  sanitizeBenchmarkResult,
  sortedUniqueReference,
} from "../examples/cellular-agent-swarm/artifact-workloads.mjs";

const runnerPath = fileURLToPath(new URL(
  "../examples/cellular-agent-swarm/sandbox-runner.mjs",
  import.meta.url,
));

describe("cellular swarm artifact benchmark v3", () => {
  it("keeps the historical v2 contract while making v3 active", () => {
    expect(V2_BENCHMARK).toMatchObject({
      id: "sorted-unique-int32/v2",
      evaluatorVersion: "protein-swarm-evaluator/v2",
    });
    expect(ACTIVE_BENCHMARK).toEqual(V3_BENCHMARK);
    expect(ACTIVE_BENCHMARK).toMatchObject({
      id: "sorted-unique-int32/v3",
      evaluatorVersion: "protein-swarm-evaluator/v3",
      measurement: {
        warmupRounds: 2,
        roundsPerRegime: 9,
      },
    });
  });

  it("builds deterministic, round-varying signed-int32 workloads", () => {
    for (const regime of V3_BENCHMARK.measurement.regimes) {
      const first = buildBenchmarkValues(regime, 3);
      const replay = buildBenchmarkValues(regime, 3);
      const nextRound = buildBenchmarkValues(regime, 4);
      expect(first).toEqual(replay);
      expect(first).not.toEqual(nextRound);
      expect(first).toHaveLength(regime.size);
      expect(first.every((value) => (
        Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
      ))).toBe(true);
      const expected = sortedUniqueReference(first);
      expect(expected.every((value, index) => index === 0 || expected[index - 1] < value)).toBe(true);
    }
  });

  it("correctness-gates and repeatedly measures the trusted baseline across every regime", async () => {
    const execution = await runSandboxRunner({
      source: BASELINE_SOURCE,
      cases: [...PUBLIC_CASES, ...HIDDEN_CASES],
      timeoutMs: 750,
      benchmark: V3_BENCHMARK.measurement,
    }, 15_000);

    expect(execution.timedOut).toBe(false);
    expect(execution.code).toBe(0);
    expect(execution.stderr).toBe("");
    const result = JSON.parse(execution.stdout);
    expect(result).toMatchObject({
      pass: true,
      benchmarkGate: {
        total: V3_BENCHMARK.measurement.regimes.length,
        passed: V3_BENCHMARK.measurement.regimes.length,
        failed: 0,
      },
      benchmark: {
        protocol: V3_BENCHMARK.measurement.protocol,
        warmupRounds: 2,
        roundsPerRegime: 9,
        aggregate: {
          statistic: "geometric-mean-regime-throughput",
          score: expect.any(Number),
        },
      },
    });
    expect(result.benchmark.regimes.map((regime) => regime.id)).toEqual(
      V3_BENCHMARK.measurement.regimes.map((regime) => regime.id),
    );
    for (const regime of result.benchmark.regimes) {
      expect(regime).toMatchObject({
        inputItems: 24_000,
        rounds: 9,
        medianMs: expect.any(Number),
        p25Ms: expect.any(Number),
        p75Ms: expect.any(Number),
        throughputItemsPerMs: expect.any(Number),
      });
      expect(regime.minMs).toBeLessThanOrEqual(regime.p25Ms);
      expect(regime.p25Ms).toBeLessThanOrEqual(regime.medianMs);
      expect(regime.medianMs).toBeLessThanOrEqual(regime.p75Ms);
      expect(regime.p75Ms).toBeLessThanOrEqual(regime.maxMs);
    }
    expect(sanitizeBenchmarkResult(result.benchmark, V3_BENCHMARK.measurement)).toEqual(result.benchmark);
    expect(sanitizeBenchmarkResult({ ...result.benchmark, protocol: "wrong" }, V3_BENCHMARK.measurement)).toBeNull();
  });

  it("rejects a candidate that passes small cases but fails a workload correctness gate", async () => {
    const execution = await runSandboxRunner({
      source: `export function solve(values) {
        if (values.length >= 1_000) return [0];
        return [...new Set(values)].sort((left, right) => left - right);
      }`,
      cases: PUBLIC_CASES,
      timeoutMs: 750,
      benchmark: V3_BENCHMARK.measurement,
    });

    expect(execution.timedOut).toBe(false);
    expect(execution.code).toBe(0);
    const result = JSON.parse(execution.stdout);
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(result).toMatchObject({
      pass: false,
      benchmark: null,
      benchmarkGate: {
        total: V3_BENCHMARK.measurement.regimes.length,
        passed: 0,
        failed: V3_BENCHMARK.measurement.regimes.length,
      },
    });
  });
});

function runSandboxRunner(input, processTimeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, processTimeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(JSON.stringify(input));
  });
}
