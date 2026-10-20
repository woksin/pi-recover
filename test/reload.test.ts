import { test } from "node:test";
import assert from "node:assert/strict";
import { protectAdoptedJobs, subagentReloadNotice } from "../src/reload.ts";
import { collect } from "../src/collector.ts";
import { call, result } from "./helpers.ts";

function agents(count: number) {
  return collect(Array.from({ length: count }, (_, i) => [
    call("Agent", `call-${i}`, { description: `Task ${i}` }),
    result("Agent", `call-${i}`, `Agent ID: agent-${i}\nOutput file: /tmp/agent-${i}.output`),
  ]).flat());
}

test("reload notice excludes finished, superseded and failed agents, including unacted results", () => {
  const state = agents(6);
  const states = ["finished", "superseded", "failed", "unfinished", "interrupted", "live"] as const;
  state.threads.forEach((thread, i) => { thread.state = states[i]; thread.unacted = true; });
  const notice = subagentReloadNotice(state)!;
  for (const i of [0, 1, 2]) assert.doesNotMatch(notice, new RegExp(`agent-${i}`));
  for (const i of [3, 4, 5]) assert.match(notice, new RegExp(`agent-${i}`));
  state.threads = state.threads.slice(0, 3);
  assert.equal(subagentReloadNotice(state), undefined);
  assert.equal(subagentReloadNotice(agents(0)), undefined);
});

test("reload notice is capped at 20 open agents and points to the full recovery list", () => {
  const notice = subagentReloadNotice(agents(23))!;
  assert.equal(notice.split("\n").filter(line => line.startsWith("agent-")).length, 20);
  assert.match(notice, /agent-19 \| Task 19/);
  assert.doesNotMatch(notice, /agent-20/);
  assert.match(notice, /…3 more \(full list in \/recover\)/);
  assert.equal(agents(23).threads.length, 23);
});

test("job protection requires id plus a matching log path or start time, rejecting conflicting identities", t => {
  const key = Symbol.for("pi-jobs.sessionOwners.v2"), global = globalThis as any, saved = global[key];
  global[key] = new Map([["session", { version: 2, manager: {
    get: (id: string) => ({ id, logPath: "/tmp/current.log", startedAt: 200, status: "running" }),
  } }]]);
  t.after(() => { if (saved === undefined) delete global[key]; else global[key] = saved; });
  const cases = [
    [{}, "unfinished"],
    [{ logPath: "/tmp/old.log", startedAt: 100 }, "unfinished"],
    [{ logPath: "/tmp/current.log", startedAt: 100 }, "unfinished"],
    [{ logPath: "/tmp/old.log", startedAt: 200 }, "unfinished"],
    [{ logPath: "/tmp/current.log" }, "live"],
    [{ startedAt: 200 }, "live"],
    [{ logPath: "/tmp/current.log", startedAt: 200 }, "live"],
  ] as const;
  for (const [identity, expected] of cases) {
    const state = collect([call("job_start", "job", { command: "sleep 30" }), result("job_start", "job", "Started job j1", { id: "j1", ...identity })]);
    protectAdoptedJobs(state, "session");
    assert.equal(state.threads[0].state, expected, JSON.stringify(identity));
  }
});
