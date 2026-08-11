import { describe, expect, it } from "vitest";
import {
  ProteinConflictError,
  ProteinError,
  ProteinValidationError,
} from "../src/errors";

describe("Protein errors", () => {
  it("carry stable protocol codes", () => {
    expect(new ProteinConflictError("duplicate")).toMatchObject({
      name: "ProteinConflictError",
      code: "conflict",
      message: "duplicate",
    });
    expect(new ProteinValidationError("bad input")).toMatchObject({
      name: "ProteinValidationError",
      code: "validation_error",
    });
  });

  it("remain ordinary errors", () => {
    expect(new ProteinError("failed", "test_error")).toBeInstanceOf(Error);
  });
});
