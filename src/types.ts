export type ThreadState = "finished" | "failed" | "unfinished" | "interrupted" | "live" | "superseded";

export interface Thread {
  kind: "agent" | "job" | "workflow";
  callId: string;
  id?: string;
  label: string;
  state: ThreadState;
  evidence: string;
  status?: string;
  startIndex: number;
  resultIndex?: number;
  args: Record<string, unknown>;
  description?: string;
  subagentType?: string;
  name?: string;
  prompt?: string;
  originalPrompt?: string;
  originalCallId?: string;
  originalAgentId?: string;
  isolation?: unknown;
  worktreePath?: string;
  resume?: string;
  outputFile?: string;
  scheduled?: unknown;
  foreground?: boolean;
  command?: string;
  cwd?: string;
  timeoutSeconds?: number;
  logPath?: string;
  startedAt?: number;
  scriptPath?: string;
  script?: string;
  workflowArgs?: unknown;
  resumeFromRunId?: string;
}

export interface RecoveryState {
  sessionId: string;
  cwd: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  lastUserRequest: string;
  lastAssistantText: string;
  endedOnError: boolean;
  errorText: string;
  malformedLines: number;
  threads: Thread[];
  scheduled: Thread[];
}

export interface RepoProbe {
  path: string;
  status: string;
  log: string;
  branch: string;
  upstream?: string;
  aheadBehind?: string;
  errors: string[];
}

export interface ProbeResult {
  repos: RepoProbe[];
  notes: string[];
}

export function looseThreads(state: RecoveryState): Thread[] {
  return state.threads.filter(thread => thread.state === "unfinished" || thread.state === "interrupted" || thread.state === "failed");
}

/** A startup snapshot of call IDs avoids JSONL/header/malformed-line index mismatches. */
export function protectLiveThreads(state: RecoveryState, priorCallIds: ReadonlySet<string> | undefined): void {
  if (!priorCallIds) return;
  for (const thread of looseThreads(state)) {
    // A failed thread has stopped; it cannot still be running in this process.
    if (thread.state === "failed" || priorCallIds.has(thread.callId)) continue;
    thread.state = "live";
    thread.evidence = "Started in this process; may still be running. Do not relaunch.";
  }
}
