import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const runDirectory = resolve(process.argv[2] ?? ".protein/compute-fabric/runs/compute-fabric-openai-20260811071417338-2078129");
const log = await readFile(join(runDirectory, "celld.log"), "utf8");
const lines = log.split("\n").filter(Boolean);
const warnings = lines.filter((line) => line.includes(" WARN "));
const errors = lines.filter((line) => line.includes(" ERROR "));
const unexpectedWarnings = warnings.filter((line) => !line.includes("peer owner unreachable"));
const result = {
  schemaVersion: 1,
  audit: "protein-compute-fabric-celld-log/v1",
  lines: lines.length,
  isolateStarts: count("cell isolate startup completed"),
  hibernationRestarts: lines.filter((line) => line.includes("cell isolate startup completed") && line.includes("fresh=false")).length,
  restoredRemoteReplicas: count("restored remote replica"),
  reentrantAlarms: count("alarm fired reentrantly"),
  warnings: warnings.length,
  peerOwnerUnreachableWarnings: warnings.filter((line) => line.includes("peer owner unreachable")).length,
  unexpectedWarnings: unexpectedWarnings.length,
  errors: errors.length,
};
result.passed = result.hibernationRestarts > 0 && result.restoredRemoteReplicas >= 27 && result.errors === 0 && result.unexpectedWarnings === 0;
await writeFile(join(runDirectory, "celld-audit.json"), JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;

function count(pattern) { return lines.filter((line) => line.includes(pattern)).length; }
