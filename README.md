# pi-recover

Recover loose threads after a usage limit, crash, or killed terminal. This local Pi package reads the session JSONL deterministically, saves a recovery report and original agent prompts, and optionally sends **one user message** asking the model to check reality and recover unfinished work.

## Register

After review, add `"./local-packages/pi-recover"` to `packages` in `~/.pi/agent/settings.json`, then restart Pi or `/reload`. The package does not edit settings itself.

## Usage

Continue with `pi --continue` or `pi --session <id>`, then:

```text
/recover
/recover --dry
/recover --dry /absolute/path/to/session.jsonl
/recover 01a12345
/recover --dry "/path with spaces/session.jsonl"
```

Without a target, it reads `ctx.sessionManager.getSessionFile()`. An id prefix is searched under `~/.pi/agent/sessions/`; ambiguous prefixes list their candidate files. A session that has not been saved yet has nothing to read.

`--dry` writes the same report but injects no message or recovery receipt. With no threads to list, the command only notifies `nothing to recover` and writes nothing. Live and superseded threads are listed separately in reports, never relaunched or counted as loose. Resumed sessions show a startup hint only; they never auto-inject or write a startup report. Only assistant messages ending with `stopReason: error` or `aborted` are errors; usage/rate-limit, quota, 429, and overload matches in their `errorMessage` field trigger a silent checkpoint, at most once every five minutes per session. Normal discussion of those words does not trigger a checkpoint. Startup scans and checkpoint IO run detached, without blocking the agent event loop.

Reports are saved under the source session's cwd:

```text
.ai-work/recover/<short-session-id>-<UTC-timestamp>/report.md
.ai-work/recover/<short-session-id>-<UTC-timestamp>/prompts/<n>-<slug>.md
```

If that directory cannot be created, the fallback is `~/.ai-work/recover/`. Reports and prompts are private local files and may contain sensitive session text. They are retained for recovery, not automatically deleted or committed.

## Safety and limits

- **The extension never relaunches anything.** Relaunch, dropping a thread, workflow resume, or re-watching CI is the model's decision after checking reality.
- At `session_start`, a synchronous snapshot of existing tool-call IDs records the boundary between prior-run and current-process work. Unfinished calls started after that boundary are `live` and must not be relaunched, including when a usage limit leaves the process and other providers running. Explicit paths to the current file get the same protection. Without a startup boundary, everything is treated as prior-run work. `/reload` conservatively protects existing work as live because it cannot reconstruct the earlier process boundary.
- After injecting, the package appends a `pi-recover:recovered` receipt with the covered call IDs and time. Covered threads become `superseded`, so later recovery commands and continue hints do not repeat them. External-file recovery receipts live in the current session. A fixed marker identifies generated recovery prompts, which do not replace the original last user request.
- Resumed agents save both the resume prompt and the original spawn prompt, matched by agent ID when available in the same session, with separate labels. Missing original history is reported, not invented.
- No network calls, fetch, `gh`, or git state changes occur in the extension. The injected prompt asks the model to check PRs, CI, and issue statuses separately.
- The probe inspects at most 12 existing repositories, at most 10 seconds per git command, with a 29-second command budget. Upstream refs can be stale; status is capped at 40 lines. Candidate path discovery is heuristic and bounded to 96 paths. Referenced files are not promoted to their parent directories.
- Unfinished job logs are read from regular files only, at most 20 lines / 8 KiB. Missing or deleted logs are reported, not treated as success.
- Workflow `resumeFromRunId` is **same-session only**. The workflow extension may not retain the run after restarting; verify availability and rerun when resume is unavailable.
- Scheduled agents are listed separately and are not automatic restart candidates. A foreground agent is finished once its tool result is recorded.
- `finished` means a terminal event or rejected-start result was recorded, not that the work succeeded. Failed, stopped, and aborted threads are summarized as finished; the user/model can decide whether their tasks still need work. Known plain-text rejected Agent resumes (even when `isError` is false) are summarized as `not-started`, because they did not launch a new agent.
- Completion is matched by file order, including reused job IDs, batched notifications, and job log/start identity when available. Malformed/truncated JSONL lines are skipped and counted. A call without a tool result is interrupted/unknown.
- The whole session file is inspected, including historical branches. Reports are evidence, not a live-process registry. Use recovery for a previous run, not to duplicate currently running work.
- Handler failures are contained. A failed command reports an error; startup/checkpoint failures are silent. No model is called during registration, scanning, or tests.
- Checkpoints are not skipped in subagent sessions: the installed subagent package has no public, unambiguous signal. Its private async-local context is unavailable to this extension; parent-session headers also identify ordinary forks, and session directories/names are configurable.

## Development

Requires a Node version supporting native TypeScript stripping (the same setup as `pi-jobs`). No npm install or build output is needed.

```sh
npm test
npm run scan             # read-only, 20 most recently modified real session files
npm run typecheck        # existing tsc on PATH; no installation
# Or: PI_RECOVER_TSC=/path/to/existing/typescript/bin/tsc npm run typecheck
pi --no-session -e ./src/extension.ts --help
```

Tests use only synthetic session fixtures, fake Pi APIs, bounded local git probes, and test-owned temporary directories. The scan prints counts only, including normal messages previously misclassified as errors, never private session text. Typechecking uses the installed host declarations under `../../npm/node_modules/@earendil-works/pi-coding-agent`; no dependencies or compiled output are created. There is no remote repository, application build, or CI/integration lane for this local package; `npm test` plus the available typecheck are the local gates.
