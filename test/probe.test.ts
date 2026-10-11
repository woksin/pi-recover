import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { collect } from "../src/collector.ts";
import { candidatePaths, probe } from "../src/probe.ts";
import { tempDir, session, call, result } from "./helpers.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}

test("probe uses a real temp git repo, dedupes subdirectories, preserves git state, makes no network calls", async t => {
  const dir = tempDir(t), repo = join(dir, "repo");
  await mkdir(join(repo, "sub"), { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Synthetic Tester");
  git(repo, "config", "user.email", "synthetic@example.invalid");
  await writeFile(join(repo, "source.txt"), "original\n");
  git(repo, "add", "source.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "branch", "upstream");
  git(repo, "branch", "--set-upstream-to=upstream");
  await writeFile(join(repo, "source.txt"), "second\n");
  git(repo, "commit", "-am", "second");
  await writeFile(join(repo, "source.txt"), "dirty\n");
  const before = git(repo, "status", "--porcelain=v1", "-b");
  const index = await readFile(join(repo, ".git", "index"));
  const state = collect([session(repo), call("job_start", "j", { command: "true", cwd: "sub" }), result("job_start", "j", "Started job j1")]);
  const output = await probe(state);
  assert.equal(output.repos.length, 1);
  assert.equal(output.repos[0].path, repo.replace(/^\/var\//, "/private/var/"));
  assert.equal(output.repos[0].branch, "main");
  assert.equal(output.repos[0].upstream, "upstream");
  assert.equal(output.repos[0].aheadBehind, "1\t0");
  assert.match(output.repos[0].status, / M source.txt/);
  assert.match(output.repos[0].log, /second\n.*base/);
  assert.equal(git(repo, "status", "--porcelain=v1", "-b"), before);
  assert.deepEqual(await readFile(join(repo, ".git", "index")), index);
  assert.equal(git(repo, "remote"), "");
});

test("candidate paths include isolation/worktrees, job cwd, absolute paths in loose prompts and commands", () => {
  const state = collect([session("/example/session"), call("Agent", "a", {
    prompt: 'Work in /example/repo and "/example/path with spaces". Ignore https://example.invalid/not-a-path.',
    isolation: "/example/isolation", worktreePath: "/example/worktree",
  }), call("job_start", "j", { cwd: "relative", command: "cd /example/command && true" }),
  call("Agent", "finished", { prompt: "Skip /example/finished", run_in_background: false }), result("Agent", "finished", "Done")]);
  const paths = candidatePaths(state);
  for (const path of ["/example/session", "/example/repo", "/example/path with spaces", "/example/isolation", "/example/worktree", "/example/session/relative", "/example/command"]) assert.ok(paths.includes(path), path);
  assert.ok(!paths.includes("/example/finished"));
  assert.ok(!paths.some(path => path.includes("example.invalid")));
});

test("mock probe caps 12 repos and 40 status lines; only read-only git commands, timeout <=10s", async () => {
  const state = collect([session("/r/0"), call("Agent", "a", { prompt: Array.from({ length: 30 }, (_, i) => `/r/${i}`).join(" ") })]);
  const commands: string[][] = [];
  const output = await probe(state, { isDirectory: async () => true, run: async (cwd, args, timeout) => {
    commands.push(args);
    assert.ok(timeout <= 10_000 && timeout > 0);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: cwd };
    if (args[0] === "status") return { stdout: Array.from({ length: 50 }, (_, i) => `?? f${i}`).join("\n") };
    if (args[0] === "symbolic-ref") return { stdout: "feature" };
    if (args[0] === "rev-parse") return { stdout: "", error: "No upstream" };
    return { stdout: "abc commit" };
  } });
  assert.equal(output.repos.length, 12);
  assert.equal(output.repos[0].status.split("\n").length, 40);
  assert.match(output.repos[0].errors[0], /truncated/);
  assert.ok(commands.every(args => ["rev-parse", "status", "log", "symbolic-ref", "rev-list"].includes(args[0])));
  assert.match(output.notes.join("\n"), /limit \(12\)/);
});

test("nonexistent dirs and nongit dirs are skipped; deadline limits commands and records incompleteness", async () => {
  const state = collect([session("/not-git"), call("Agent", "a", { prompt: "/missing /repo /another" })]);
  let time = 0;
  const calls: { cwd: string; timeout: number }[] = [];
  const output = await probe(state, { now: () => time, isDirectory: async path => path !== "/missing", run: async (cwd, args, timeout) => {
    calls.push({ cwd, timeout });
    time += timeout;
    if (cwd === "/not-git") return { stdout: "", error: "not a git repository" };
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: cwd };
    return { stdout: "", error: "timed out" };
  } });
  assert.ok(!calls.some(call => call.cwd === "/missing"));
  assert.ok(time < 30_000);
  assert.ok(calls.some(call => call.timeout < 10_000));
  assert.match(output.notes.join("\n"), /not a git repository/);
  assert.match(output.notes.join("\n"), /time budget exhausted/);
  assert.match(output.repos[0].errors.join("\n"), /Probe time budget exhausted/);
});
