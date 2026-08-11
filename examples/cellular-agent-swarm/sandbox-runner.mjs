import { performance } from "node:perf_hooks";
import { Script, createContext } from "node:vm";
import {
  MULTI_REGIME_BENCHMARK_PROTOCOL,
  buildBenchmarkValues,
  normalizeMeasurement,
  sortedUniqueReference,
} from "./artifact-workloads.mjs";

const input = await readStdin();
const source = requireString(input.source, "source", 16_384);
const cases = requireCases(input.cases);
const timeoutMs = integer(input.timeoutMs, 25, 2_000);
const benchmarkPlan = input.benchmark === null || input.benchmark === undefined
  ? null
  : normalizeMeasurement(input.benchmark);
const benchmarkValues = Array.isArray(input.benchmarkValues) ? numericArray(input.benchmarkValues, "benchmarkValues") : null;
const benchmarkRounds = integer(input.benchmarkRounds ?? 5, 1, 12);
if (benchmarkPlan !== null && benchmarkValues !== null) {
  throw new Error("benchmark and legacy benchmarkValues cannot be used together");
}

const context = createContext(Object.create(null), {
  name: "protein-candidate",
  codeGeneration: { strings: false, wasm: false },
});
const normalized = normalizeSource(source);
const compileStartedAt = performance.now();
new Script(`"use strict";\n${normalized}\n;globalThis.__proteinSolve = solve;`, {
  filename: "candidate.mjs",
}).runInContext(context, { timeout: timeoutMs });
if (typeof context.__proteinSolve !== "function") throw new Error("Candidate did not define solve(values)");
const compileMs = fixed(performance.now() - compileStartedAt);

const invocation = new Script("globalThis.__proteinResult = globalThis.__proteinSolve(globalThis.__proteinInput);");
const checks = cases.map((testCase) => {
  try {
    installInput(context, testCase.values, timeoutMs);
    invocation.runInContext(context, { timeout: timeoutMs });
    const actual = Array.isArray(context.__proteinResult) ? Array.from(context.__proteinResult) : null;
    const passed = actual !== null && arraysEqual(actual, testCase.expected);
    return {
      name: testCase.name,
      passed,
      ...(passed ? {} : { error: actual === null ? "solve(values) did not return an Array" : "unexpected output" }),
    };
  } catch (error) {
    return { name: testCase.name, passed: false, error: boundedMessage(error) };
  } finally {
    context.__proteinInput = undefined;
    context.__proteinResult = undefined;
  }
});

const casePass = checks.every((check) => check.passed);
let benchmark = null;
let benchmarkGate = null;
if (benchmarkPlan !== null) {
  if (casePass) {
    ({ benchmark, benchmarkGate } = runMultiRegimeBenchmark(
      context,
      invocation,
      benchmarkPlan,
      timeoutMs,
    ));
  } else {
    benchmarkGate = skippedBenchmarkGate(benchmarkPlan);
  }
} else if (casePass && benchmarkValues !== null) {
  benchmark = runLegacyBenchmark(context, invocation, benchmarkValues, benchmarkRounds, timeoutMs);
}

const pass = casePass && (benchmarkGate === null || benchmarkGate.failed === 0);

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  pass,
  checks,
  benchmarkGate,
  benchmark,
  compileMs,
}));

function runMultiRegimeBenchmark(contextValue, invocationValue, plan, timeout) {
  const measurements = plan.regimes.map((regime) => ({ regime, samples: [], passed: true, error: null }));

  for (let warmup = 0; warmup < plan.warmupRounds; warmup += 1) {
    for (const measurement of measurements) {
      const outcome = invokeBenchmarkRound(
        contextValue,
        invocationValue,
        measurement.regime,
        warmup,
        timeout,
        false,
      );
      if (!outcome.passed) {
        measurement.passed = false;
        measurement.error = outcome.error;
        return failedMultiRegimeBenchmark(measurements, plan.roundsPerRegime);
      }
    }
  }

  for (let round = 0; round < plan.roundsPerRegime; round += 1) {
    for (const measurement of measurements) {
      const outcome = invokeBenchmarkRound(
        contextValue,
        invocationValue,
        measurement.regime,
        plan.warmupRounds + round,
        timeout,
        true,
      );
      if (!outcome.passed) {
        measurement.passed = false;
        measurement.error = outcome.error;
        return failedMultiRegimeBenchmark(measurements, plan.roundsPerRegime);
      }
      measurement.samples.push(outcome.elapsedMs);
    }
  }

  const regimes = measurements.map(({ regime, samples }) => benchmarkRegimeResult(regime, samples));
  const geometricMean = Math.exp(
    regimes.reduce((sum, regime) => sum + Math.log(regime.throughputItemsPerMs), 0) / regimes.length,
  );
  const score = Math.max(1, Math.round(geometricMean));
  return {
    benchmarkGate: buildBenchmarkGate(measurements),
    benchmark: {
      protocol: MULTI_REGIME_BENCHMARK_PROTOCOL,
      warmupRounds: plan.warmupRounds,
      roundsPerRegime: plan.roundsPerRegime,
      aggregate: {
        statistic: "geometric-mean-regime-throughput",
        score,
        throughputItemsPerMs: score,
      },
      regimes,
    },
  };
}

