import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { assistantError, LIMIT_ERROR } from "./collector.ts";
import { probe } from "./probe.ts";
import { recoveryPrompt, writeReport } from "./report.ts";
import { parseArguments, readSession, resolveSession } from "./sessions.ts";
import { looseThreads } from "./types.ts";

export interface RecoverOptions {
  home?: string;
  sessionsRoot?: string;
  now?: () => number;
  probe?: typeof probe;
  writeReport?: typeof writeReport;
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "error" = "info"): void {
  try { ctx.ui.notify(text, level); } catch { /* UI is optional; never break the session. */ }
}

export function createRecoverExtension(options: RecoverOptions = {}) {
  return function recoverExtension(pi: ExtensionAPI): void {
    const home = options.home ?? homedir();
    const sessionsRoot = options.sessionsRoot ?? join(home, ".pi", "agent", "sessions");
    const now = options.now ?? Date.now;
    const inspect = options.probe ?? probe;
    const save = options.writeReport ?? writeReport;
    const checkpointTimes = new Map<string, number>();

    pi.registerCommand("recover", {
      description: "Recover loose threads from a previous run: /recover [--dry] [session file | id prefix]",
      handler: async (args, ctx) => {
        try {
          const { dry, target } = parseArguments(args);
          const file = await resolveSession(target, ctx.sessionManager.getSessionFile(), ctx.cwd, sessionsRoot, home);
          const state = await readSession(file);
          const count = looseThreads(state).length;
          if (!count) { notify(ctx, "nothing to recover"); return; }
          const report = await save(state, await inspect(state), { home, sourceFile: file, now: new Date(now()) });
          notify(ctx, `${count} loose threads; recovery report: ${report}${dry ? " (dry run; no message injected)" : ""}`);
          if (!dry) pi.sendUserMessage(recoveryPrompt(state, report), { deliverAs: "followUp" });
        } catch (error) {
          notify(ctx, `Recovery failed: ${(error as Error).message}`, "error");
        }
      },
    });

    pi.on("session_start", async (event, ctx) => {
      try {
        // CLI --continue/--session uses startup; a saved file with history distinguishes
        // it from a new session. /resume emits resume; /reload must not warn about live work.
        if (event.reason !== "startup" && event.reason !== "resume") return;
        const file = ctx.sessionManager.getSessionFile();
        if (!file) return;
        const state = await readSession(file);
        const count = looseThreads(state).length;
        if (count) notify(ctx, `${count} loose threads from the previous run. Run /recover.`);
      } catch { /* Startup hints are best effort; no writes or injection. */ }
    });

    pi.on("message_end", async (event, ctx) => {
      try {
        const error = assistantError(event.message);
        if (!error || !LIMIT_ERROR.test(error)) return;
        const file = ctx.sessionManager.getSessionFile();
        if (!file) return;
        const time = now();
        const previous = checkpointTimes.get(file);
        if (previous !== undefined && time - previous < 5 * 60_000) return;
        // Reserve before async IO, so concurrent error callbacks cannot duplicate a report.
        checkpointTimes.set(file, time);
        if (checkpointTimes.size > 32) checkpointTimes.delete(checkpointTimes.keys().next().value!);
        // message_end runs before persistence. Add this event to the deterministic read.
        const state = await readSession(file, [{ type: "message", timestamp: new Date(time).toISOString(), message: event.message }]);
        await save(state, await inspect(state), { home, sourceFile: file, now: new Date(time) });
      } catch { /* A failing checkpoint must never interfere with the provider error. */ }
    });
  };
}

export default createRecoverExtension();
