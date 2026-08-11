import { spawnSync } from "node:child_process";
import { root } from "./celld-proof-support.mjs";

const commands = ["test:crash-matrix", "test:ownership-chaos"];
let failed = false;

for (const command of commands) {
  const result = spawnSync("npm", ["run", command], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) failed = true;
}

if (failed) process.exitCode = 1;
