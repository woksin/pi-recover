import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import defaultExtension, { createRecoverExtension } from "../src/extension.ts";
import { collect } from "../src/collector.ts";
import { RECOVERED_TYPE, RECOVERY_PROMPT_MARKER } from "../src/markers.ts";
import { parseArguments, readSession, resolveSession } from "../src/sessions.ts";
import { call, result, session, tempDir, fakePi, text, deferred } from "./helpers.ts";

async function setup(t: Parameters<typeof tempDir>[0], loose = true) {
  const dir = tempDir(t), file = join(dir, "session.jsonl");
  const entries: unknown[] = [session(dir), { type: "message", message: { role: "user", content: text("Finish the original task") } }];
  if (loose) entries.push(call("Agent", "a", { description: "Recover me", prompt: "Verbatim\nprompt", subagent_type: "implementer" }), result("Agent", "a", "Agent ID: agent-open"));
  await writeFile(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const fake = fakePi(dir, file);
  return { dir, file, entries, fake, options: { home: dir, probe: noProbe, onBackgroundTask: fake.trackBackground } };
}
const noProbe = async () => ({ repos: [], notes: [] });
const limitEvent = { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Usage limit reached" } };
const reportPath = (note: string) => note.match(/recovery report: (.+?)(?: \(dry run.*)?$/)![1];

test("default factory registers without effects", () => {
  const fake = fakePi("/example");
  defaultExtension(fake.pi as any);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.notes.length, 0);
});

test("--dry writes real report and original prompt without injection or recovered marker", async t => {
  const { fake, options } = await setup(t);
  createRecoverExtension(options)(fake.pi as any);
  await fake.command("--dry");
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.appended.length, 0);
  assert.equal(fake.notes.length, 1);
  assert.match(await readFile(reportPath(fake.notes[0].text), "utf8"), /agent-open/);
  assert.match(fake.notes[0].text, /1 loose threads/);
});

test("default injects exactly one marked prompt then records the covered call IDs", async t => {
  const { fake, options } = await setup(t);
  createRecoverExtension(options)(fake.pi as any);
  await fake.command();
  assert.equal(fake.sent.length, 1);
  assert.deepEqual(fake.sent[0].options, { deliverAs: "followUp" });
  assert.ok(fake.sent[0].text.startsWith(RECOVERY_PROMPT_MARKER + "\n"));
  const report = reportPath(fake.notes[0].text);
  assert.ok(fake.sent[0].text.includes(report));
  assert.match(await readFile(report, "utf8"), /Recover me/);
  assert.equal(fake.appended[0].customType, RECOVERED_TYPE);
  assert.deepEqual(fake.appended[0].data.callIds, ["a"]);
  assert.equal(fake.appended[0].data.reportPath, report);
  assert.ok(!Number.isNaN(Date.parse(fake.appended[0].data.at)));
});

test("later /recover and a new --continue hint exclude superseded work and preserve original request", async t => {
  const { file, fake, options } = await setup(t);
  createRecoverExtension(options)(fake.pi as any);
  await fake.command();
  await fake.command();
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.appended.length, 1);
  assert.match(fake.notes[1].text, /nothing to recover; 0 live; 1 superseded/);
  const state = await readSession(file);
  assert.equal(state.lastUserRequest, "Finish the original task");
  assert.equal(state.threads[0].state, "superseded");
  const continued = fakePi(fake.ctx.cwd, file);
  createRecoverExtension({ ...options, onBackgroundTask: continued.trackBackground })(continued.pi as any);
  await continued.emit("session_start", { type: "session_start", reason: "startup" });
  await continued.drain();
  assert.equal(continued.notes.length, 0);
});

test("a queued prompt lost before delivery leaves work recoverable, including external files", async t => {
  for (const external of [false, true]) {
    const { dir, file, fake: current, options } = await setup(t);
    const fake = external ? fakePi(dir) : current;
    fake.pi.sendUserMessage = (value, sendOptions) => { fake.sent.push({ text: value, options: sendOptions }); };
    createRecoverExtension({ ...options, onBackgroundTask: fake.trackBackground })(fake.pi as any);
    await fake.command(external ? file : "");
    await fake.command(external ? file : "");
    assert.equal(fake.sent.length, 2);
    assert.equal(fake.appended.length, 2);
    assert.match(fake.notes[1].text, /^1 loose threads; 0 live; 0 superseded/);
    assert.equal((await readSession(file)).threads[0].state, "unfinished");
  }
});