function invokeBenchmarkRound(contextValue, invocationValue, regime, round, timeout, measure) {
  try {
    const values = buildBenchmarkValues(regime, round);
    const expected = sortedUniqueReference(values);
    installInput(contextValue, values, timeout);
    contextValue.__proteinResult = undefined;
    const startedAt = measure ? performance.now() : 0;
    invocationValue.runInContext(contextValue, { timeout });
    const elapsedMs = measure ? performance.now() - startedAt : null;
    const actual = Array.isArray(contextValue.__proteinResult)
      ? Array.from(contextValue.__proteinResult)
      : null;
    if (actual === null || !arraysEqual(actual, expected)) {
      return { passed: false, error: "benchmark-regime correctness check failed" };
    }
    return { passed: true, elapsedMs };
  } catch (error) {
    return { passed: false, error: boundedMessage(error) };
  } finally {
    contextValue.__proteinInput = undefined;
    contextValue.__proteinResult = undefined;
  }
}

function benchmarkRegimeResult(regime, values) {
  const samples = [...values].sort((left, right) => left - right);
  const medianMs = quantile(samples, 0.5);
  return {
    id: regime.id,
    inputItems: regime.size,
    rounds: samples.length,
    medianMs: fixed(medianMs),
    minMs: fixed(samples[0]),
    p25Ms: fixed(quantile(samples, 0.25)),
    p75Ms: fixed(quantile(samples, 0.75)),
    maxMs: fixed(samples.at(-1)),
    throughputItemsPerMs: Math.max(1, Math.round(regime.size / medianMs)),
  };
}

function failedMultiRegimeBenchmark(measurements, roundsPerRegime) {
  for (const measurement of measurements) {
    if (measurement.samples.length !== roundsPerRegime) {
      measurement.passed = false;
      measurement.error ??= "benchmark did not complete every required round";
    }
  }
  return { benchmark: null, benchmarkGate: buildBenchmarkGate(measurements) };
}

function buildBenchmarkGate(measurements) {
  const checks = measurements.map((measurement) => ({
    id: measurement.regime.id,
    passed: measurement.passed,
    ...(measurement.error === null ? {} : { error: measurement.error }),
  }));
  const passed = checks.filter((check) => check.passed).length;
  return { total: checks.length, passed, failed: checks.length - passed, checks };
}

function skippedBenchmarkGate(plan) {
  return {
    total: plan.regimes.length,
    passed: 0,
    failed: plan.regimes.length,
    skipped: true,
    checks: plan.regimes.map((regime) => ({
      id: regime.id,
      passed: false,
      error: "benchmark skipped because a correctness check failed",
    })),
  };
}

function runLegacyBenchmark(contextValue, invocationValue, values, rounds, timeout) {
  const samples = [];
  installInput(contextValue, values, timeout);
  invocationValue.runInContext(contextValue, { timeout });
  for (let round = 0; round < rounds; round += 1) {
    installInput(contextValue, values, timeout);
    const startedAt = performance.now();
    invocationValue.runInContext(contextValue, { timeout });
    const elapsedMs = performance.now() - startedAt;
    if (!Array.isArray(contextValue.__proteinResult) || contextValue.__proteinResult.length === 0) {
      throw new Error("Benchmark candidate returned no Array values");
    }
    samples.push(elapsedMs);
  }
  samples.sort((left, right) => left - right);
  const medianMs = samples[Math.floor(samples.length / 2)];
  return {
    inputItems: values.length,
    rounds: samples.length,
    medianMs: fixed(medianMs),
    minMs: fixed(samples[0]),
    throughputItemsPerMs: Math.max(1, Math.round(values.length / medianMs)),
  };
}

function quantile(sortedValues, fraction) {
  return sortedValues[Math.floor((sortedValues.length - 1) * fraction)];
}

function normalizeSource(value) {
  if (/\b(?:import|require)\s*\(/.test(value) || /\bimport\s+[^.(]/.test(value)) {
    throw new Error("Imports are not permitted in candidate source");
  }
  const normalized = value.replace(/\bexport\s+function\s+solve\b/, "function solve");
  if (!/\bfunction\s+solve\s*\(/.test(normalized)) {
    throw new Error("Candidate source must export function solve(values)");
  }
  return normalized;
}

function installInput(contextValue, values, timeout) {
  new Script(`globalThis.__proteinInput = ${JSON.stringify(values)};`).runInContext(contextValue, { timeout });
}

function requireCases(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error("cases must be a non-empty bounded array");
  return value.map((testCase, index) => {
    if (testCase === null || typeof testCase !== "object" || Array.isArray(testCase)) throw new Error(`case ${index} must be an object`);
    return {
      name: requireString(testCase.name, `case ${index} name`, 120),
      values: numericArray(testCase.values, `case ${index} values`),
      expected: numericArray(testCase.expected, `case ${index} expected`),
    };
  });
}

function numericArray(value, label) {
  if (!Array.isArray(value) || value.length > 100_000 || !value.every((item) => Number.isInteger(item) && item >= -2147483648 && item <= 2147483647)) {
    throw new Error(`${label} must contain bounded signed 32-bit integers`);
  }
  return value;
}

function requireString(value, label, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  return value;
}

function integer(value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`integer must be from ${minimum} to ${maximum}`);
  return value;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fixed(value) {
  return Number(value.toFixed(3));
}

function boundedMessage(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 240);
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 4_000_000) throw new Error("Sandbox input exceeded 4 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
