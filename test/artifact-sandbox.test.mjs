import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runnerPath = fileURLToPath(new URL(
  "../examples/cellular-agent-swarm/sandbox-runner.mjs",
  import.meta.url,
));

describe("cellular swarm artifact sandbox runner", () => {
  it("does not expose Node globals or permit dynamic string code generation", async () => {
    const execution = await runSandboxRunner({
      source: `export function solve() {
        if (typeof process !== "undefined" || typeof require !== "undefined") return [0];
        try {
          Function("return 1")();
          return [0];
        } catch {
          return [1];
        }
      }`,
      cases: [{ name: "isolated globals", values: [], expected: [1] }],
      timeoutMs: 100,
      benchmarkValues: null,
      benchmarkRounds: 1,
    });

    expect(execution.timedOut).toBe(false);
    expect(execution.code).toBe(0);
    expect(execution.stderr).toBe("");
    expect(JSON.parse(execution.stdout)).toMatchObject({
      pass: true,
      checks: [{ name: "isolated globals", passed: true }],
    });
  });

  it("rejects imports before candidate execution", async () => {
    const execution = await runSandboxRunner({
      source: `import fs from "node:fs";
        export function solve(values) { return values; }`,
      cases: [{ name: "import attempt", values: [1], expected: [1] }],
      timeoutMs: 100,
      benchmarkValues: null,
      benchmarkRounds: 1,
    });

    expect(execution.timedOut).toBe(false);
    expect(execution.code).not.toBe(0);
    expect(execution.stderr).toContain("Imports are not permitted in candidate source");
  });

  it("bounds a non-terminating solve invocation", async () => {
    const startedAt = performance.now();
    const execution = await runSandboxRunner({
      source: `export function solve() {
        while (true) {}
      }`,
      cases: [{ name: "infinite loop", values: [1], expected: [1] }],
      timeoutMs: 25,
      benchmarkValues: null,
      benchmarkRounds: 1,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(execution.timedOut).toBe(false);
    expect(execution.code).toBe(0);
    expect(elapsedMs).toBeLessThan(1_500);
    expect(JSON.parse(execution.stdout)).toMatchObject({
      pass: false,
      checks: [{
        name: "infinite loop",
        passed: false,
        error: expect.stringMatching(/timed out/i),
      }],
      benchmark: null,
    });
  });
});

function runSandboxRunner(input, processTimeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