test("a current-file prompt preceding its receipt is not confirmed by duplicate extra entries", async t => {
  const { fake, options } = await setup(t);
  fake.persist({ type: "message", message: { role: "user", content: `${RECOVERY_PROMPT_MARKER}\nRecovery report: "/example/report.md"` } });
  fake.persist({ type: "custom", customType: RECOVERED_TYPE, data: { reportPath: "/example/report.md", callIds: ["a"] } });
  createRecoverExtension(options)(fake.pi as any);
  await fake.command("--dry");
  assert.match(fake.notes[0].text, /^1 loose threads; 0 live; 0 superseded/);
});

test("live agents, jobs and workflows are separate and excluded from injection and markers", async t => {
  const { fake, options } = await setup(t);
  createRecoverExtension(options)(fake.pi as any);
  await fake.emit("session_start", { type: "session_start", reason: "startup" });
  await fake.drain();
  fake.notes.length = 0;
  fake.persist(call("Agent", "live-agent", { description: "Live agent", prompt: "Do not relaunch" }));
  fake.persist(result("Agent", "live-agent", "Agent ID: agent-live"));
  fake.persist(call("job_watch", "live-job", { check: "true", label: "Live watch" }));
  fake.persist(result("job_watch", "live-job", "Started watch j1"));
  fake.persist(call("SubagentWorkflow", "live-workflow", { name: "Live workflow" }));
  fake.persist(result("SubagentWorkflow", "live-workflow", "Task ID: wf_live"));
  await fake.command();
  assert.match(fake.notes[0].text, /1 loose threads; 3 live/);
  const report = await readFile(reportPath(fake.notes[0].text), "utf8");
  assert.doesNotMatch(report.split("## Live threads")[0], /Live agent|Live watch|Live workflow/);
  assert.match(report, /## Live threads \(do not relaunch\)/);
  assert.match(report, /agent-live/);
  assert.match(report, /wf_live/);
  assert.deepEqual(fake.appended[0].data.callIds, ["a"]);
  assert.doesNotMatch(fake.sent[0].text, /agent-live|wf_live|Live watch/);
  assert.doesNotMatch(fake.sent[0].text, /from it are dead/);
});

test("live-only current sessions, including an explicit symlink target, write a report but do not inject", async t => {
  const { dir, file, fake, options } = await setup(t, false);
  createRecoverExtension(options)(fake.pi as any);
  await fake.emit("session_start", { type: "session_start", reason: "new" });
  fake.persist(call("job_start", "live", { command: "true" }));
  fake.persist(result("job_start", "live", "Started job j1"));
  const alias = join(dir, "alias.jsonl");
  await symlink(file, alias);
  await fake.command(alias);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.appended.length, 0);
  assert.match(fake.notes[0].text, /nothing to recover; 1 live/);
  assert.match(await readFile(reportPath(fake.notes[0].text), "utf8"), /Started in this process/);
});

test("reload kills prior work: existing threads stay loose and are injected", async t => {
  const { fake, options } = await setup(t);
  createRecoverExtension(options)(fake.pi as any);
  await fake.emit("session_start", { type: "session_start", reason: "reload" });
  await fake.command();
  assert.equal(fake.sent.length, 1);
  assert.match(fake.notes[0].text, /^1 loose thread.*; 0 live/);
});

test("a second session_start resets the boundary so earlier live work becomes loose", async t => {
  const { fake, options } = await setup(t);
  createRecoverExtension(options)(fake.pi as any);
  await fake.emit("session_start", { type: "session_start", reason: "new" });
  fake.persist(call("job_start", "live", { command: "true" }));
  fake.persist(result("job_start", "live", "Started job j1"));
  await fake.emit("session_start", { type: "session_start", reason: "reload" });
  await fake.command("--dry");
  assert.match(fake.notes[0].text, /^2 loose threads; 0 live/);
});

test("zero threads gives notify only, without probe or files", async t => {
  const { dir, fake, options } = await setup(t, false);
  createRecoverExtension({ ...options, probe: async () => { throw new Error("Must not probe"); } })(fake.pi as any);
  await fake.command("--dry");
  assert.deepEqual(fake.notes, [{ text: "nothing to recover", level: "info" }]);
  assert.equal(fake.sent.length, 0);
  assert.deepEqual(await readdir(dir), ["session.jsonl"]);
});

