import type { RecoveryState } from "./types.ts";

/** Read-only cooperation with pi-jobs; never reach into the npm subagent manager. */
export function protectAdoptedJobs(state: RecoveryState, sessionId: string): void {
  const owners = (globalThis as any)[Symbol.for("pi-jobs.sessionOwners.v2")];
  const owner = owners instanceof Map ? owners.get(sessionId) : undefined;
  const manager = owner?.version === 2 ? owner.manager : undefined;
  if (typeof manager?.get !== "function") return;
  for (const thread of state.threads) {
    if (thread.kind !== "job" || !thread.id || thread.state === "superseded") continue;
    const job = manager.get(thread.id);
    if (!job || job.id !== thread.id) continue;
    const sameLog = !!thread.logPath && thread.logPath === job.logPath;
    const sameStart = thread.startedAt !== undefined && thread.startedAt === job.startedAt;
    if ((!sameLog && !sameStart)
      || (thread.logPath && job.logPath && thread.logPath !== job.logPath)
      || (thread.startedAt !== undefined && job.startedAt !== undefined && thread.startedAt !== job.startedAt)) continue;
    thread.state = job.status === "running" ? "live" : "finished";
    thread.status = job.status;
    thread.evidence = "Owned by pi-jobs in this process; do not relaunch. See /jobs.";
  }
}

/** History is the surviving source of ids; status is last recorded, not a live probe. */
export function subagentReloadNotice(state: RecoveryState): string | undefined {
  const agents = state.threads.filter(thread => thread.kind === "agent" && ["unfinished", "interrupted", "live"].includes(thread.state));
  if (!agents.length) return;
  return [
    "pi-recover: /reload aborted/disposed pi-subagents sessions and replaced their in-memory registry. These subagents were still open in the current branch before reload (last-recorded status, not live status):",
    ...agents.slice(0, 20).map(agent => `${agent.id || `(id not recorded; call ${agent.callId})`} | ${agent.description || agent.label} | ${agent.status || agent.state} | output: ${agent.outputFile || "not recorded (may be disabled)"}`),
    ...(agents.length > 20 ? [`…${agents.length - 20} more (full list in /recover).`] : []),
    "Existing output files remain readable, but may be partial. get_subagent_result and Agent resume by these ids no longer work. Persisted child sessions, when enabled, can be opened via /resume; otherwise use /recover to inspect and explicitly relaunch unfinished work. Do not assume any subagent survived.",
  ].join("\n");
}
