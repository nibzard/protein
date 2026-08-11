export const BENCHMARK = {
  id: "sorted-unique-int32/v2",
  prompt:
    "Implement solve(values) so it returns all distinct signed 32-bit integers in ascending order. Optimize for large, mostly ordered streams with duplicates and short disorder windows.",
  publicChecks: [
    "deduplicates ordinary input",
    "sorts mixed positive input",
    "preserves empty input",
  ],
  evaluatorVersion: "protein-swarm-evaluator/v2",
};

export const BASELINE_SOURCE = `export function solve(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}
`;

export const PUBLIC_CASES = [
  { name: "ordinary duplicates", values: [4, 1, 4, 2, 2], expected: [1, 2, 4] },
  { name: "mixed positives", values: [9, 3, 7, 3, 1], expected: [1, 3, 7, 9] },
  { name: "empty", values: [], expected: [] },
];

export function benchmarkInput(size = 18_000) {
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
