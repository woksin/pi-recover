import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, assistantError } from "../src/collector.ts";
import { looseThreads, protectLiveThreads } from "../src/types.ts";
import { RECOVERED_TYPE, RECOVERY_PROMPT_MARKER } from "../src/markers.ts";
import { call, result, session, notification, jobCompletion, text } from "./helpers.ts";

const agentArgs = { description: "Implement small fix", subagent_type: "implementer", name: "fixer", prompt: "Full\noriginal prompt", isolation: "worktree" };
const agentResult = (callId: string, id: string) => result("Agent", callId, `Agent started in background.\nAgent ID: ${id}\nOutput file: /example/${id}.output`);

test("agents: terminal record, unfinished background default, interrupted, foreground, resumed", () => {
  const state = collect([
    session(), call("Agent", "a1", agentArgs), agentResult("a1", "agent-1"),
    { type: "custom", customType: "subagents:record", data: { id: "agent-1", status: "completed" } },
    call("Agent", "a2", agentArgs), agentResult("a2", "agent-2"),
    call("Agent", "a3", agentArgs),
    call("Agent", "a4", { ...agentArgs, run_in_background: false }), result("Agent", "a4", "Done", { agentId: "fg" }),
    call("Agent", "a5", { ...agentArgs, resume: "agent-1" }), agentResult("a5", "agent-1"),
  ]);
  assert.deepEqual(state.threads.map(t => t.state), ["finished", "unfinished", "interrupted", "finished", "unfinished"]);
  const thread = state.threads[1];
  assert.equal(thread.description, agentArgs.description);
  assert.equal(thread.subagentType, "implementer");
  assert.equal(thread.name, "fixer");
  assert.equal(thread.prompt, agentArgs.prompt);
  assert.equal(thread.isolation, "worktree");
  assert.equal(thread.outputFile, "/example/agent-2.output");
  assert.equal(state.threads[4].resume, "agent-1");
});

test("completed records finish an agent; error/aborted/stopped are failed and loose; running/steered stay unfinished", () => {
  const expected: Record<string, string> = { completed: "finished", error: "failed", aborted: "failed", stopped: "failed", running: "unfinished", queued: "unfinished", steered: "unfinished" };
  for (const [status, want] of Object.entries(expected)) {
    const state = collect([call("Agent", "a1"), agentResult("a1", "agent-1"),
      { type: "custom", customType: "subagents:record", data: { id: "agent-1", status } }]);
    assert.equal(state.threads[0].state, want, status);
    assert.equal(looseThreads(state).length, want === "finished" ? 0 : 1, status);
  }
});

test("a subagent killed by a 429 (error record plus Error notification) is a failed, loose thread that is never protected as live", () => {
  const state = collect([
    call("Agent", "a1", agentArgs), agentResult("a1", "agent-1"),
    { type: "custom", customType: "subagents:record", data: { id: "agent-1", status: "error", result: "partial" } },
    notification("agent-1", 'Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', "a1"),
    call("Agent", "a2", agentArgs), agentResult("a2", "agent-2"), notification("agent-2", "Done", "a2"),
  ]);
  assert.deepEqual(state.threads.map(t => t.state), ["failed", "finished"]);
  assert.match(state.threads[0].evidence, /rate_limit_error/);
  protectLiveThreads(state, new Set());
  assert.deepEqual(looseThreads(state).map(t => t.callId), ["a1"]);
});

test("grouped subagent notifications finish their matching task; early notification is supported", () => {
  const state = collect([
    call("Agent", "a1"), call("Agent", "a2"),
    { type: "custom_message", customType: "subagent-notification", content: `${notification("agent-1").content}\n${notification("agent-2", "Error: synthetic failure").content}` },
    agentResult("a1", "agent-1"), agentResult("a2", "agent-2"),
  ]);
  assert.deepEqual(state.threads.map(t => t.state), ["finished", "failed"]);
  assert.equal(state.threads[1].status, "Error: synthetic failure");
});

test("old notifications cannot finish a resumed agent; call-id disambiguates", () => {
  const state = collect([call("Agent", "a1"), agentResult("a1", "agent-1"), notification("agent-1", "Done", "a1"),
    call("Agent", "a2", { resume: "agent-1" }), agentResult("a2", "agent-1"), notification("agent-1", "Done", "a1")]);
  assert.deepEqual(state.threads.map(t => t.state), ["finished", "unfinished"]);
});

