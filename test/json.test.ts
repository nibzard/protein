import { describe, expect, it } from "vitest";
import { canonicalJson, errorMessage, parseJson } from "../src/json";

describe("canonicalJson", () => {
  it("produces the same identity for differently ordered objects", () => {
    const left = canonicalJson({
      task: "repair",
      repository: "acme/api",
      options: { tests: true, retries: 2 },
    });
    const right = canonicalJson({
      options: { retries: 2, tests: true },
      repository: "acme/api",
      task: "repair",
    });

    expect(left).toBe(right);
  });

  it("preserves array order while sorting nested object keys", () => {
    expect(canonicalJson([{ b: 2, a: 1 }, { c: 3 }])).toBe(
      '[{"a":1,"b":2},{"c":3}]',
    );
  });
});

describe("JSON helpers", () => {
  it("round trips typed values", () => {
    expect(parseJson<{ status: string }>('{"status":"ok"}')).toEqual({
      status: "ok",
    });
  });

  it("normalizes unknown errors", () => {
    expect(errorMessage(new Error("broken"))).toBe("broken");
    expect(errorMessage("broken")).toBe("broken");
  });
});
