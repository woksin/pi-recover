#!/usr/bin/env node
// Use an existing compiler only. Never install or modify the host's packages.
import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";

const candidates = process.env.PI_RECOVER_TSC
  ? [process.env.PI_RECOVER_TSC]
  : (process.env.PATH || "").split(delimiter).map(directory => join(directory, "tsc"));
const tsc = candidates.find(path => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
});
if (!tsc) {
  console.error("TypeScript is unavailable on PATH. Set PI_RECOVER_TSC to an existing tsc executable; no installation is performed.");
  process.exitCode = 1;
} else {
  const result = spawnSync(tsc, ["--noEmit", "-p", "tsconfig.json"], { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