test("ambiguous id prefix lists at most ten candidates and remaining count", async t => {
  const { dir, fake, options } = await setup(t);
  const root = join(dir, "sessions"), sub = join(root, "cwd");
  await mkdir(sub, { recursive: true });
  const files = Array.from({ length: 13 }, (_, i) => join(sub, `date_abc${String(i).padStart(3, "0")}.jsonl`));
  for (const file of files) await writeFile(file, JSON.stringify(session(dir)));
  createRecoverExtension({ ...options, sessionsRoot: root })(fake.pi as any);
  await fake.command("abc");
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.notes[0].level, "error");
  assert.match(fake.notes[0].text, /Ambiguous session id prefix abc/);
  files.slice(0, 10).forEach(file => assert.ok(fake.notes[0].text.includes(file)));
  files.slice(10).forEach(file => assert.ok(!fake.notes[0].text.includes(file)));
  assert.match(fake.notes[0].text, /and 3 more/);
});

test("external path recovery into a new session records a receipt there and does not repeat", async t => {
  const { dir, file } = await setup(t);
  const fake = fakePi(join(dir, "new-session"));
  createRecoverExtension({ home: dir, probe: noProbe, onBackgroundTask: fake.trackBackground })(fake.pi as any);
  await fake.emit("session_start", { type: "session_start", reason: "new" });
  await fake.command(`--dry "${file}"`);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.appended.length, 0);
  await fake.command(file);
  await fake.command(file);
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.appended.length, 1);
  assert.match(fake.notes[2].text, /1 superseded/);
});

test("session_start resume/startup hint only; new/reload/fork do not notify or write", async t => {
  for (const reason of ["resume", "startup", "new", "reload", "fork"]) {
    const { dir, fake, options } = await setup(t);
    createRecoverExtension({ ...options, probe: async () => { throw new Error("Must not probe"); } })(fake.pi as any);
    await fake.emit("session_start", { type: "session_start", reason });
    await fake.drain();
    assert.equal(fake.notes.length, ["resume", "startup"].includes(reason) ? 1 : 0);
    if (fake.notes.length) assert.match(fake.notes[0].text, /1 loose threads from the previous run. Run \/recover/);
    assert.equal(fake.sent.length, 0);
    assert.deepEqual(await readdir(dir), ["session.jsonl"]);
  }
});

test("session_start returns before its read resolves, with no early notification", async t => {
  const { fake, options, entries } = await setup(t);
  const scan = deferred<ReturnType<typeof collect>>();
  createRecoverExtension({ ...options, readSession: () => scan.promise })(fake.pi as any);
  try {
    await fake.emit("session_start", { type: "session_start", reason: "resume" });
    assert.equal(fake.notes.length, 0);
  } finally { scan.resolve(collect(entries)); await fake.drain(); }
  assert.equal(fake.notes.length, 1);
});

test("fresh/finished session starts notify nothing", async t => {
  const { dir, file } = await setup(t, false);
  for (const saved of [undefined, file]) {
    const fake = fakePi(dir, saved);
    createRecoverExtension({ home: dir, onBackgroundTask: fake.trackBackground })(fake.pi as any);
    await fake.emit("session_start", { type: "session_start", reason: "startup" });
    await fake.drain();
    assert.equal(fake.notes.length, 0);
  }
});

test("checkpoint before persistence includes only the errorMessage and throttles synchronously", async t => {
  const { fake, options } = await setup(t);
  let time = Date.parse("2026-01-01T00:00:00Z");
  const saves: any[] = [];
  createRecoverExtension({ ...options, now: () => time, writeReport: async state => { saves.push(state); return "/example/report.md"; } })(fake.pi as any);
  await Promise.all([fake.emit("message_end", limitEvent), fake.emit("message_end", limitEvent)]);
  await fake.drain();
  time += 299_999;
  await fake.emit("message_end", limitEvent);
  await fake.drain();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].endedOnError, true);
  assert.equal(saves[0].errorText, "Usage limit reached");
  time += 1;
  await fake.emit("message_end", limitEvent);
  await fake.drain();
  assert.equal(saves.length, 2);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.notes.length, 0);
});

