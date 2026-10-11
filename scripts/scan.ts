#!/usr/bin/env node
/** Read-only format sanity check. Never prints prompts, messages, or log content. */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readSession, sessionFiles } from "../src/sessions.ts";

const root = process.argv[2] ?? join(homedir(), ".pi", "agent", "sessions");
const files = await sessionFiles(root);
const dated = await Promise.all(files.map(async file => ({ file, modified: (await stat(file)).mtimeMs })));
const recent = dated.sort((a, b) => b.modified - a.modified).slice(0, 20);
const totals = { agent: [0, 0, 0], job: [0, 0, 0], workflow: [0, 0, 0], scheduled: 0, malformed: 0 };
console.log("Counts per kind: finished/unfinished/interrupted");
for (const { file } of recent) {
  const state = await readSession(file);
  const counts = { agent: [0, 0, 0], job: [0, 0, 0], workflow: [0, 0, 0] };
  for (const thread of state.threads) counts[thread.kind][["finished", "unfinished", "interrupted"].indexOf(thread.state)]++;
  for (const kind of ["agent", "job", "workflow"] as const) counts[kind].forEach((value, i) => totals[kind][i] += value);
  totals.scheduled += state.scheduled.length;
  totals.malformed += state.malformedLines;
  console.log(`${basename(file)} agent=${counts.agent.join("/")} job=${counts.job.join("/")} workflow=${counts.workflow.join("/")} scheduled=${state.scheduled.length} malformed=${state.malformedLines}`);
}
console.log(`TOTAL (${recent.length} files): ${JSON.stringify(totals)}`);
