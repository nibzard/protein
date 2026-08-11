import { describe, expect, it } from "vitest";
import {
  advanceRun,
  comparison,
  createRun,
  runToCompletion,
  validateRun,
} from "../examples/cellular-agent-swarm/simulation.mjs";
import {
  evaluateArtifact,
  strategyKeys,
  strategySource,
} from "../examples/cellular-agent-swarm/artifact-benchmark.mjs";

describe("cellular agent swarm simulation", () => {
  it("starts a bounded 4 by 4 local experiment from one verified baseline", () => {
    const run = createRun();

    expect(run.cells).toHaveLength(16);
    expect(run.evidenceLevel).toBe("scripted-simulation");
    expect(run.config.topology).toBe("Moore neighborhood");
    expect(run.cells.every((cell) => cell.score === 100)).toBe(true);
    expect(validateRun(run)).toBe(true);
  });

  it("keeps the board score authoritative by rejecting hidden-test failures", () => {
    const run = runToCompletion({ condition: "local" });
    const rejected = run.candidates.filter((candidate) => !candidate.hiddenPass);

    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((candidate) => candidate.score === 0)).toBe(true);
    expect(run.events.some((event) => event.type === "candidate.challenged")).toBe(true);
    expect(validateRun(run)).toBe(true);
  });

  it("makes local synthesis visible under equal total grants", () => {
    const local = runToCompletion({ condition: "local" });
    const isolated = runToCompletion({ condition: "isolated" });
    const sequential = runToCompletion({ condition: "sequential" });

    expect(local.config.totalCredits).toBe(isolated.config.totalCredits);
    expect(local.config.totalCredits).toBe(sequential.config.totalCredits);
    expect(Math.max(...local.cells.map((cell) => cell.score))).toBe(621);
    expect(Math.max(...isolated.cells.map((cell) => cell.score))).toBe(481);
    expect(Math.max(...sequential.cells.map((cell) => cell.score))).toBeLessThan(
      Math.max(...local.cells.map((cell) => cell.score)),
    );
  });

  it("replays deterministically from a recorded seed", () => {
    const first = createRun({ seed: 1776 });
    const second = createRun({ seed: 1776 });
    for (let generation = 0; generation < 6; generation += 1) {
      advanceRun(first);
      advanceRun(second);
    }

    expect(first.history).toEqual(second.history);
    expect(first.cells).toEqual(second.cells);
    expect(first.candidates).toEqual(second.candidates);
  });

  it("exposes all three benchmark conditions", () => {
    const rows = comparison();
    expect(rows.map((row) => row.condition)).toEqual([
      "sequential",
      "isolated",
      "local",
    ]);
    expect(rows.find((row) => row.condition === "local")?.bestScore).toBeGreaterThan(
      rows.find((row) => row.condition === "isolated")?.bestScore ?? 0,
    );
  });
});

describe("cellular swarm smoke artifact evaluator", () => {
  it("executes candidate source against public and hidden correctness cases", () => {
    const baseline = evaluateArtifact("baseline");
    const radix = evaluateArtifact("radix_int32");

    expect(baseline.publicPass).toBe(true);
    expect(baseline.hiddenPass).toBe(true);
    expect(radix.publicPass).toBe(true);
    expect(radix.hiddenPass).toBe(true);
    expect(baseline.score).toBeGreaterThan(0);
    expect(radix.score).toBeGreaterThan(0);
  });

  it("gates known-invalid artifacts before performance can produce a score", () => {
    for (const strategy of ["sparse_bitmap", "cached_tail"]) {
      const result = evaluateArtifact(strategy);
      expect(result.hiddenPass).toBe(false);
      expect(result.score).toBe(0);
      expect(result.benchmark).toBeNull();
    }
  });

  it("keeps strategy artifacts inspectable and content-identifiable", () => {
    expect(strategyKeys()).toContain("radix_int32");
    const artifact = strategySource("sort_scan");
    const first = evaluateArtifact("sort_scan");
    const second = evaluateArtifact("sort_scan");

    expect(artifact.source).toContain("export function solve");
    expect(first.sourceSha256).toBe(second.sourceSha256);
  });
});