test("message_end returns before a held probe resolves and suppresses overlapping checkpoints", async t => {
  const { fake, options } = await setup(t);
  const entered = deferred(), held = deferred<Awaited<ReturnType<typeof noProbe>>>();
  let saved = false;
  createRecoverExtension({ ...options, probe: async () => { entered.resolve(); return held.promise; }, writeReport: async () => { saved = true; return "/report.md"; } })(fake.pi as any);
  try {
    await fake.emit("message_end", limitEvent);
    await entered.promise;
    assert.equal(saved, false);
    await fake.emit("message_end", limitEvent);
  } finally { held.resolve({ repos: [], notes: [] }); await fake.drain(); }
  assert.equal(saved, true);
});

test("checkpoint writes a report only for terminal errors whose errorMessage matches limits", async t => {
  const { dir, fake, options } = await setup(t);
  createRecoverExtension(options)(fake.pi as any);
  for (const message of [
    { role: "user", content: "429" },
    { role: "assistant", stopReason: "error", errorMessage: "unrelated network error", content: text("HTTP 429") },
    { role: "assistant", stopReason: "stop", content: text("quota, 429 and rate limit are normal discussion"), errorMessage: "HTTP 429" },
  ]) await fake.emit("message_end", { type: "message_end", message });
  await fake.drain();
  assert.deepEqual(await readdir(dir), ["session.jsonl"]);
  await fake.emit("message_end", limitEvent);
  await fake.drain();
  const roots = await readdir(join(dir, ".ai-work", "recover"));
  assert.equal(roots.length, 1);
  assert.match(await readFile(join(dir, ".ai-work", "recover", roots[0], "report.md"), "utf8"), /Usage limit reached/);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.notes.length, 0);
});

test("checkpoints also protect new live work", async t => {
  const { fake, options } = await setup(t, false);
  const saves: any[] = [];
  createRecoverExtension({ ...options, writeReport: async state => { saves.push(state); return "/report.md"; } })(fake.pi as any);
  await fake.emit("session_start", { type: "session_start", reason: "new" });
  fake.persist(call("job_watch", "live", { check: "true" }));
  fake.persist(result("job_watch", "live", "Started watch j1"));
  await fake.emit("message_end", limitEvent);
  await fake.drain();
  assert.equal(saves[0].threads[0].state, "live");
});

test("all handlers contain failures, including detached rejection and throwing UI", async t => {
  const dir = tempDir(t), fake = fakePi(dir, join(dir, "missing.jsonl"));
  createRecoverExtension({ home: dir, probe: noProbe, onBackgroundTask: fake.trackBackground })(fake.pi as any);
  await fake.command();
  assert.match(fake.notes[0].text, /Recovery failed/);
  await fake.emit("session_start", { type: "session_start", reason: "resume" });
  await fake.emit("message_end", limitEvent);
  await fake.drain();
  fake.ctx.ui.notify = () => { throw new Error("UI gone"); };
  await assert.doesNotReject(fake.command());
});

test("report/send failures never append a recovered marker", async t => {
  for (const failure of ["report", "send"]) {
    const { fake, options } = await setup(t);
    if (failure === "send") fake.pi.sendUserMessage = () => { throw new Error("Session gone"); };
    createRecoverExtension(failure === "report" ? { ...options, writeReport: async () => { throw new Error("Disk full"); } } : options)(fake.pi as any);
    await fake.command();
    assert.equal(fake.appended.length, 0);
    assert.equal(fake.sent.length, 0);
    assert.equal(fake.notes.at(-1)!.level, "error");
  }
});

test("streaming reader skips malformed/truncated lines, handles a missing newline", async t => {
  const dir = tempDir(t), file = join(dir, "session.jsonl");
  await writeFile(file, [JSON.stringify(session(dir)), "malformed", JSON.stringify(call("Agent", "a")), '{"truncated":'].join("\n"));
  const state = await readSession(file);
  assert.equal(state.malformedLines, 2);
  assert.equal(state.threads[0].state, "interrupted");
});

