#!/usr/bin/env node
/** Read-only format sanity check. Never prints prompts, messages, or log content. */
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { contentText, LIMIT_ERROR, object, string } from "../src/collector.ts";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readSession, sessionFiles } from "../src/sessions.ts";

const root = process.argv[2] ?? join(homedir(), ".pi", "agent", "sessions");
const files = await sessionFiles(root);
const dated = await Promise.all(files.map(async file => ({ file, modified: (await stat(file)).mtimeMs })));
const recent = dated.sort((a, b) => b.modified - a.modified).slice(0, 20);
const states = ["finished", "failed", "unfinished", "interrupted", "live", "superseded"];
const totals = { agent: states.map(() => 0), job: states.map(() => 0), workflow: states.map(() => 0), scheduled: 0, malformed: 0, normalMessagesPreviouslyFlagged: 0 };
console.log(`Counts per kind: ${states.join("/")}`);
for (const { file } of recent) {
  const state = await readSession(file);
  const counts = { agent: states.map(() => 0), job: states.map(() => 0), workflow: states.map(() => 0) };
  for (const thread of state.threads) counts[thread.kind][states.indexOf(thread.state)]++;
  let previouslyFlagged = 0;
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry;
      try { entry = object(JSON.parse(line)); } catch { continue; }
      const message = object(entry.message);
      if (entry.type === "message" && message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && LIMIT_ERROR.test(string(message.errorMessage) || contentText(message.content))) previouslyFlagged++;
    }
  } finally { lines.close(); stream.destroy(); }
  for (const kind of ["agent", "job", "workflow"] as const) counts[kind].forEach((value, i) => totals[kind][i] += value);
  totals.scheduled += state.scheduled.length;
  totals.malformed += state.malformedLines;
  totals.normalMessagesPreviouslyFlagged += previouslyFlagged;
  console.log(`${basename(file)} agent=${counts.agent.join("/")} job=${counts.job.join("/")} workflow=${counts.workflow.join("/")} scheduled=${state.scheduled.length} malformed=${state.malformedLines} normalMessagesPreviouslyFlagged=${previouslyFlagged}`);
}
console.log(`TOTAL (${recent.length} files): ${JSON.stringify(totals)}`);
