import type { RecoveryState, Thread } from "./types.ts";

export const LIMIT_ERROR = /usage[\s_-]*limit|rate[\s_-]*limit|quota|\b429\b|overloaded/i;
const AGENT_TERMINAL = new Set(["completed", "error", "aborted", "stopped"]);
const JOB_TERMINAL = new Set(["succeeded", "failed", "timed_out", "timed out", "timed-out", "killed", "matched"]);

type ObjectData = Record<string, unknown>;
export function object(value: unknown): ObjectData {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectData : {};
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => object(part).type === "text" ? string(object(part).text) : "").filter(Boolean).join("\n");
}
export function assistantError(message: unknown): string {
  const m = object(message);
  if (m.role !== "assistant") return "";
  const text = string(m.errorMessage) || contentText(m.content);
  return m.stopReason === "error" || m.stopReason === "aborted" || LIMIT_ERROR.test(text)
    ? text || `Assistant stopped: ${string(m.stopReason)}` : "";
}

interface Completion {
  kind: "agent" | "job" | "workflow";
  id: string;
  index: number;
  status: string;
  callId?: string;
  logPath?: string;
  startedAt?: number;
}

function initialThread(call: ObjectData, index: number): Thread | undefined {
  const args = object(call.arguments);
  const tool = string(call.name);
  if (!["Agent", "job_start", "job_watch", "SubagentWorkflow"].includes(tool)) return;
  const base: Thread = {
    kind: tool === "Agent" ? "agent" : tool === "SubagentWorkflow" ? "workflow" : "job",
    callId: string(call.id), args, label: string(args.description) || string(args.label) || string(args.name) || tool,
    state: "interrupted", evidence: "No tool result recorded (unknown/interrupted)", startIndex: index,
  };
  if (base.kind === "agent") {
    Object.assign(base, {
      description: string(args.description), subagentType: string(args.subagent_type), name: string(args.name),
      prompt: string(args.prompt), isolation: args.isolation, resume: string(args.resume) || undefined,
      scheduled: args.schedule, foreground: args.run_in_background === false,
      worktreePath: string(args.worktreePath) || string(args.worktree) || undefined,
    });
  } else if (base.kind === "job") {
    Object.assign(base, {
      command: string(args.command) || string(args.check), cwd: string(args.cwd), timeoutSeconds: args.timeoutSeconds,
    });
  } else {
    Object.assign(base, {
      name: string(args.name), scriptPath: string(args.scriptPath), script: string(args.script),
      workflowArgs: args.args, resumeFromRunId: string(args.resumeFromRunId) || undefined,
    });
  }
  return base;
}

function finish(thread: Thread, status: string, evidence: string): void {
  thread.state = "finished";
  thread.status = status;
  thread.evidence = evidence;
}

function applyResult(thread: Thread, message: ObjectData, index: number): void {
  const text = contentText(message.content);
  const details = object(message.details);
  thread.resultIndex = index;
  thread.state = "unfinished";
  thread.evidence = "Start recorded; no later completion recorded";
  if (thread.kind === "agent") {
    thread.id = text.match(/Agent ID:\s*([^\s]+)/)?.[1] || string(details.agentId) || undefined;
    thread.outputFile = text.match(/Output file:\s*(.+)/)?.[1]?.trim() || string(details.outputFile) || undefined;
    thread.worktreePath ||= string(details.worktreePath) || text.match(/Worktree(?: path)?:\s*(.+)/i)?.[1]?.trim();
    if (thread.foreground) finish(thread, string(details.status) || "returned", "Foreground tool result recorded");
    // The installed Agent tool returns rejected resumes as plain text with isError=false.
    // These are completed calls, not background spawns; keep unknown results conservative.
    if (thread.resume && !thread.id && /^(?:Agent not found:|Failed to resume agent |Agent ".*" (?:has no active session|is still (?:running|queued)))/.test(text)) {
      finish(thread, "not-started", `Resume rejected: ${text.slice(0, 400)}`);
    }
  } else if (thread.kind === "job") {
    thread.id = string(details.id) || text.match(/Started (?:job|watch)\s+(j\d+)\b/)?.[1];
    thread.logPath = string(details.logPath) || text.match(/^log:\s*(.+)/m)?.[1]?.trim();
    thread.cwd = string(details.cwd) || thread.cwd;
    thread.startedAt = typeof details.startedAt === "number" ? details.startedAt : undefined;
    if (JOB_TERMINAL.has(string(details.status))) finish(thread, string(details.status), "Terminal job tool result recorded");
  } else {
    thread.id = text.match(/Task ID:\s*(wf_[\w-]+)/)?.[1] || string(details.taskId) || string(details.runId) || undefined;
    thread.scriptPath = text.match(/^Script:\s*(.+)/m)?.[1]?.trim() || thread.scriptPath;
    if (!thread.id && !/started in the background/i.test(text)) finish(thread, "returned", "Workflow result returned without a background task");
  }
  if (message.isError === true) finish(thread, "error", `Tool failed: ${text.slice(0, 400)}`);
}

function notificationCompletions(entry: ObjectData, index: number): Completion[] {
  const text = contentText(entry.content);
  // Grouped notifications contain several task-notification blocks.
  return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].flatMap(match => {
    const id = match[1].match(/<task-id>([^<]+)<\/task-id>/)?.[1];
    if (!id) return [];
    return [{
      kind: id.startsWith("wf_") ? "workflow" as const : "agent" as const,
      id, index, status: match[1].match(/<status>([^<]*)<\/status>/)?.[1] || "notification",
      callId: match[1].match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1],
    }];
  });
}

