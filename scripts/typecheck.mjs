#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const override = process.env.PI_RECOVER_TSC;
const command = override || process.execPath;
const args = override ? [] : [require.resolve("typescript/bin/tsc")];
const result = spawnSync(command, [...args, "--noEmit", "-p", "tsconfig.json"], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