test("argument parsing and session resolution accept quoted paths and unique id prefixes", async t => {
  const dir = tempDir(t), root = join(dir, "sessions"), sub = join(root, "cwd");
  await mkdir(sub, { recursive: true });
  const file = join(sub, "date_unique123.jsonl");
  await writeFile(file, JSON.stringify(session(dir, "unique123")));
  assert.deepEqual(parseArguments('--dry "/a path/file.jsonl"'), { dry: true, target: "/a path/file.jsonl" });
  assert.deepEqual(parseArguments("unique --dry"), { dry: true, target: "unique" });
  assert.equal(await resolveSession("unique", undefined, dir, root, dir), file);
  assert.equal(await resolveSession(undefined, file, dir, root, dir), file);
  assert.equal(await resolveSession("~/sessions/cwd/date_unique123.jsonl", undefined, dir, root, dir), file);
  await assert.rejects(resolveSession(undefined, undefined, dir, root, dir), /no saved file/);
  await assert.rejects(resolveSession("missing", file, dir, root, dir), /No session matches/);
  await assert.rejects(resolveSession("/missing.jsonl", file, dir, root, dir), /Session file not found/);
  assert.throws(() => parseArguments("--unknown"), /Usage/);
  assert.throws(() => parseArguments("two targets"), /Usage/);
});

test("a turn cut off by a provider error with only unacted results still recovers: report lists the results, prompt resumes", async t => {
  const dir = tempDir(t), file = join(dir, "session.jsonl");
  const entries: unknown[] = [session(dir), { type: "message", message: { role: "user", content: text("Ship PR-B") } },
    call("Agent", "a", { description: "PR-B", prompt: "Do PR-B" }), result("Agent", "a", "Agent ID: agent-b\nOutput file: /example/b.output"),
    { type: "message", message: { role: "assistant", content: text("waiting"), stopReason: "stop" } },
    { type: "custom", customType: "subagents:record", data: { id: "agent-b", status: "completed", result: "PR-B result text" } },
    { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate_limit_error" } }];
  await writeFile(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const fake = fakePi(dir, file);
  createRecoverExtension({ home: dir, probe: noProbe, onBackgroundTask: fake.trackBackground })(fake.pi as any);
  await fake.command();
  assert.match(fake.notes[0].text, /^no loose threads, turn cut off by a provider error, 1 results not acted on/);
  const report = await readFile(reportPath(fake.notes[0].text), "utf8");
  assert.match(report, /## Results not acted on[\s\S]*agent-b[\s\S]*Result text: .*results\/1-pr-b\.md/);
  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0].text, /never acted on/);
  assert.match(fake.sent[0].text, /No background work needs relaunching/);
  assert.match(fake.sent[0].text, /Ship PR-B/);
});

test("external provider-error recovery stops re-offering once the recovery prompt was answered successfully", async t => {
  const dir = tempDir(t), file = join(dir, "old.jsonl");
  const entries: unknown[] = [session(dir, "old-session"), { type: "message", message: { role: "user", content: text("Ship it") } },
    call("Agent", "a", { description: "PR", prompt: "Do it" }), result("Agent", "a", "Agent ID: agent-x"),
    { type: "message", message: { role: "assistant", content: text("waiting"), stopReason: "stop" } },
    { type: "custom", customType: "subagents:record", data: { id: "agent-x", status: "completed", result: "done" } },
    { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429" } }];
  await writeFile(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const fake = fakePi(dir);
  createRecoverExtension({ home: dir, probe: noProbe, onBackgroundTask: fake.trackBackground })(fake.pi as any);
  await fake.command(file);
  assert.equal(fake.sent.length, 1);
  await new Promise(resolve => setTimeout(resolve, 0));
  // Recovery reply failed again: still offered.
  fake.persist({ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429" } });
  await fake.command(file);
  assert.equal(fake.sent.length, 2);
  await new Promise(resolve => setTimeout(resolve, 0));
  // A successful reply to the recovery prompt acknowledges it.
  fake.persist({ type: "message", message: { role: "assistant", content: text("recovered"), stopReason: "stop" } });
  await fake.command(file);
  assert.equal(fake.sent.length, 2);
  assert.match(fake.notes.at(-1)!.text, /^nothing to recover/);
});

test("a workflow-id record is not mistaken for an agent completion", () => {
  const state = collect([call("SubagentWorkflow", "w"), result("SubagentWorkflow", "w", "Task ID: wf_x"),
    { type: "custom", customType: "subagents:record", data: { id: "wf_x", status: "error" } }]);
  assert.equal(state.threads[0].state, "failed");
});
