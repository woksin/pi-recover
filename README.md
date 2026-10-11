# pi-recover

Recover loose threads after a usage limit, crash, or killed terminal. This Pi extension reads the session JSONL deterministically, saves a recovery report and original agent prompts, and optionally sends **one user message** asking the model to check reality and recover unfinished work.

## Install

Add the npm source to `packages` in your Pi settings:

```json
{
  "packages": ["npm:@woksin/pi-recover"]
}
```

Or use `pi install npm:@woksin/pi-recover`. Git and local checkouts work too:

```sh
pi install git:github.com/woksin/pi-recover
pi install /path/to/pi-recover
```

Restart Pi or run `/reload` after changing settings. The extension never edits settings.
Tested with Pi 1.1.0. The host dependency uses `"*"` as recommended for Pi packages:
Pi supplies its own runtime and suppresses automatic peer installation for managed packages.
Other runtime versions are not guaranteed.

## Companion extensions

Works best with `@tintinweb/pi-subagents` and `@woksin/pi-jobs`. It recognizes their
`Agent`, `SubagentWorkflow`, `job_start`, and `job_watch` session records and completion
notifications, preserving agent prompts and job log paths. These companions are optional,
not bundled dependencies. Without them, `/recover --dry` can still inspect sessions that
contain those historical records, and usage-limit checkpoints still save session context.
Ordinary built-in tool calls are not tracked as recoverable threads; a session without
recognized threads reports `nothing to recover`.

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
- At `session_start`, a synchronous snapshot of existing tool-call IDs records the boundary between prior-run and current-process work. Unfinished calls started after that boundary are `live` and must not be relaunched, including when a usage limit leaves the process and other providers running. Explicit paths to the current file get the same protection. Without a startup boundary, everything is treated as prior-run work. Every `session_start`, including `/reload`, resets the boundary: `/reload` aborts in-process subagents and kills pi-jobs jobs, so work started before it is treated as dead.
- After queuing a recovery prompt, the package appends a `pi-recover:recovered` receipt with the report path, covered call IDs and time. A receipt counts only when a marked user recovery prompt with that exact report path appears **after it** in the session. A crash or dropped queue before delivery leaves threads loose. Confirmed threads become `superseded`, so later commands and continue hints do not repeat them. External-file receipts and their confirming prompts live in the current session. Legacy receipts without a report path are not confirmation. Generated recovery prompts do not replace the original last user request.
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

Requires Node.js 22.19 or newer for native TypeScript stripping. Pi loads the TypeScript
entry point directly; there is no compiled build output. Development dependencies include
TypeScript 5.9.3 and Pi 1.1.0 declarations; they are not included in the published package.

```sh
npm ci --ignore-scripts
npm test
npm run scan             # read-only, 20 most recently modified real session files
npm run typecheck        # local TypeScript devDependency
# Optional: PI_RECOVER_TSC=/path/to/typescript/bin/tsc npm run typecheck
pi --no-session -e ./src/extension.ts --help
```

Tests use only synthetic session fixtures, fake Pi APIs, bounded local git probes, and test-owned temporary directories. The scan prints counts only, including normal messages previously misclassified as errors, never private session text. Typechecking resolves the local devDependencies, without relying on the host's installation
layout. `npm test` and `npm run typecheck` are the local gates; neither calls a model.

## Releasing

CI (`.github/workflows/ci.yml`) runs the tests on Node 22 and 24 for every push and pull request. To release, bump `version` in `package.json`, commit, and publish a GitHub release tagged `v<version>`. `.github/workflows/publish.yml` then runs CI again and publishes to npm with provenance. That works through npm trusted publishing when it is set up for this repository, or otherwise through an `NPM_TOKEN` repository secret.
