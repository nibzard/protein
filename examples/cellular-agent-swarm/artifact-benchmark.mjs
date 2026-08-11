import { createHash } from "node:crypto";

export const BENCHMARK = {
  id: "sorted-unique-int32/v1",
  prompt:
    "Implement solve(values) so it returns all distinct signed 32-bit integers in ascending order. Optimize for large, mostly ordered streams with duplicates and short disorder windows.",
  publicChecks: [
    "deduplicates ordinary input",
    "sorts mixed positive input",
    "preserves empty input",
  ],
  evaluatorVersion: "protein-swarm-evaluator/v1",
};

const STRATEGIES = {
  baseline: {
    label: "Set and comparison sort",
    source: `export function solve(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}
`,
  },
  sort_scan: {
    label: "In-place sort and unique scan",
    source: `export function solve(values) {
  const ordered = values.slice().sort((left, right) => left - right);
  if (ordered.length === 0) return [];
  let write = 1;
  for (let read = 1; read < ordered.length; read += 1) {
    if (ordered[read] !== ordered[write - 1]) ordered[write++] = ordered[read];
  }
  ordered.length = write;
  return ordered;
}
`,
  },
  chunk_merge: {
    label: "Bounded chunk merge",
    source: `export function solve(values) {
  const chunks = [];
  for (let offset = 0; offset < values.length; offset += 512) {
    const chunk = values.slice(offset, offset + 512).sort((left, right) => left - right);
    const unique = [];
    for (const value of chunk) {
      if (unique.length === 0 || unique[unique.length - 1] !== value) unique.push(value);
    }
    chunks.push(unique);
  }
  const positions = new Uint32Array(chunks.length);
  const output = [];
  while (true) {
    let minimum;
    for (let index = 0; index < chunks.length; index += 1) {
      const value = chunks[index][positions[index]];
      if (value !== undefined && (minimum === undefined || value < minimum)) minimum = value;
    }
    if (minimum === undefined) break;
    if (output.length === 0 || output[output.length - 1] !== minimum) output.push(minimum);
    for (let index = 0; index < chunks.length; index += 1) {
      if (chunks[index][positions[index]] === minimum) positions[index] += 1;
    }
  }
  return output;
}
`,
  },
  adaptive_runs: {
    label: "Adaptive ordered-run merge",
    source: `export function solve(values) {
  if (values.length === 0) return [];
  const runs = [];
  let start = 0;
  for (let index = 1; index <= values.length; index += 1) {
    if (index === values.length || values[index] < values[index - 1]) {
      runs.push(values.slice(start, index));
      start = index;
    }
  }
  const positions = new Uint32Array(runs.length);
  const output = [];
  while (true) {
    let minimum;
    for (let index = 0; index < runs.length; index += 1) {
      const value = runs[index][positions[index]];
      if (value !== undefined && (minimum === undefined || value < minimum)) minimum = value;
    }
    if (minimum === undefined) break;
    if (output.length === 0 || output[output.length - 1] !== minimum) output.push(minimum);
    for (let index = 0; index < runs.length; index += 1) {
      while (runs[index][positions[index]] === minimum) positions[index] += 1;
    }
  }
  return output;
}
`,
  },
  radix_int32: {
    label: "Signed two-pass radix",
    source: `export function solve(values) {
  if (values.length === 0) return [];
  let input = new Uint32Array(values.length);
  let output = new Uint32Array(values.length);
  for (let index = 0; index < values.length; index += 1) input[index] = (values[index] ^ 0x80000000) >>> 0;
  for (const shift of [0, 16]) {
    const counts = new Uint32Array(65536);
    for (let index = 0; index < input.length; index += 1) counts[(input[index] >>> shift) & 0xffff] += 1;
    let offset = 0;
    for (let index = 0; index < counts.length; index += 1) {
      const count = counts[index];
      counts[index] = offset;
      offset += count;
    }
    for (let index = 0; index < input.length; index += 1) {
      const value = input[index];
      output[counts[(value >>> shift) & 0xffff]++] = value;
    }
    const swap = input;
    input = output;
    output = swap;
  }
  const result = [];
  let previous;
  for (let index = 0; index < input.length; index += 1) {
    const value = (input[index] ^ 0x80000000) | 0;
    if (index === 0 || value !== previous) result.push(value);
    previous = value;
  }
  return result;
}
`,
  },
  sparse_bitmap: {
    label: "Range-sized bitmap",
    source: `export function solve(values) {
  if (values.length === 0) return [];
  const maximum = Math.max(...values);
  if (maximum > 1000000) throw new RangeError("bitmap range exceeds candidate allocation policy");
  const seen = new Uint8Array(maximum + 1);
  for (const value of values) seen[value] = 1;
  const output = [];
  for (let value = 0; value < seen.length; value += 1) if (seen[value]) output.push(value);
  return output;
}
`,
  },
  cached_tail: {
    label: "Adjacent duplicate filter",
    source: `export function solve(values) {
  const output = [];
  for (const value of values) {
    if (output.length === 0 || output[output.length - 1] !== value) output.push(value);
  }
  return output;
}
`,
  },
};

