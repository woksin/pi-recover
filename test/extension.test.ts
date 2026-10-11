import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import defaultExtension, { createRecoverExtension } from "../src/extension.ts";
import { parseArguments, readSession, resolveSession } from "../src/sessions.ts";
import { call, result, session, tempDir, fakePi } from "./helpers.ts";

async function setup(t: Parameters<typeof tempDir>[0], loose = true) {
  const dir = tempDir(t), file = join(dir, "session.jsonl");
  const entries = [session(dir)];
  if (loose) entries.push(call("Agent", "a", { description: "Recover me", prompt: "Verbatim\nprompt", subagent_type: "implementer" }) as any,
    result("Agent", "a", "Agent ID: agent-open") as any);
  await writeFile(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return { dir, file, entries, fake: fakePi(dir, file) };
}

const noProbe = async () => ({ repos: [], notes: [] });

test("default factory registers without effects", () => {
  const fake = fakePi("/example");
  defaultExtension(fake.pi as any);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.notes.length, 0);
});

test("--dry writes real report and original prompt without injection", async t => {
  const { dir, fake } = await setup(t);
  createRecoverExtension({ home: dir, probe: noProbe })(fake.pi as any);
  await fake.command("--dry");
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.notes.length, 1);
  const report = fake.notes[0].text.match(/recovery report: (.+) \(dry run/)![1];
  assert.match(await readFile(report, "utf8"), /agent-open/);
  assert.match(fake.notes[0].text, /1 loose threads/);
});

test("default writes report and injects exactly one user message", async t => {
  const { dir, fake } = await setup(t);
  createRecoverExtension({ home: dir, probe: noProbe })(fake.pi as any);
  await fake.command();
  assert.equal(fake.sent.length, 1);
  assert.deepEqual(fake.sent[0].options, { deliverAs: "followUp" });
  const report = fake.notes[0].text.match(/recovery report: (.+)/)![1];
  assert.ok(fake.sent[0].text.includes(report));
  assert.match(await readFile(report, "utf8"), /Recover me/);
});

test("zero loose threads gives notify only, without probe or files", async t => {
  const { dir, fake } = await setup(t, false);
  createRecoverExtension({ home: dir, probe: async () => { throw new Error("Must not probe"); } })(fake.pi as any);
  await fake.command("--dry");
  assert.deepEqual(fake.notes, [{ text: "nothing to recover", level: "info" }]);
  assert.equal(fake.sent.length, 0);
  assert.deepEqual(await readdir(dir), ["session.jsonl"]);
});

test("ambiguous id prefix lists candidates without writing or injecting", async t => {
  const { dir, fake } = await setup(t);
  const root = join(dir, "sessions"), sub = join(root, "cwd");
  await mkdir(sub, { recursive: true });
  const files = [join(sub, "2026-01-01T00-00-00_abc111.jsonl"), join(sub, "2026-01-01T00-00-00_abc222.jsonl")];
  for (const file of files) await writeFile(file, JSON.stringify(session(dir)));
  createRecoverExtension({ home: dir, sessionsRoot: root, probe: noProbe })(fake.pi as any);
  await fake.command("abc");
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.notes[0].level, "error");
  assert.match(fake.notes[0].text, /Ambiguous session id prefix abc/);
  files.forEach(file => assert.ok(fake.notes[0].text.includes(file)));
});

test("explicit external path recovers into a new unsaved session using source cwd", async t => {
  const { dir, file } = await setup(t);
  const fake = fakePi(join(dir, "new-session"));
  createRecoverExtension({ home: dir, probe: noProbe })(fake.pi as any);
  await fake.command(`--dry "${file}"`);
  assert.equal(fake.notes[0].level, "info");
  assert.match(fake.notes[0].text, /recovery report:/);
  assert.equal(fake.sent.length, 0);
});

test("session_start resume and startup hint only; new/reload/fork do nothing", async t => {
  for (const reason of ["resume", "startup", "new", "reload", "fork"]) {
    const { dir, fake } = await setup(t);
    createRecoverExtension({ home: dir, probe: async () => { throw new Error("Must not probe"); } })(fake.pi as any);
    await fake.emit("session_start", { type: "session_start", reason });
    assert.equal(fake.notes.length, ["resume", "startup"].includes(reason) ? 1 : 0);
    if (fake.notes.length) assert.match(fake.notes[0].text, /1 loose threads from the previous run. Run \/recover/);
    assert.equal(fake.sent.length, 0);
    assert.deepEqual(await readdir(dir), ["session.jsonl"]);
  }
});

test("fresh/finished session starts notify nothing", async t => {
  const { dir, file } = await setup(t, false);
  for (const saved of [undefined, file]) {
    const fake = fakePi(dir, saved);
    createRecoverExtension({ home: dir })(fake.pi as any);
    await fake.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(fake.notes.length, 0);
  }
});

test("checkpoint before error persistence includes the error and throttles for five minutes", async t => {
  const { dir, fake } = await setup(t);
  let time = Date.parse("2026-01-01T00:00:00Z");
  const saves: { state: any; options: any }[] = [];
  createRecoverExtension({ home: dir, now: () => time, probe: noProbe, writeReport: async (state, _probe, options) => {
    saves.push({ state, options }); return "/example/report.md";
  } })(fake.pi as any);
  const event = { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Usage limit reached" } };
  await Promise.all([fake.emit("message_end", event), fake.emit("message_end", event)]);
  time += 299_999;
  await fake.emit("message_end", event);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].state.endedOnError, true);
  assert.equal(saves[0].state.errorText, "Usage limit reached");
  time += 1;
  await fake.emit("message_end", event);
  assert.equal(saves.length, 2);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.notes.length, 0);
});

test("checkpoint really writes a report, but only for assistant usage/limit errors", async t => {
  const { dir, fake } = await setup(t);
  createRecoverExtension({ home: dir, probe: noProbe })(fake.pi as any);
  for (const message of [{ role: "user", content: "429" }, { role: "assistant", stopReason: "error", errorMessage: "unrelated network error" }, { role: "assistant", stopReason: "stop", content: [] }]) {
    await fake.emit("message_end", { type: "message_end", message });
  }
  assert.deepEqual(await readdir(dir), ["session.jsonl"]);
  await fake.emit("message_end", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 429 quota exhausted", content: [] } });
  const roots = await readdir(join(dir, ".ai-work", "recover"));
  assert.equal(roots.length, 1);
  assert.match(await readFile(join(dir, ".ai-work", "recover", roots[0], "report.md"), "utf8"), /HTTP 429 quota exhausted/);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.notes.length, 0);
});

test("all handlers contain failures, including missing session files and throwing UI", async t => {
  const dir = tempDir(t), fake = fakePi(dir, join(dir, "missing.jsonl"));
  createRecoverExtension({ home: dir, probe: noProbe })(fake.pi as any);
  await fake.command();
  assert.match(fake.notes[0].text, /Recovery failed/);
  await fake.emit("session_start", { type: "session_start", reason: "resume" });
  await fake.emit("message_end", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "quota exhausted" } });
  fake.ctx.ui.notify = () => { throw new Error("UI gone"); };
  await assert.doesNotReject(fake.command());
});

test("report failures never inject a recovery message", async t => {
  const { dir, fake } = await setup(t);
  createRecoverExtension({ home: dir, probe: noProbe, writeReport: async () => { throw new Error("Disk full"); } })(fake.pi as any);
  await fake.command();
  assert.equal(fake.sent.length, 0);
  assert.match(fake.notes[0].text, /Disk full/);
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
