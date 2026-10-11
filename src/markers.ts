export const RECOVERED_TYPE = "pi-recover:recovered";
export const RECOVERY_PROMPT_MARKER = "[pi-recover recovery prompt]";
const REPORT_PREFIX = "Recovery report: ";

export function recoveryReportPath(text: string): string | undefined {
  if (!text.startsWith(RECOVERY_PROMPT_MARKER + "\n" + REPORT_PREFIX)) return;
  try {
    const path: unknown = JSON.parse(text.split("\n")[1].slice(REPORT_PREFIX.length));
    return typeof path === "string" && path.length > 0 ? path : undefined;
  } catch { return; }
}
