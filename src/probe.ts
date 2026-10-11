import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { looseThreads, type ProbeResult, type RecoveryState, type RepoProbe } from "./types.ts";

export interface CommandResult { stdout: string; error?: string }
export interface ProbeOptions {
  run?: (cwd: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
  isDirectory?: (path: string) => Promise<boolean>;
  now?: () => number;
  budgetMs?: number;
}

export const runGit: NonNullable<ProbeOptions["run"]> = (cwd, args, timeoutMs) => new Promise(resolveResult => {
  execFile("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "log.showSignature=false", ...args], {
    cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 128 * 1024, encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  }, (error, stdout, stderr) => resolveResult({ stdout, error: error ? stderr.trim() || error.message : undefined }));
});

function absolutePaths(text: string): string[] {
  const quoted = [...text.matchAll(/["'`]((?:\/)[^"'`\n]+)["'`]/g)].map(match => match[1]);
  const bare = [...text.matchAll(/(?:^|[\s=(])((?:\/)[^\s"'`<>|;&)\]}]+)/g)].map(match => match[1].replace(/[.,:]$/, ""));
  return [...quoted, ...bare];
}

export function candidatePaths(state: RecoveryState): string[] {
  const paths = [state.cwd];
  for (const thread of state.threads) {
    if (thread.kind === "job" && thread.cwd) paths.push(resolve(state.cwd || process.cwd(), thread.cwd));
    if (thread.kind === "agent") {
      if (typeof thread.isolation === "string" && isAbsolute(thread.isolation)) paths.push(thread.isolation);
      if (thread.worktreePath) paths.push(thread.worktreePath);
      if (thread.isolation && typeof thread.isolation === "object") {
        paths.push(...absolutePaths(JSON.stringify(thread.isolation)));
      }
    }
  }
  for (const thread of looseThreads(state)) {
    paths.push(...absolutePaths(thread.prompt || thread.command || ""));
  }
  return [...new Set(paths.filter(path => path && isAbsolute(path)))].slice(0, 96);
}

async function existingDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** Serial, deadline-bound local git inspection. No shell, fetch, gh, or git writes. */
export async function probe(state: RecoveryState, options: ProbeOptions = {}): Promise<ProbeResult> {
  const now = options.now ?? Date.now;
  const deadline = now() + Math.min(options.budgetMs ?? 29_000, 29_000);
  const run = options.run ?? runGit;
  const isDirectory = options.isDirectory ?? existingDirectory;
  const result: ProbeResult = { repos: [], notes: [] };
  const roots = new Set<string>();
  const command = async (cwd: string, args: string[]): Promise<CommandResult> => {
    const remaining = deadline - now() - 100;
    if (remaining <= 0) return { stdout: "", error: "Probe time budget exhausted" };
    return run(cwd, args, Math.min(10_000, remaining));
  };
  for (const path of candidatePaths(state)) {
    if (now() >= deadline - 100) { result.notes.push("Probe time budget exhausted; remaining paths were not inspected."); break; }
    if (!await isDirectory(path)) continue;
    const top = await command(path, ["rev-parse", "--show-toplevel"]);
    if (top.error) { result.notes.push(`${path}: ${top.error.slice(0, 300)}`); continue; }
    const root = top.stdout.trim();
    if (!root || roots.has(root)) continue;
    roots.add(root);
    const repo: RepoProbe = { path: root, status: "", log: "", branch: "", errors: [] };
    const read = async (args: string[], optional = false): Promise<string> => {
      const response = await command(root, args);
      if (response.error && !optional) repo.errors.push(response.error.slice(0, 400));
      return response.error ? "" : response.stdout.trimEnd();
    };
    const status = await read(["status", "--porcelain=v1", "-b"]);
    repo.status = status.split("\n").slice(0, 40).join("\n");
    if (status.split("\n").length > 40) repo.errors.push("Status truncated to 40 lines.");
    repo.log = await read(["log", "-3", "--oneline"]);
    repo.branch = await read(["symbolic-ref", "--short", "-q", "HEAD"], true) || "(detached HEAD)";
    repo.upstream = await read(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true) || undefined;
    if (repo.upstream) repo.aheadBehind = await read(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    result.repos.push(repo);
    if (roots.size === 12) { result.notes.push("Repository limit (12) reached."); break; }
  }
  return result;
}