function jobCompletions(entry: ObjectData, index: number): Completion[] {
  const details = object(entry.details);
  const items = Array.isArray(details.completions) ? details.completions : [];
  const structured = items.flatMap(item => {
    const job = object(object(item).job);
    const id = string(job.id), status = string(job.status);
    return id && JOB_TERMINAL.has(status) ? [{
      kind: "job" as const, id, status, index, logPath: string(job.logPath) || undefined,
      startedAt: typeof job.startedAt === "number" ? job.startedAt : undefined,
    }] : [];
  });
  if (structured.length) return structured;
  return [...contentText(entry.content).matchAll(/^(?:\[\d+\/\d+\] )?(?:Job|Watch) (j\d+) (succeeded|failed|timed[_ -]out|killed|matched)\b/gm)]
    .map(match => ({ kind: "job", id: match[1], status: match[2], index }));
}

function matches(thread: Thread, completion: Completion): boolean {
  if (thread.kind !== completion.kind || thread.id !== completion.id || thread.startIndex >= completion.index) return false;
  if (completion.callId && completion.callId !== thread.callId) return false;
  if (completion.logPath && thread.logPath && completion.logPath !== thread.logPath) return false;
  if (completion.startedAt !== undefined && thread.startedAt !== undefined && completion.startedAt !== thread.startedAt) return false;
  return true;
}

/** Incremental reducer: no IO and no retention of bulky session messages or results. */
export class Collector {
  private state: RecoveryState = {
    sessionId: "unknown", cwd: "", lastUserRequest: "", lastAssistantText: "",
    endedOnError: false, errorText: "", malformedLines: 0, threads: [], scheduled: [],
  };
  private calls = new Map<string, Thread>();
  private kills = new Map<string, string>();
  private completions: Completion[] = [];
  private index = 0;

  add(input: unknown): void {
    const index = this.index++;
    let value = input;
    if (typeof input === "string") {
      if (!input.trim()) return;
      try { value = JSON.parse(input); } catch { this.state.malformedLines++; return; }
    }
    const entry = object(value);
    if (!string(entry.type)) { this.state.malformedLines++; return; }
    const timestamp = string(entry.timestamp);
    if (timestamp) {
      this.state.firstTimestamp ??= timestamp;
      this.state.lastTimestamp = timestamp;
    }
    if (entry.type === "session") {
      this.state.sessionId = string(entry.id) || this.state.sessionId;
      this.state.cwd = string(entry.cwd);
    } else if (entry.type === "message") {
      this.message(object(entry.message), index);
    } else if (entry.type === "custom" && entry.customType === "subagents:record") {
      const data = object(entry.data);
      if (AGENT_TERMINAL.has(string(data.status))) this.completions.push({
        kind: "agent", id: string(data.id), index, status: string(data.status),
      });
    } else if (entry.type === "custom_message" && entry.customType === "subagent-notification") {
      this.completions.push(...notificationCompletions(entry, index));
    } else if (entry.type === "custom_message" && entry.customType === "pi-jobs") {
      this.completions.push(...jobCompletions(entry, index));
    }
  }

  private message(message: ObjectData, index: number): void {
    if (message.role === "user") this.state.lastUserRequest = contentText(message.content).slice(0, 1500);
    if (message.role === "assistant") {
      const text = contentText(message.content);
      if (text) this.state.lastAssistantText = text;
      this.state.errorText = assistantError(message);
      this.state.endedOnError = Boolean(this.state.errorText);
      for (const item of Array.isArray(message.content) ? message.content : []) {
        const call = object(item);
        if (call.type !== "toolCall") continue;
        if (call.name === "job_kill") this.kills.set(string(call.id), string(object(call.arguments).id));
        const thread = initialThread(call, index);
        if (!thread) continue;
        this.calls.set(thread.callId, thread);
        (thread.scheduled != null && thread.scheduled !== false ? this.state.scheduled : this.state.threads).push(thread);
      }
    }
    if (message.role !== "toolResult") return;
    const callId = string(message.toolCallId);
    const thread = this.calls.get(callId);
    if (thread) applyResult(thread, message, index);
    const killedId = this.kills.get(callId);
    const killText = contentText(message.content);
    if (message.toolName === "job_kill" && message.isError !== true) {
      const id = string(object(message.details).id) || killedId || killText.match(/(?:Stopped:|Already finished:)\s*(j\d+)\b/)?.[1];
      if (id) this.completions.push({ kind: "job", id, index, status: "killed", logPath: string(object(message.details).logPath) || undefined });
    }
  }

  finish(): RecoveryState {
    for (const completion of this.completions) {
      // Latest eligible start only: jN can be reused after a process restart.
      const thread = this.state.threads.findLast(candidate => matches(candidate, completion));
      if (thread && thread.resultIndex !== undefined) finish(thread, completion.status, `Later ${completion.kind} completion recorded: ${completion.status}`);
    }
    return this.state;
  }
}

/** Accept parsed entries or raw JSONL lines; malformed/truncated lines are counted. */
export function collect(entries: Iterable<unknown>): RecoveryState {
  const collector = new Collector();
  for (const entry of entries) collector.add(entry);
  return collector.finish();
}