const PUBLIC_CASES = [
  { name: "ordinary duplicates", values: [4, 1, 4, 2, 2], expected: [1, 2, 4] },
  { name: "mixed positives", values: [9, 3, 7, 3, 1], expected: [1, 3, 7, 9] },
  { name: "empty", values: [], expected: [] },
];

const HIDDEN_CASES = [
  { name: "negative values", values: [3, -2, 3, -7, 0, -2], expected: [-7, -2, 0, 3] },
  { name: "sparse range", values: [1_000_000, -1_000_000, 7, 7], expected: [-1_000_000, 7, 1_000_000] },
  { name: "int32 boundaries", values: [2147483647, -2147483648, 0, 2147483647], expected: [-2147483648, 0, 2147483647] },
  { name: "short disorder windows", values: [1, 2, 8, 4, 5, 8, 6, 9], expected: [1, 2, 4, 5, 6, 8, 9] },
];

export function strategyKeys() {
  return Object.keys(STRATEGIES);
}

export function strategySource(strategy) {
  const entry = STRATEGIES[strategy];
  if (entry === undefined) throw new Error(`Unknown strategy ${strategy}`);
  return { strategy, label: entry.label, source: entry.source };
}

export function evaluateArtifact(strategy) {
  const artifact = strategySource(strategy);
  const solve = compile(artifact.source);
  const publicResults = PUBLIC_CASES.map((testCase) => runCase(solve, testCase));
  const hiddenResults = HIDDEN_CASES.map((testCase) => runCase(solve, testCase));
  const publicPass = publicResults.every((result) => result.passed);
  const hiddenPass = hiddenResults.every((result) => result.passed);
  const benchmark = publicPass && hiddenPass ? measure(solve) : null;
  return {
    benchmarkId: BENCHMARK.id,
    evaluatorVersion: BENCHMARK.evaluatorVersion,
    strategy,
    label: artifact.label,
    source: artifact.source,
    sourceSha256: sha256(artifact.source),
    publicPass,
    hiddenPass,
    publicResults,
    hiddenResults,
    benchmark,
    score: benchmark === null ? 0 : benchmark.throughputItemsPerMs,
  };
}

export function evidenceDigest(evidence) {
  return sha256(JSON.stringify(evidence));
}

function compile(source) {
  const executable = source.replace("export function solve", "function solve");
  return Function(`"use strict"; ${executable}; return solve;`)();
}

function runCase(solve, testCase) {
  try {
    const actual = solve(testCase.values);
    const passed = Array.isArray(actual) && arraysEqual(actual, testCase.expected);
    return {
      name: testCase.name,
      passed,
      ...(passed ? {} : { expected: testCase.expected, actual }),
    };
  } catch (error) {
    return { name: testCase.name, passed: false, error: String(error) };
  }
}

function measure(solve) {
  const input = benchmarkInput(18_000);
  solve(input);
  const samples = [];
  for (let round = 0; round < 7; round += 1) {
    const startedAt = performance.now();
    const output = solve(input);
    const elapsedMs = performance.now() - startedAt;
    if (output.length === 0) throw new Error("Benchmark candidate returned no values");
    samples.push(elapsedMs);
  }
  samples.sort((left, right) => left - right);
  const medianMs = samples[Math.floor(samples.length / 2)];
  return {
    inputItems: input.length,
    rounds: samples.length,
    medianMs: Number(medianMs.toFixed(3)),
    minMs: Number(samples[0].toFixed(3)),
    throughputItemsPerMs: Math.max(1, Math.round(input.length / medianMs)),
  };
}

function benchmarkInput(size) {
  const values = [];
  let current = -Math.floor(size / 3);
  for (let index = 0; index < size; index += 1) {
    if (index % 4 !== 0) current += 1;
    values.push(current);
  }
  for (let index = 257; index + 3 < values.length; index += 911) {
    [values[index], values[index + 3]] = [values[index + 3], values[index]];
  }
  return values;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
