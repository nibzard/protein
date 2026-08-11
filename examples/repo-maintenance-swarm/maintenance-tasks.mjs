export const TASKS = [
  {
    id: "slugify",
    file: "src/slugify.js",
    issue: "Normalize Unicode text into a stable URL slug. Transliterate diacritics, collapse separators, and return 'item' for empty output.",
    source: `(value) => String(value).trim().toLowerCase().replace(/\\s+/g, "-")`,
    publicCases: [["Hello, World!"], ["  multiple   spaces  "], [""]],
    hiddenCases: [["Crème brûlée"], ["---"], ["A__B"], ["mañana café"]],
    expected: ["hello-world", "multiple-spaces", "item", "creme-brulee", "item", "a-b", "manana-cafe"],
  },
  {
    id: "merge-headers",
    file: "src/merge-headers.js",
    issue: "Merge HTTP header objects case-insensitively. Later values win, preserve the later spelling, omit undefined values, and never mutate inputs.",
    source: `(base, extra) => ({ ...base, ...extra })`,
    publicCases: [[{"Accept":"json"},{"X-Trace":"1"}], [{"Accept":"json"},{"Accept":"text"}]],
    hiddenCases: [[{"Content-Type":"json"},{"content-type":"text"}], [{"A":"1"},{"a":undefined,"B":"2"}], [{"X":"1"},{}]],
    expected: [{"Accept":"json","X-Trace":"1"}, {"Accept":"text"}, {"content-type":"text"}, {"A":"1","B":"2"}, {"X":"1"}],
  },
  {
    id: "parse-duration",
    file: "src/parse-duration.js",
    issue: "Parse a non-negative duration such as 250ms, 2s, 1.5m, or 1h into integer milliseconds, allowing surrounding whitespace. Reject malformed, negative, unsupported, or non-finite values with null.",
    source: `(text) => parseInt(text, 10) * 1000`,
    publicCases: [["2s"], ["250ms"], ["1.5m"]],
    hiddenCases: [["1h"], ["-1s"], ["wat"], ["Infinitys"], [" 2s "]],
    expected: [2000, 250, 90000, 3600000, null, null, null, 2000],
  },
  {
    id: "retry-delay",
    file: "src/retry-delay.js",
    issue: "Compute deterministic exponential retry delay: base * 2^attempt, capped at max. Validate finite non-negative integer attempt and positive finite base/max; invalid input returns null.",
    source: `(attempt, base, max) => Math.min(max, base * (2 ** (attempt - 1)))`,
    publicCases: [[0,100,5000], [2,100,5000], [10,100,5000]],
    hiddenCases: [[-1,100,5000], [1.5,100,5000], [1,0,5000], [1,100,50], [3,125,1000]],
    expected: [100, 400, 5000, null, null, null, 50, 1000],
  },
];

export function taskById(id) {
  const task = TASKS.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Unknown maintenance task ${id}`);
  return task;
}
