import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { collect } from "../src/collector.ts";
import { renderReport, recoveryPrompt, writeReport } from "../src/report.ts";
import { logTail } from "../src/logs.ts";
import { call, result, session, text, tempDir } from "./helpers.ts";

function synthetic(cwd: string) {
  return collect([session(cwd), { type: "message", message: { role: "user", content: text("Finish the original task") } },
    call("Agent", "agent", { description: "Small fix", subagent_type: "implementer", prompt: "Original prompt\nverbatim", name: "fixer", isolation: "/example/worktree", resume: "old-agent" }),
    result("Agent", "agent", "Agent ID: agent-1\nOutput file: /example/agent.output"),
    call("job_start", "job", { command: "gh run watch 42 --exit-status", cwd, timeoutSeconds: 120, label: "CI" }),
    result("job_start", "job", "Started job j1\nlog: /example/ci.log"),
    call("SubagentWorkflow", "workflow", { name: "review", scriptPath: "/example/review.js", args: { author: "test" } }),
    result("SubagentWorkflow", "workflow", "Task ID: wf_open"),
    call("Agent", "finished", { description: "Finished task", run_in_background: false }), result("Agent", "finished", "Done"),
    call("Agent", "schedule", { description: "Later task", schedule: { delay: "1h" } }),
    { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Rate limit exceeded" } },
  ]);
}

test("report rendering contains header, loose table/details, probes, finished summary and schedule", () => {
  const state = synthetic("/example/repo");
  const report = renderReport({ state, environment: { repos: [{ path: "/example/repo", branch: "feature", upstream: "origin/main", aheadBehind: "2\t1", status: "## feature...origin/main [ahead 2, behind 1]\n M source.ts", log: "abc123 commit", errors: [] }], notes: [] },
    promptFiles: new Map([["agent", "/reports/prompts/1-small-fix.md"]]), logTails: new Map([["job", "CI log tail"]]), sourceFile: "/sessions/synthetic.jsonl" });
  for (const fragment of ["# Pi recovery report", "Session: synthetic-session", "Rate limit exceeded", "Finish the original task",
    "| agent | agent-1 | Small fix | unfinished |", "| job | j1 | CI | unfinished |", "| workflow | wf_open | review | unfinished |",
    "Resume prompt file: /reports/prompts/1-small-fix.md", "Resume: old-agent", "isolation", "gh run watch 42 --exit-status", "CI log tail",
    "Run ID: wf_open", "/example/review.js", '"author": "test"', "Branch: feature; upstream: origin/main", "2\t1", "abc123 commit",
    "## Finished threads", "Finished task", "## Scheduled agents (not restartable automatically)", "Later task"]) {
    assert.ok(report.toLowerCase().includes(fragment.toLowerCase()), fragment);
  }
  assert.doesNotMatch(report.split("## Thread details")[0], /Finished task/);
  assert.match(report, /try resumeFromRunId wf_open \(same session only\)/);
  assert.match(report, /re-watch CI by run id after checking current state/);
});

test("saved prompts are exact, reports/log tails private, duplicate timestamp does not overwrite", async t => {
  const dir = tempDir(t), state = synthetic(dir);
  const log = join(dir, "ci.log");
  await writeFile(log, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  state.threads.find(thread => thread.kind === "job")!.logPath = log;
  const opts = { home: dir, now: new Date("2026-01-01T00:00:00.000Z") };
  const file = await writeReport(state, { repos: [], notes: [] }, opts);
  const report = await readFile(file, "utf8");
  assert.match(file, /\.ai-work\/recover\/synthetic-se-2026-01-01T00-00-00.000Z\/report.md$/);
  const prompt = report.match(/Resume prompt file: (.+)/)![1];
  assert.equal(await readFile(prompt, "utf8"), "Original prompt\nverbatim");
  assert.match(report, /line 31\n/);
  assert.doesNotMatch(report, /line 30\n/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(prompt)).mode & 0o777, 0o600);
  const other = await writeReport(state, { repos: [], notes: [] }, opts);
  assert.notEqual(other, file);
  assert.equal(await readFile(file, "utf8"), report);
});

test("fallback uses home when the session .ai-work cannot be created", async t => {
  const dir = tempDir(t), cwd = join(dir, "cwd"), home = join(dir, "home");
  await mkdir(cwd);
  await writeFile(join(cwd, ".ai-work"), "test-owned obstacle");
  const file = await writeReport(synthetic(cwd), { repos: [], notes: [] }, { home, tail: async () => "missing" });
  assert.ok(file.startsWith(join(home, ".ai-work", "recover")));
});

test("table cells and code fences cannot break the report layout", () => {
  const state = synthetic("/example/repo");
  state.threads[0].label = "label | <x>\nnext";
  state.lastUserRequest = "```\n# arbitrary text\n```";
  const report = renderReport({ state, environment: { repos: [], notes: [] }, promptFiles: new Map(), logTails: new Map() });
  assert.match(report, /label \\?\| &lt;x&gt; next/);
  assert.match(report, /````\n```\n# arbitrary text\n```\n````/);
});

test("log tail is byte/line bounded and reports missing/nonregular files", async t => {
  const dir = tempDir(t), file = join(dir, "log");
  await writeFile(file, "x".repeat(30_000));
  assert.ok(Buffer.byteLength(await logTail(file)) <= 8192);
  await writeFile(file, Array.from({ length: 100 }, (_, i) => `${i}`).join("\n"));
  assert.equal((await logTail(file)).split("\n").length, 20);
  assert.match(await logTail(join(dir, "missing")), /log unavailable/);
  assert.match(await logTail(dir), /not a regular file/);
});

test("recovery prompt preserves safeguards, report path, original task, 300-char continuation", () => {
  const state = synthetic("/example/repo");
  state.lastUserRequest = "u".repeat(400);
  const prompt = recoveryPrompt(state, "/reports/report.md");
  for (const fragment of ["Rate limit exceeded", "their old IDs may no longer work", "/reports/report.md", "check reality first", "gh pr list --author @me", "issue_work list", "resumeFromRunId, same session only", "original worktrees", "Never create duplicate", "Reconcile issue statuses", "short table"]) assert.ok(prompt.includes(fragment), fragment);
  assert.ok(prompt.endsWith("u".repeat(300)));
  assert.doesNotMatch(prompt, /u{301}/);
});
