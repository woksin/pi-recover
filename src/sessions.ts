import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { isAbsolute, join, resolve } from "node:path";
import { Collector } from "./collector.ts";
import type { RecoveryState } from "./types.ts";

export async function readSession(path: string, extraEntries: unknown[] = []): Promise<RecoveryState> {
  const collector = new Collector();
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) collector.add(line);
    for (const entry of extraEntries) collector.add(entry);
    return collector.finish();
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function sessionFiles(root: string): Promise<string[]> {
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const dir of dirs) {
    if (dir.isFile() && dir.name.endsWith(".jsonl")) files.push(join(root, dir.name));
    if (!dir.isDirectory()) continue;
    for (const file of await readdir(join(root, dir.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(".jsonl")) files.push(join(root, dir.name, file.name));
    }
  }
  return files.sort();
}

export async function resolveSession(target: string | undefined, currentFile: string | undefined, cwd: string, root: string, home: string): Promise<string> {
  if (!target) {
    if (!currentFile) throw new Error("The current session has no saved file yet.");
    return currentFile;
  }
  const expanded = target.startsWith("~/") ? join(home, target.slice(2)) : target;
  const path = resolve(cwd, expanded);
  try { if ((await stat(path)).isFile()) return path; } catch {}
  if (isAbsolute(expanded) || target.includes("/") || target.endsWith(".jsonl")) throw new Error(`Session file not found: ${path}`);
  const candidates = (await sessionFiles(root)).filter(file => {
    const id = file.slice(file.lastIndexOf("_") + 1, -6);
    return id.startsWith(target);
  });
  if (candidates.length > 1) throw new Error(`Ambiguous session id prefix ${target}:\n${candidates.join("\n")}`);
  if (!candidates.length) throw new Error(`No session matches id prefix ${target}.`);
  return candidates[0];
}

export function parseArguments(args: string): { dry: boolean; target?: string } {
  const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  let dry = false, target: string | undefined;
  for (const token of tokens) {
    if (token === "--dry") { dry = true; continue; }
    if (target !== undefined || token.startsWith("--")) throw new Error("Usage: /recover [--dry] [session file path | session id prefix]");
    target = token.replace(/^(["'])(.*)\1$/, "$2");
  }
  return { dry, target };
}