test("plain-text rejected resumes do not create phantom loose agents", () => {
  for (const message of ['Agent not found: "old". It may have been cleaned up.', 'Agent "old" has no active session to resume.', 'Failed to resume agent "old".', 'Agent "old" is still running — it can only be resumed once its current run finishes.']) {
    const rejected = result("Agent", "resume", message);
    Object.assign(rejected.message, { isError: false });
    const state = collect([call("Agent", "resume", { ...agentArgs, resume: "old" }), rejected]);
    assert.equal(state.threads[0].state, "finished");
    assert.equal(state.threads[0].status, "not-started");
  }
  assert.equal(collect([call("Agent", "unknown", agentArgs), result("Agent", "unknown", "Unknown result format")]).threads[0].state, "unfinished");
});

test("scheduled agents are separate, never loose/restart candidates", () => {
  const schedule = { delay: "10m" };
  const state = collect([call("Agent", "scheduled", { ...agentArgs, schedule }), result("Agent", "scheduled", "Scheduled")]);
  assert.equal(state.threads.length, 0);
  assert.equal(looseThreads(state).length, 0);
  assert.equal(state.scheduled[0].scheduled, schedule);
});

test("job starts and watches finish by later messages; unfinished and interrupted jobs retain arguments", () => {
  const state = collect([
    session(), call("job_start", "j1-call", { command: "gh run watch 42 --exit-status", cwd: "/example/worktree", label: "CI", timeoutSeconds: 100 }),
    result("job_start", "j1-call", "Started job j1 (CI)\nlog: /example/j1.log"), jobCompletion("j1"),
    call("job_watch", "j2-call", { check: "test -e ready", timeoutSeconds: 90 }),
    result("job_watch", "j2-call", "Started watch j2\nlog: /example/j2.log"),
    { type: "custom_message", customType: "pi-jobs", content: text("Watch j2 matched: ready") },
    call("job_start", "j3-call", { command: "npm test", timeoutSeconds: 120 }), result("job_start", "j3-call", "", { id: "j3", logPath: "/example/j3.log", cwd: "/example/repo" }),
    call("job_watch", "j4-call", { check: "true", timeoutSeconds: 120 }),
  ]);
  assert.deepEqual(state.threads.map(t => t.state), ["finished", "finished", "unfinished", "interrupted"]);
  assert.equal(state.threads[0].command, "gh run watch 42 --exit-status");
  assert.equal(state.threads[0].cwd, "/example/worktree");
  assert.equal(state.threads[0].timeoutSeconds, 100);
  assert.equal(state.threads[1].command, "test -e ready");
  assert.equal(state.threads[2].logPath, "/example/j3.log");
});

test("job-id reuse after restart: completion before the new start does not finish it", () => {
  const state = collect([jobCompletion("j1"), call("job_start", "old"), result("job_start", "old", "Started job j1"), jobCompletion("j1"),
    call("job_start", "new"), result("job_start", "new", "Started job j1")]);
  assert.deepEqual(state.threads.map(t => t.state), ["finished", "unfinished"]);
});

test("batched job completion and delayed old completion match log/start identity", () => {
  const state = collect([
    call("job_start", "old"), result("job_start", "old", "", { id: "j1", logPath: "/logs/old.log", startedAt: 1 }),
    call("job_start", "new"), result("job_start", "new", "", { id: "j1", logPath: "/logs/new.log", startedAt: 2 }),
    call("job_watch", "watch"), result("job_watch", "watch", "", { id: "j2", logPath: "/logs/watch.log" }),
    { type: "custom_message", customType: "pi-jobs", details: { completions: [
      { job: { id: "j1", status: "succeeded", logPath: "/logs/old.log", startedAt: 1 } },
      { job: { id: "j2", status: "matched", logPath: "/logs/watch.log" } },
    ] } },
  ]);
  assert.deepEqual(state.threads.map(t => t.state), ["finished", "unfinished", "finished"]);
});

test("legacy batched job texts and every actual job terminal status finish", () => {
  const statuses = ["succeeded", "failed", "timed out", "timed_out", "timed-out", "killed", "matched"];
  const entries = statuses.flatMap((_, i) => [call("job_start", `c${i}`), result("job_start", `c${i}`, `Started job j${i + 1}`)]);
  entries.push({ type: "custom_message", customType: "pi-jobs", content: text(statuses.map((status, i) => `Job j${i + 1} ${status}: test`).join("\n\n")) } as any);
  assert.ok(collect(entries).threads.every(t => t.state === "finished"));
});

test("actual timed_out detail status and numbered legacy batch texts are terminal", () => {
  const state = collect([
    call("job_start", "a"), result("job_start", "a", "Started job j1"),
    call("job_watch", "b"), result("job_watch", "b", "Started watch j2"),
    { type: "custom_message", customType: "pi-jobs", content: text("[1/2] Job j1 timed out: test\n\n[2/2] Watch j2 matched: test") },
    call("job_watch", "c"), result("job_watch", "c", "Started watch j3"),
    { type: "custom_message", customType: "pi-jobs", details: { completions: [{ job: { id: "j3", status: "timed_out" } }] } },
  ]);
  assert.ok(state.threads.every(t => t.state === "finished"));
  assert.equal(state.threads[2].status, "timed_out");
});

