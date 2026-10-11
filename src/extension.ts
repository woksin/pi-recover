import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { assistantError, LIMIT_ERROR } from "./collector.ts";
import { RECOVERED_TYPE } from "./markers.ts";
import { probe } from "./probe.ts";
import { recoveryPrompt, writeReport } from "./report.ts";
import { parseArguments, readSession, resolveSession } from "./sessions.ts";
import { looseThreads, protectLiveThreads } from "./types.ts";

export interface RecoverOptions {
  home?: string;
  sessionsRoot?: string;
  now?: () => number;
  probe?: typeof probe;
  writeReport?: typeof writeReport;
  readSession?: typeof readSession;
  /** Test seam for joining detached work without polling or delaying Pi's handlers. */
  onBackgroundTask?: (task: Promise<void>) => void;
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "error" = "info"): void {
  try { ctx.ui.notify(text, level); } catch { /* UI is optional; never break the session. */ }
}

function boundaryCallIds(ctx: ExtensionContext): Set<string> {
  const ids = new Set<string>();
  // getEntries() excludes the session header. Snapshot identities rather than line
  // offsets, which disagree with entry counts when a JSONL line is malformed.
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const part of entry.message.content) {
      if (part.type === "toolCall") ids.add(part.id);
    }
  }
  return ids;
}

export function createRecoverExtension(options: RecoverOptions = {}) {
  return function recoverExtension(pi: ExtensionAPI): void {
    const home = options.home ?? homedir();
    const sessionsRoot = options.sessionsRoot ?? join(home, ".pi", "agent", "sessions");
    const now = options.now ?? Date.now;
    const inspect = options.probe ?? probe;
    const save = options.writeReport ?? writeReport;
    const load = options.readSession ?? readSession;
    const checkpointTimes = new Map<string, number>();
    const boundaries = new Map<string, Set<string>>();
    const background = (work: () => Promise<void>): void => {
      const task = work().catch(() => { /* Best effort; never break the session. */ });
      options.onBackgroundTask?.(task);
    };

    pi.registerCommand("recover", {
      description: "Recover loose threads from a previous run: /recover [--dry] [session file | id prefix]",
      handler: async (args, ctx) => {
        try {
          const { dry, target } = parseArguments(args);
          const currentFile = ctx.sessionManager.getSessionFile();
          const boundary = boundaries.get(ctx.sessionManager.getSessionId());
          // External-file recoveries record their receipt in the current session too.
          const markers = ctx.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === RECOVERED_TYPE);
          const file = await resolveSession(target, currentFile, ctx.cwd, sessionsRoot, home);
          const state = await load(file, markers);
          if (currentFile && await realpath(file) === await realpath(currentFile)) protectLiveThreads(state, boundary);
          const loose = looseThreads(state);
          const live = state.threads.filter(thread => thread.state === "live").length;
          const superseded = state.threads.filter(thread => thread.state === "superseded").length;
          if (!loose.length && !live && !superseded) { notify(ctx, "nothing to recover"); return; }
          const report = await save(state, await inspect(state), { home, sourceFile: file, now: new Date(now()) });
          const summary = loose.length ? `${loose.length} loose threads` : "nothing to recover";
          notify(ctx, `${summary}; ${live} live; ${superseded} superseded; recovery report: ${report}${dry ? " (dry run; no message injected)" : ""}`);
          if (!dry && loose.length) {
            pi.sendUserMessage(recoveryPrompt(state, report), { deliverAs: "followUp" });
            pi.appendEntry(RECOVERED_TYPE, { callIds: loose.map(thread => thread.callId), at: new Date(now()).toISOString() });
          }
        } catch (error) {
          notify(ctx, `Recovery failed: ${(error as Error).message}`, "error");
        }
      },
    });

    pi.on("session_start", (event, ctx) => {
      try {
        const sessionId = ctx.sessionManager.getSessionId();
        if (!boundaries.has(sessionId)) {
          // On /reload there is no earlier process snapshot. Conservatively protect
          // existing work as live instead of declaring currently running tasks dead.
          boundaries.set(sessionId, event.reason === "reload" ? new Set() : boundaryCallIds(ctx));
        }
        // CLI --continue/--session uses startup; /resume emits resume.
        if (event.reason !== "startup" && event.reason !== "resume") return;
        const file = ctx.sessionManager.getSessionFile();
        if (!file) return;
        const boundary = boundaries.get(sessionId);
        background(async () => {
          const state = await load(file);
          protectLiveThreads(state, boundary);
          const count = looseThreads(state).length;
          if (count) notify(ctx, `${count} loose threads from the previous run. Run /recover.`);
        });
      } catch { /* Startup hints are best effort; no writes or injection. */ }
    });

    pi.on("message_end", (event, ctx) => {
      try {
        const error = assistantError(event.message);
        if (!error || !LIMIT_ERROR.test(error)) return;
        const file = ctx.sessionManager.getSessionFile();
        if (!file) return;
        const time = now();
        const previous = checkpointTimes.get(file);
        if (previous !== undefined && time - previous < 5 * 60_000) return;
        // Reserve synchronously before detached IO; Pi must not await a git probe.
        checkpointTimes.set(file, time);
        if (checkpointTimes.size > 32) checkpointTimes.delete(checkpointTimes.keys().next().value!);
        const boundary = boundaries.get(ctx.sessionManager.getSessionId());
        const message = event.message;
        background(async () => {
          // message_end runs before persistence. Add this event to the deterministic read.
          const state = await load(file, [{ type: "message", timestamp: new Date(time).toISOString(), message }]);
          protectLiveThreads(state, boundary);
          await save(state, await inspect(state), { home, sourceFile: file, now: new Date(time) });
        });
      } catch { /* A failing checkpoint must never interfere with the provider error. */ }
    });
  };
}

export default createRecoverExtension();
