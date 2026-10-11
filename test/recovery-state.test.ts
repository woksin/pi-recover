import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { collect } from "../src/collector.ts";
import { RECOVERED_TYPE, RECOVERY_PROMPT_MARKER } from "../src/markers.ts";
import { renderReport, writeReport } from "../src/report.ts";
import { looseThreads, protectLiveThreads } from "../src/types.ts";
import { call, result, session, text, tempDir, notification } from "./helpers.ts";

const receipt = (...callIds: unknown[]) => ({ type: "custom", customType: RECOVERED_TYPE, data: { callIds, at: "2026-01-01T00:00:00Z" } });

test("startup identity boundary protects later starts, including interrupted calls, despite malformed lines", () => {
  const state = collect([
    session(), "malformed", call("Agent", "old"), result("Agent", "old", "Agent ID: old-agent"),
    call("Agent", "new-agent"), result("Agent", "new-agent", "Agent ID: new-agent"),
    call("job_start", "new-job"), result("job_start", "new-job", "Started job j1"),
    call("SubagentWorkflow", "new-workflow"),
    call("Agent", "finished", { run_in_background: false }), result("Agent", "finished", "Done"),
  ]);
  protectLiveThreads(state, new Set(["old"]));
  assert.deepEqual(state.threads.map(thread => thread.state), ["unfinished", "live", "live", "live", "finished"]);
  assert.deepEqual(looseThreads(state).map(thread => thread.callId), ["old"]);
  assert.match(state.threads[1].evidence, /may still be running. Do not relaunch/);
});

test("no boundary means prior-run behavior; a recovered receipt supersedes all covered kinds by call ID", () => {
  const state = collect([
    call("Agent", "a"), result("Agent", "a", "Agent ID: agent-1"),
    call("job_start", "j"), result("job_start", "j", "Started job j1"),
    call("SubagentWorkflow", "w"), result("SubagentWorkflow", "w", "Task ID: wf_test"),
    receipt("a", "j", "w", null, 42),
    call("job_start", "other-call"), result("job_start", "other-call", "Started job j1"),
  ]);
  protectLiveThreads(state, undefined);
  assert.deepEqual(state.threads.map(thread => thread.state), ["superseded", "superseded", "superseded", "unfinished"]);
  assert.deepEqual(looseThreads(state).map(thread => thread.callId), ["other-call"]);
  protectLiveThreads(state, new Set());
  assert.deepEqual(state.threads.map(thread => thread.state), ["superseded", "superseded", "superseded", "live"]);
});

test("receipt remains superseded after a later terminal notification; malformed receipts are ignored", () => {
  const state = collect([call("Agent", "a"), result("Agent", "a", "Agent ID: agent-1"), receipt("a"), notification("agent-1"),
    { type: "custom", customType: RECOVERED_TYPE, data: { callIds: null } }]);
  assert.equal(state.threads[0].state, "superseded");
  assert.equal(looseThreads(state).length, 0);
});

test("marked injected recovery prompts are ignored when choosing the last user request", () => {
  const state = collect([
    { type: "message", message: { role: "user", content: text("The original request") } },
    { type: "message", message: { role: "user", content: text(`${RECOVERY_PROMPT_MARKER}\nGenerated recovery instruction`) } },
    { type: "message", message: { role: "user", content: `${RECOVERY_PROMPT_MARKER}\nAnother generated recovery instruction` } },
  ]);
  assert.equal(state.lastUserRequest, "The original request");
  assert.equal(collect([{ type: "message", message: { role: "user", content: `Discuss ${RECOVERY_PROMPT_MARKER} as ordinary text` } }]).lastUserRequest, `Discuss ${RECOVERY_PROMPT_MARKER} as ordinary text`);
});

test("a terminal assistant with missing error text is still an error; normal quota text is not", () => {
  assert.equal(collect([{ type: "message", message: { role: "assistant", stopReason: "aborted", content: text("HTTP 429") } }]).endedOnError, true);
  const state = collect([{ type: "message", message: { role: "assistant", stopReason: "stop", content: text("HTTP 429 quota troubleshooting") } }]);
  assert.equal(state.endedOnError, false);
  assert.equal(state.errorText, "");
});

test("resumed agents retain the original spawn prompt through multiple resumes, even by alias", async t => {
  const dir = tempDir(t);
  const state = collect([
    session(dir), call("Agent", "spawn", { prompt: "Full original spawn\nprompt", name: "fixer" }), result("Agent", "spawn", "Agent ID: agent-1"), notification("agent-1", "Done", "spawn"),
    call("Agent", "resume-1", { prompt: "First continuation", resume: "fixer" }), result("Agent", "resume-1", "Agent ID: agent-1"), notification("agent-1", "Done", "resume-1"),
    call("Agent", "resume-2", { prompt: "Second continuation", description: "Resume fix", resume: "agent-1" }), result("Agent", "resume-2", "Agent ID: agent-1"),
  ]);
  const thread = state.threads[2];
  assert.equal(thread.originalPrompt, "Full original spawn\nprompt");
  assert.equal(thread.originalCallId, "spawn");
  assert.equal(thread.originalAgentId, "agent-1");
  const file = await writeReport(state, { repos: [], notes: [] }, { home: dir });
  const report = await readFile(file, "utf8");
  const resumeFile = report.match(/Resume prompt file: (.+)/)![1];
  const originalFile = report.match(/Original spawn prompt file: (.+); agent:/)![1];
  assert.notEqual(resumeFile, originalFile);
  assert.equal(await readFile(resumeFile, "utf8"), "Second continuation");
  assert.equal(await readFile(originalFile, "utf8"), "Full original spawn\nprompt");
  assert.equal((await stat(originalFile)).mode & 0o777, 0o600);
});

test("reports list live and superseded work separately, never as loose thread details", () => {
  const state = collect([call("Agent", "a", { description: "Superseded agent" }), receipt("a"), call("job_start", "j", { label: "Live job" })]);
  protectLiveThreads(state, new Set());
  const report = renderReport({ state, environment: { repos: [], notes: [] }, promptFiles: new Map(), logTails: new Map() });
  assert.doesNotMatch(report.split("## Live threads")[0], /Superseded agent|Live job/);
  assert.match(report, /## Live threads \(do not relaunch\)[\s\S]*Live job/);
  assert.match(report, /## Superseded threads[\s\S]*Superseded agent/);
});
