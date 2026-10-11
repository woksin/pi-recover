import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";

export function tempDir(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "pi-recover-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

export function text(value: string) { return [{ type: "text", text: value }]; }
export function session(cwd = "/example/repo", id = "synthetic-session") {
  return { type: "session", id, cwd, timestamp: "2026-01-01T00:00:00.000Z" };
}
export function call(name: string, id: string, args: Record<string, unknown> = {}) {
  return { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } };
}
export function result(name: string, callId: string, value: string, details: unknown = undefined) {
  return { type: "message", message: { role: "toolResult", toolName: name, toolCallId: callId, content: text(value), details } };
}
export function notification(id: string, status = "Done", callId?: string) {
  return { type: "custom_message", customType: "subagent-notification", content: `<task-notification>\n<task-id>${id}</task-id>\n${callId ? `<tool-use-id>${callId}</tool-use-id>\n` : ""}<status>${status}</status>\n</task-notification>` };
}
export function jobCompletion(id: string, status = "succeeded") {
  return { type: "custom_message", customType: "pi-jobs", content: text(`Job ${id} ${status}: synthetic label\nexit 0`) };
}

export function fakePi(cwd: string, file?: string) {
  const commands = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const sent: { text: string; options: unknown }[] = [];
  const notes: { text: string; level: string }[] = [];
  const ctx = { cwd, sessionManager: { getSessionFile: () => file }, ui: {
    notify: (text: string, level: string) => notes.push({ text, level }),
  } };
  const pi = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    sendUserMessage: (text: string, options: unknown) => sent.push({ text, options }),
  };
  return { pi, ctx, sent, notes, command: (args = "") => commands.get("recover").handler(args, ctx),
    emit: async (name: string, event: unknown) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); } };
}
