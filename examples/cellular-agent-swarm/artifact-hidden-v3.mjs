export const HIDDEN_CASES = [
  { name: "negative duplicates", values: [3, -2, 3, -7, 0, -2], expected: [-7, -2, 0, 3] },
  { name: "sparse range", values: [1_000_000, -1_000_000, 7, 7], expected: [-1_000_000, 7, 1_000_000] },
  { name: "short disorder window", values: [1, 2, 8, 4, 5, 8, 6, 9], expected: [1, 2, 4, 5, 6, 8, 9] },
  { name: "all equal", values: [-19, -19, -19, -19], expected: [-19] },
  {
    name: "alternating boundaries",
    values: [2147483647, -2147483648, 2147483647, -2147483648, 0, -1, 1],
    expected: [-2147483648, -1, 0, 1, 2147483647],
  },
  { name: "reverse signed range", values: [5, 4, 3, 2, 1, 0, -1, -2, -3], expected: [-3, -2, -1, 0, 1, 2, 3, 4, 5] },
  { name: "non-lexicographic positives", values: [100, 11, 2, 20, 3, 11], expected: [2, 3, 11, 20, 100] },
  { name: "mixed sparse duplicates", values: [42, -999_999, 42, 17, 999_999, -999_999], expected: [-999_999, 17, 42, 999_999] },
];
