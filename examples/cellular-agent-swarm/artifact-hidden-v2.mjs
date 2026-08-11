export const HIDDEN_CASES = [
  { name: "negative values", values: [3, -2, 3, -7, 0, -2], expected: [-7, -2, 0, 3] },
  { name: "sparse range", values: [1_000_000, -1_000_000, 7, 7], expected: [-1_000_000, 7, 1_000_000] },
  { name: "int32 boundaries", values: [2147483647, -2147483648, 0, 2147483647], expected: [-2147483648, 0, 2147483647] },
  { name: "short disorder windows", values: [1, 2, 8, 4, 5, 8, 6, 9], expected: [1, 2, 4, 5, 6, 8, 9] },
  { name: "already ordered duplicates", values: [-4, -4, -1, 0, 0, 3, 9, 9], expected: [-4, -1, 0, 3, 9] },
];
