import type { RecoveryState } from "./types.ts";

/** Read-only cooperation with pi-jobs; never reach into the npm subagent manager. */
export function protectAdoptedJobs(state: RecoveryState, sessionId: string): void {
  const owners = (globalThis as any)[Symbol.for("pi-jobs.sessionOwners.v1")];
  const manager = owners instanceof Map ? owners.get(sessionId)?.manager : undefined;
  if (!manager) return;
  for (const thread of state.threads) {
    if (thread.kind !== "job" || !thread.id || thread.state === "superseded") continue;
    const job = manager.get(thread.id);
    if (!job) continue;
    thread.state = job.status === "running" ? "live" : "finished";
    thread.status = job.status;
    thread.evidence = "Owned by pi-jobs in this process; do not relaunch. See /jobs.";
  }
}

/** History is the surviving source of ids; status is last recorded, not a live probe. */
export function subagentReloadNotice(state: RecoveryState): string | undefined {
  const agents = state.threads.filter(thread => thread.kind === "agent" && thread.id);
  if (!agents.length) return;
  return [
    "pi-recover: /reload aborted/disposed pi-subagents sessions and replaced their in-memory registry. These are the last recorded subagents (not live status):",
    ...agents.map(agent => `${agent.id} | ${agent.description || agent.label} | ${agent.status || agent.state} | output: ${agent.outputFile || "not recorded (may be disabled)"}`),
    "Existing output files remain readable, but may be partial. get_subagent_result and Agent resume by these ids no longer work. Persisted child sessions, when enabled, can be opened via /resume; otherwise use /recover to inspect and explicitly relaunch unfinished work. Do not assume any subagent survived.",
  ].join("\n");
}
