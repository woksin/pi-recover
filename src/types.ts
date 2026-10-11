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
  /** Entry index of the completion that finished this thread. */
  completionIndex?: number;
  /** Result text carried by the completion (subagent result), if any. */
  resultText?: string;
  /** The completion arrived after the last successful assistant reply: nobody acted on it. */
  unacted?: boolean;
}

export interface RecoveryState {
  sessionId: string;
  cwd: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  lastUserRequest: string;
  lastAssistantText: string;
  endedOnError: boolean;
  /** The last assistant message failed with a provider error (not a user abort): the turn was cut off. */
  endedOnProviderError: boolean;
  /** Entry index of the last assistant message that did not fail. */
  lastReplyIndex: number;
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

/** Finished threads whose results arrived after the last successful reply. */
export function unactedResults(state: RecoveryState): Thread[] {
  return state.threads.filter(thread => thread.unacted && thread.state === "finished");
}

/** The session was cut off mid-turn, or results are waiting that nobody acted on. */
export function needsResume(state: RecoveryState): boolean {
  return state.endedOnProviderError || unactedResults(state).length > 0;
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