test("job_kill result finishes job, failed kill does not", () => {
  for (const failed of [false, true]) {
    const kill = result("job_kill", "kill", "Stopped: j1 · job · killed", { id: "j1" });
    Object.assign(kill.message, { isError: failed });
    const state = collect([call("job_start", "start"), result("job_start", "start", "Started job j1"), call("job_kill", "kill", { id: "j1" }), kill]);
    assert.equal(state.threads[0].state, failed ? "unfinished" : "finished");
  }
});

test("workflows: finished notification, unfinished, interrupted, script/name/args/runId", () => {
  const args = { name: "review", args: { author: "synthetic" }, scriptPath: "/example/review.js", resumeFromRunId: "wf_old" };
  const state = collect([call("SubagentWorkflow", "w1", args), result("SubagentWorkflow", "w1", "Task ID: wf_done\nScript: /generated/script.js"), notification("wf_done"),
    call("SubagentWorkflow", "w2", args), result("SubagentWorkflow", "w2", "", { taskId: "wf_open" }),
    call("SubagentWorkflow", "w3", { script: "return 1;", args: [] }),
  ]);
  assert.deepEqual(state.threads.map(t => t.state), ["finished", "unfinished", "interrupted"]);
  assert.equal(state.threads[0].id, "wf_done");
  assert.equal(state.threads[0].scriptPath, "/generated/script.js");
  assert.equal(state.threads[1].resumeFromRunId, "wf_old");
  assert.deepEqual(state.threads[1].workflowArgs, args.args);
  assert.equal(state.threads[1].name, "review");
  assert.equal(state.threads[2].script, "return 1;");
});

test("stopped and error workflow notifications are failed (loose), synchronous errors are not restartable", () => {
  for (const status of ["Stopped", "Error: synthetic failure"]) {
    assert.equal(collect([call("SubagentWorkflow", "w"), result("SubagentWorkflow", "w", "Task ID: wf_test"), notification("wf_test", status)]).threads[0].state, "failed");
  }
  const rejected = result("Agent", "a", "Rejected input");
  Object.assign(rejected.message, { isError: true });
  assert.equal(collect([call("Agent", "a"), rejected]).threads[0].state, "finished");
  assert.equal(collect([call("SubagentWorkflow", "w"), result("SubagentWorkflow", "w", "Invalid script")]).threads[0].state, "finished");
});

test("malformed and truncated lines are counted; last user, assistant, timestamps and error captured", () => {
  const user = "u".repeat(2000);
  const state = collect([
    JSON.stringify(session()), "not json", "null", "[]", "{}", "", JSON.stringify({ type: "message", timestamp: "2026-01-01T01:00:00.000Z", message: { role: "user", content: text(user) } }),
    { type: "message", timestamp: "2026-01-01T02:00:00.000Z", message: { role: "assistant", content: text("Last answer"), stopReason: "stop" } },
    { type: "message", timestamp: "2026-01-01T03:00:00.000Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Usage limit reached" } },
    '{"type":"message"',
  ]);
  assert.equal(state.malformedLines, 5);
  assert.equal(state.sessionId, "synthetic-session");
  assert.equal(state.cwd, "/example/repo");
  assert.equal(state.lastUserRequest.length, 1500);
  assert.equal(state.lastAssistantText, "Last answer");
  assert.equal(state.firstTimestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(state.lastTimestamp, "2026-01-01T03:00:00.000Z");
  assert.equal(state.endedOnError, true);
  assert.equal(state.errorText, "Usage limit reached");
});

test("error-ending detection uses the final assistant, not any past error", () => {
  for (const error of ["usage limit", "rate_limit exceeded", "quota exhausted", "HTTP 429", "overloaded"]) {
    assert.equal(assistantError({ role: "assistant", content: text(error), errorMessage: error, stopReason: "stop" }), "");
    assert.equal(assistantError({ role: "assistant", content: text("Do not use content as the error"), errorMessage: error, stopReason: "error" }), error);
  }
  assert.equal(assistantError({ role: "assistant", content: [], stopReason: "aborted", errorMessage: "User aborted" }), "User aborted");
  assert.equal(assistantError({ role: "assistant", content: text("HTTP 429"), stopReason: "error" }), "");
  assert.equal(assistantError({ role: "user", content: text("rate limit") }), "");
  const state = collect([{ type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "429" } },
    { type: "message", message: { role: "assistant", stopReason: "stop", content: text("Recovered") } }]);
  assert.equal(state.endedOnError, false);
  assert.equal(state.errorText, "");
});
