export type ThreadState = "finished" | "unfinished" | "interrupted";

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
  return state.threads.filter(thread => thread.state !== "finished");
}
