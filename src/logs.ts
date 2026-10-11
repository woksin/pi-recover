import { open } from "node:fs/promises";

/** Read at most 8 KiB from the end, never the entire log (or a FIFO/device). */
export async function logTail(path: string): Promise<string> {
  let file;
  try {
    // O_NONBLOCK avoids hanging on a FIFO mistakenly supplied as a log path.
    const { constants } = await import("node:fs");
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) return "(log is not a regular file)";
    const size = Math.min(info.size, 8192);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, Math.max(0, info.size - size));
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (info.size > size && text.includes("\n")) text = text.slice(text.indexOf("\n") + 1);
    return text.replace(/\n$/, "").split("\n").slice(-20).join("\n") || "(no output)";
  } catch (error) {
    return `(log unavailable: ${(error as Error).message})`;
  } finally {
    await file?.close();
  }
}
