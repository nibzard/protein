import { MULTI_REGIME_BENCHMARK_PROTOCOL } from "./artifact-workloads.mjs";

export const BENCHMARK = {
  id: "sorted-unique-int32/v3",
  prompt:
    "Implement solve(values) so it returns every distinct signed 32-bit integer in ascending numeric order without imports. Optimize across ordered duplicate runs, mostly ordered inputs with short disorder windows, duplicate-heavy unsorted inputs, and wide-range unsorted inputs.",
  publicChecks: [
    "deduplicates and numerically sorts ordinary input",
    "handles signed values and int32 boundaries",
    "handles ordered and reverse-ordered duplicates",
    "preserves empty and singleton results",
    "passes all deterministic benchmark-regime correctness gates",
  ],
  evaluatorVersion: "protein-swarm-evaluator/v3",
  measurement: {
    protocol: MULTI_REGIME_BENCHMARK_PROTOCOL,
    warmupRounds: 2,
    roundsPerRegime: 9,
    regimes: [
      { id: "ordered-duplicates", kind: "ordered-duplicates", size: 24_000, seed: 1_043_729 },
      { id: "short-disorder", kind: "short-disorder-windows", size: 24_000, seed: 7_919_503 },
      { id: "duplicate-heavy", kind: "duplicate-heavy-unsorted", size: 24_000, seed: 13_481_291 },
      { id: "wide-range", kind: "wide-range-unsorted", size: 24_000, seed: 19_260_731 },
    ],
  },
};

export const BASELINE_SOURCE = `export function solve(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}
`;

export const PUBLIC_CASES = [
  { name: "ordinary duplicates", values: [4, 1, 4, 2, 2], expected: [1, 2, 4] },
  { name: "signed numeric order", values: [10, -3, 2, -3, 1], expected: [-3, 1, 2, 10] },
  {
    name: "int32 boundaries",
    values: [2147483647, -2147483648, 0, 2147483647, -2147483648],
    expected: [-2147483648, 0, 2147483647],
  },
  { name: "ordered duplicates", values: [-4, -4, -1, 0, 0, 3, 9, 9], expected: [-4, -1, 0, 3, 9] },
  { name: "reverse duplicates", values: [8, 8, 5, 3, 3, 1, -2], expected: [-2, 1, 3, 5, 8] },
  { name: "empty", values: [], expected: [] },
  { name: "singleton", values: [17], expected: [17] },
];
