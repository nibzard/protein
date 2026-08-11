export const MULTI_REGIME_BENCHMARK_PROTOCOL = "protein-swarm-multi-regime-median/v1";

const REGIME_KINDS = new Set([
  "ordered-duplicates",
  "short-disorder-windows",
  "duplicate-heavy-unsorted",
  "wide-range-unsorted",
]);

export function buildBenchmarkValues(regime, round) {
  const normalized = normalizeRegime(regime);
  if (!Number.isInteger(round) || round < 0 || round > 1_000) {
    throw new Error("benchmark round must be an integer from 0 to 1000");
  }
  const random = xorshift32(mixSeed(normalized.seed, round));
  switch (normalized.kind) {
    case "ordered-duplicates":
      return orderedDuplicates(normalized.size, random, round);
    case "short-disorder-windows":
      return shortDisorderWindows(normalized.size, random, round);
    case "duplicate-heavy-unsorted":
      return duplicateHeavyUnsorted(normalized.size, random);
    case "wide-range-unsorted":
      return wideRangeUnsorted(normalized.size, random);
    default:
      throw new Error(`unsupported benchmark regime ${normalized.kind}`);
  }
}

export function sortedUniqueReference(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function sanitizeBenchmarkResult(value, measurement) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.protocol !== MULTI_REGIME_BENCHMARK_PROTOCOL) return null;
  const expected = normalizeMeasurement(measurement);
  if (
    value.warmupRounds !== expected.warmupRounds ||
    value.roundsPerRegime !== expected.roundsPerRegime ||
    !Array.isArray(value.regimes) ||
    value.regimes.length !== expected.regimes.length
  ) return null;

  const regimes = [];
  for (let index = 0; index < expected.regimes.length; index += 1) {
    const expectedRegime = expected.regimes[index];
    const received = value.regimes[index];
    if (
      received === null ||
      typeof received !== "object" ||
      Array.isArray(received) ||
      received.id !== expectedRegime.id ||
      received.inputItems !== expectedRegime.size ||
      received.rounds !== expected.roundsPerRegime
    ) return null;
    const medianMs = finiteNonNegative(received.medianMs);
    const minMs = finiteNonNegative(received.minMs);
    const p25Ms = finiteNonNegative(received.p25Ms);
    const p75Ms = finiteNonNegative(received.p75Ms);
    const maxMs = finiteNonNegative(received.maxMs);
    const throughputItemsPerMs = finiteNonNegative(received.throughputItemsPerMs);
    if (
      [medianMs, minMs, p25Ms, p75Ms, maxMs, throughputItemsPerMs].some((item) => item === null) ||
      throughputItemsPerMs === 0 ||
      minMs > p25Ms || p25Ms > medianMs || medianMs > p75Ms || p75Ms > maxMs
    ) return null;
    regimes.push({
      id: expectedRegime.id,
      inputItems: expectedRegime.size,
      rounds: expected.roundsPerRegime,
      medianMs,
      minMs,
      p25Ms,
      p75Ms,
      maxMs,
      throughputItemsPerMs,
    });
  }

  const aggregate = value.aggregate;
  if (aggregate === null || typeof aggregate !== "object" || Array.isArray(aggregate)) return null;
  if (aggregate.statistic !== "geometric-mean-regime-throughput") return null;
  const score = finiteNonNegative(aggregate.score);
  const throughputItemsPerMs = finiteNonNegative(aggregate.throughputItemsPerMs);
  const expectedScore = Math.max(1, Math.round(Math.exp(
    regimes.reduce((sum, regime) => sum + Math.log(regime.throughputItemsPerMs), 0) / regimes.length,
  )));
  if (
    score === null ||
    throughputItemsPerMs === null ||
    score !== throughputItemsPerMs ||
    score !== expectedScore
  ) return null;

  return {
    protocol: MULTI_REGIME_BENCHMARK_PROTOCOL,
    warmupRounds: expected.warmupRounds,
    roundsPerRegime: expected.roundsPerRegime,
    aggregate: {
      statistic: "geometric-mean-regime-throughput",
      score,
      throughputItemsPerMs,
    },
    regimes,
  };
}

export function normalizeMeasurement(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("benchmark measurement must be an object");
  }
  if (value.protocol !== MULTI_REGIME_BENCHMARK_PROTOCOL) {
    throw new Error(`benchmark protocol must be ${MULTI_REGIME_BENCHMARK_PROTOCOL}`);
  }
  const warmupRounds = boundedInteger(value.warmupRounds, "warmupRounds", 0, 5);
  const roundsPerRegime = boundedInteger(value.roundsPerRegime, "roundsPerRegime", 3, 15);
  if (!Array.isArray(value.regimes) || value.regimes.length < 2 || value.regimes.length > 8) {
    throw new Error("benchmark regimes must contain from 2 to 8 entries");
  }
  const regimes = value.regimes.map(normalizeRegime);
  if (new Set(regimes.map((regime) => regime.id)).size !== regimes.length) {
    throw new Error("benchmark regime IDs must be unique");
  }
  return {
    protocol: MULTI_REGIME_BENCHMARK_PROTOCOL,
    warmupRounds,
    roundsPerRegime,
    regimes,
  };
}

function normalizeRegime(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("benchmark regime must be an object");
  }
  if (typeof value.id !== "string" || !/^[a-z0-9-]{3,48}$/.test(value.id)) {
    throw new Error("benchmark regime id must be a bounded kebab-case string");
  }
  if (!REGIME_KINDS.has(value.kind)) throw new Error(`unsupported benchmark regime kind ${value.kind}`);
  return {
    id: value.id,
    kind: value.kind,
    size: boundedInteger(value.size, "regime size", 1_000, 100_000),
    seed: boundedInteger(value.seed, "regime seed", 1, 0x7fffffff),
  };
}

function orderedDuplicates(size, random, round) {
  const values = new Array(size);
  let current = -Math.floor(size / 3) + Number(random() % 31n);
  const phase = round % 5;
  for (let index = 0; index < size; index += 1) {
    if ((index + phase) % 4 !== 0) current += 1;
    values[index] = current;
  }
  return values;
}

function shortDisorderWindows(size, random, round) {
  const values = orderedDuplicates(size, random, round);
  const stride = 223 + Number(random() % 67n);
  for (let index = 97 + (round % 29); index + 7 < size; index += stride) {
    const distance = 2 + Number(random() % 6n);
    [values[index], values[index + distance]] = [values[index + distance], values[index]];
  }
  return values;
}

function duplicateHeavyUnsorted(size, random) {
  const values = new Array(size);
  const domain = 2_049;
  for (let index = 0; index < size; index += 1) {
    values[index] = Number(random() % BigInt(domain)) - Math.floor(domain / 2);
  }
  return values;
}

function wideRangeUnsorted(size, random) {
  const values = new Array(size);
  for (let index = 0; index < size; index += 1) {
    if (index > 0 && index % 11 === 0) values[index] = values[index - 1];
    else values[index] = Number(BigInt.asIntN(32, random()));
  }
  values[0] = -2147483648;
  values[1] = 2147483647;
  return values;
}

function xorshift32(initialSeed) {
  let state = initialSeed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return BigInt(state >>> 0);
  };
}

function mixSeed(seed, round) {
  let value = (seed ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
