# What t3code's scheduler handles

Research for Scheduled Tasks in claude-mux (#164, map #163). This note reports
facts and leaves the design to later tickets.

**Sources.**

- [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at commit
  `3fd2b855c5c6b9169cdfe3733b34011c1c5ed4b7` (2026-11-01). Paths below are in
  that repo unless they say claude-mux.
- claude-mux at `acdf730` (0.30.18).
- `effect` 4.0.5 from npm, read for its daylight-saving rules. This is the
  version pinned in t3code's `pnpm-workspace.yaml:70`.

Nothing was run. Every behaviour comes from reading code, tests and docs. Where
I worked out a consequence that no test covers, the text says "derived".

Short file names used below:

| Name | Path |
| --- | --- |
| `Service` | `apps/server/src/scheduledTasks/ScheduledTaskService.ts` |
| `Schedule.ts` | `apps/server/src/scheduledTasks/Schedule.ts` |
| `Scheduler.ts` | `apps/server/src/scheduling/Scheduler.ts` |
| `Contract` | `packages/contracts/src/scheduledTask.ts` |
| `Launch` | `apps/server/src/orchestration-v2/ThreadLaunchService.ts` |

Test files named below sit beside `Service`.

## Short answer

- **t3code's "running" means "being dispatched", not "the agent is working".** A
  firing is marked `succeeded` as soon as the launch call returns, before the
  worktree exists and before the agent starts. Its overlap guard and its restart
  recovery both cover only that short window.
- **A task still working at its next firing is not detected.** A task that opens
  a new thread simply opens another one. A task bound to one thread queues the
  message behind the active run.
- **A restart mid-firing is recorded as failed and never retried.** The next run
  moves forward, so a clock firing happens at most once.
- **Only fixed-time runs are skipped when missed, and only when more than 10
  minutes late.** Interval and one-time runs fire once on return, however late.
  The map's rule ("skipped, as in t3code") is stricter than t3code. A skip leaves
  only a log line.
- **Time.** `next_run_at` is a stored UTC instant. Fixed times are worked out in
  the server's local zone, and no zone is stored on the task. Intervals count
  elapsed time.
- **Workspace.** Each task stores a strategy: new worktree, project checkout, or
  a given path. The settings form defaults to a new worktree.
- **Per run, almost nothing is kept.** The task row holds only the latest start
  time, status and error, plus a counter. There is no table of runs and no link
  from a task to the threads it launched. Webhooks are the exception, with a
  trimmed delivery log.
- **Most of the code is not about the clock.** Of the 2351 lines in `Service`,
  about 40 percent are webhook handling (mostly `Service:1477-2334`). The clock logic itself is small:
  `Schedule.ts` is 82 lines and `Scheduler.ts` is 61.

## How a firing works

1. The server ticks every 5 seconds (`Scheduler.ts:57`). A tick that finds the
   previous one still running does nothing (`Scheduler.ts:37`). Ticks wait until
   startup recovery is over (`Scheduler.ts:51-52`).
2. The tick selects enabled tasks with `next_run_at <= now` whose
   `last_run_status` is not `running` (`Service:400-405`). A short-lived in-memory
   hint skips the query when nothing can be due; it is only an optimisation
   (`apps/server/src/scheduling/DueHint.ts`).
3. Due tasks are handled one at a time (`Service:1088-1101`).
4. Each firing re-reads the row, so a task paused, deleted or postponed since the
   poll does not fire (`Service:790-823`).
5. It sets `last_run_status = 'running'` (`Service:693-710`), then calls the
   launch (`Service:903-922`).
6. When the launch call returns, it writes the status and the next run in one
   transaction (`Service:932-988`).

The stored task is a single row: title, prompt, enabled, schedule JSON, project,
optional bound thread, workspace strategy, model, modes, and run state
(`apps/server/src/persistence/Migrations/OrchestrationV2/ScheduledTasks.ts:8-29`).

Schedule types are `interval` (at least 60 seconds), `fixed_time` (`HH:MM` plus
optional weekdays), `once` and `webhook` (`Contract:29-46`, `Contract:67-74`,
`Contract:158-166`, `Contract:202-214`).

## The six questions

### 1. A task still running at its next firing

There are two guards, and neither looks at the agent:

- The SQL filter on `last_run_status <> 'running'` (`Service:403`).
- An in-memory set of tasks being dispatched (`Service:1011-1032`). A clock firing
  that finds its task in the set does nothing. A manual run fails with "Schedule
  task is already running".

Both clear when the launch returns, and the launch returns early. It accepts the
message with `defer_start`, forks worktree preparation into the background and
returns (`Launch:970`, `Launch:803`, `Launch:1047`). Nothing in `runTask` or
`runDueTasks` reads a thread's or a run's status.

So the result depends on the task:

- **New thread per firing** (`thread_id` is null). Each firing launches another
  thread, whatever the earlier ones are doing. A 15-minute interval with a
  40-minute job would have several agents running at once (derived). I found no
  limit on this in the scheduler, per task or per project.
- **Bound to a thread.** The prompt is sent with `mode: "queue"`
  (`Service:872-883`), which becomes `queue_after_active`
  (`apps/server/src/orchestration-v2/ThreadManagementService.ts:839`). Firings
  wait behind the active run. The scheduler sets no cap on that queue.
- **Webhook.** One delivery per task is dispatched at a time, behind a semaphore
  (`Service:2210-2215`), with at most 20 waiting (`Service:82`). This also covers
  only the dispatch.

`Service` contains no timeout, duration limit or quota check, so a run can go on
indefinitely as far as the scheduler knows.

### 2. Restarts mid-run

There are two separate layers.

**The task row.** A crash can leave `last_run_status = 'running'`, which the poll
would skip forever. So at startup every such row is set to `failed` with "Run was
interrupted by a server restart.", its counter goes up and `next_run_at` advances
(`Service:1104-1155`; test at `ScheduledTaskService.test.ts:163`). A failure while
the server stays up gets the same treatment (`Service:738-763`). The comment there
gives the reason: "the dispatch may already have gone out, so next_run_at must
advance".

What that means for each schedule:

- **Interval.** The next run is `now + interval`.
- **Fixed time.** The next occurrence after now.
- **Once.** The next run counts from the interrupted run's start time
  (`Service:305-317`). A manual run begun before the set time does not use it up
  (test at `ScheduledTaskService.interval.test.ts:260`). A scheduled run that was
  interrupted is gone (derived: `nextScheduledRunAt` returns null).
- **Undecodable row.** It is marked failed and not rescheduled, so it no longer
  blocks the others (`Service:1131-1146`).

So clock firings are at-most-once. A crash between `markRunning` and the launch
loses that firing, and it shows as failed (derived). The command id includes the
start time (`Service:855-860`), so a later firing is a new command, not a replay.
Webhook deliveries differ: their id is the delivery id, and pending ones survive a
restart in a table (`Service:2233-2300`, migration `067_WebhookDedupe.ts`).

**The agent.** Agents are provider processes owned by the server, so a restart
stops them. Startup reconciliation marks the work "Cancelled because the server
restarted before the provider work completed"
(`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:271`). If
**Continue threads after restarts** is on, which is the default, supported active
threads resume (`docs/user/updating.md:67`, `ProviderRuntimeRecoveryService.ts:653`).
A worktree setup that was interrupted stays requested until a worktree exists
(`packages/contracts/src/orchestrationV2.ts:712-716`). None of this is specific to
scheduled runs, and none of it touches the task row, which already said
`succeeded`.

### 3. Clock and timezone changes

**Storage.** `next_run_at` is a UTC ISO string (`Service:281-283`), compared with
the current time as text (`Service:403`).

**Zone.** Every "now" comes from the server's local zone (`Service:285`), and that
zone is looked up again on each read (`effect` `src/internal/dateTime.ts:428-429`,
`src/DateTime.ts:2777-2780`). The task stores no zone. The docs state the
consequence: fixed-time schedules use the environment's zone, "which may differ
from your phone's" (`docs/user/project-settings.md:84-85`). One-time runs are
entered in the phone's zone with an offset and stored as UTC (`Contract:67-74`,
`Service:1232`, `docs/user/project-settings.md:86`).

**Interval across daylight saving.** Elapsed time, so the wall-clock hour shifts
(`Schedule.ts:25-28`; test at `ScheduledTaskService.interval.test.ts:49-80`).

**Fixed time across daylight saving.** It stays on the local calendar. 09:00 in New
York is `13:00Z` on the spring change day and `14:00Z` on the autumn one (test at
`ScheduledTaskService.interval.test.ts:111-132`). For times that don't exist or
occur twice, `Schedule.ts:35-40` uses Effect's default, "compatible":

- **In the spring gap**, the time moves forward by the size of the gap, so 02:30
  in New York fires at 03:30 (`effect` `src/internal/dateTime.ts:778-780`, derived).
- **In the repeated autumn hour**, the first occurrence is used
  (`effect` `src/internal/dateTime.ts:794`). It fires once, because the next
  calculation starts from after that time (`Schedule.ts:41`, derived).

t3code has no test for either edge.

**Machine zone changes** (derived, no test). The stored instant stands until the
next calculation. So the first firing after the change happens at the old zone's
time, and the ones after follow the new zone. I did not check whether a long-running
process notices an operating-system zone change at all.

**Wall-clock jumps** (derived, no test). There is no special handling.

- A jump forward looks like downtime and follows the missed-run rules below.
- A jump backward delays what is due, because the stored instant is further off. It
  does not fire anything twice.

Suspending a laptop looks the same as a jump forward.

### 4. Missed runs

The rule is one comparison, applied per task in the poll (`Service:1092-1094`):

| Schedule | Overdue when the server next looks | Result |
| --- | --- | --- |
| `fixed_time`, 10 minutes late or less | fires late | a normal run |
| `fixed_time`, more than 10 minutes late | skipped | `next_run_at` moves to the next occurrence |
| `interval`, any lateness | fires once | next run counts from completion, no backfill |
| `once`, any lateness | fires once | docs: "the task runs when it is back" (`docs/user/project-settings.md:86-87`) |
| `webhook` | not applicable | the relay may hold requests up to 24 hours; a per-task max age can refuse old ones (`Contract:91-98`, `Service:1997-2006`) |

The grace period is `MISSED_FIXED_TIME_GRACE_MS` (`Schedule.ts:73-82`). No test file
refers to it or to `isMissedFixedTimeRun`.

**A skip leaves almost no trace.** It writes `next_run_at` and `updated_at` and logs
at info level (`Service:1035-1056`). `last_run_*` and `run_count` don't change, so
the task list can't show that a run was skipped.

**Other cases that move or drop a run:**

- Pausing clears `next_run_at`, and resuming calculates it afresh from now
  (`Service:1326`). Runs missed while paused are gone.
- Resuming or saving a one-time task whose time has passed is an error
  (`Service:320-328`).
- Editing only the title or prompt keeps the pending run. Changing the schedule or
  enabled state restarts the clock (`Service:1200-1202`, `Service:1275-1278`).
- A manual run also recalculates the next run from its completion
  (`Service:951-954`), so it pushes an interval back. A one-time task counts from
  the manual run's start instead.

**Against the map.** The map says a missed Run "is skipped, as in t3code". That
matches t3code only for fixed-time runs more than 10 minutes late. Whether the map
means the stricter rule is for its owner to confirm. I did not edit the map.

### 5. Which workspace a run gets

Each task stores one of three strategies
(`packages/contracts/src/orchestrationV2.ts:649-665`):

- `worktree`: a new worktree from `baseRef`, optionally fetched from origin first,
  with an optional branch name.
- `root`: the project checkout.
- `existing_worktree`: a given path.

The defaults depend on who creates the task:

- **The settings form:** a new worktree from `main`, starting from origin
  (`apps/web/src/components/settings/ScheduledTasksSettings.tsx:145-147`).
- **An agent, through the MCP tool:** a new worktree from the resolved base branch,
  or `root` if bound to a thread (`apps/server/src/mcp/OrchestratorMcpService.ts:1861-1871`).

For a `worktree` task, each firing fetches, creates a worktree on a unique temporary
branch, then runs the project's setup script, all in the background
(`Launch:319-325`, `Launch:375-377`, `Launch:399-459`). If that fails, the failure
appears inside the thread (`Launch:178`, `Launch:710`). The task row still says
`succeeded`.

A bound task ignores its strategy and runs wherever the thread already is
(`Service:866-883`). Projects with no git repository are turned into `root`
(`Service:1270-1274`, `Launch:811-815`).

With `root` or `existing_worktree`, overlapping firings share one checkout (derived).
I found no guard against that.

The scheduler removes nothing afterwards. Threads from earlier firings stay, and
deleting them does not affect the task (`docs/user/project-settings.md:89-90`).
Worktrees fall under the general cleanup rules in Settings, which are not specific to
scheduled tasks (`docs/user/project-settings.md:206-223`).

### 6. What it records per run

**On the task row, overwritten at each firing:**

| Column | Meaning |
| --- | --- |
| `last_run_at` | Start time, set when marked running (`Service:697`) |
| `last_run_status` | `never`, `running`, `succeeded` or `failed` (`Contract:217`) |
| `last_run_error` | The launch's error text, or null |
| `run_count` | Total firings, not counting skips |
| `next_run_at` | The next instant |

`succeeded` means the launch was accepted (`Service:932-937`). It does not mean the
agent finished, or even began.

**Not recorded anywhere on the task:**

- A history of runs.
- The thread or worktree a run opened. `thread_id` is the binding, not the last run.
  `runNow` returns the thread id but doesn't store it (`Service:250`).
- End time or duration.
- What triggered the run (scheduled or manual).
- The time the run was due.
- Skips.
- How the agent's work ended.

**On the thread.** The run opens a thread titled with the task's title. Its message
carries `scheduledTaskId` (`packages/contracts/src/orchestrationV2.ts:1286`), which
the timeline uses to link back to the task
(`apps/web/src/components/chat/TimelineUserMessageRow.tsx:316-319`). The link runs
only that way: thread to task. The thread itself has the full conversation and the
run's real status.

**Webhooks only.** `scheduled_task_webhook_deliveries` has a row per request: time,
method, redacted query and headers, body up to 64 KB, outcome, whether the signature
was checked, the filled-in prompt and any error
(`apps/server/src/persistence/Migrations/057_ScheduledTaskWebhooks.ts:12-28`,
`Service:80-81`). It keeps the last 50 real deliveries per task, plus 20 each for
filtered and deduplicated ones (`Service:75-77`).

## What claude-mux needs, and what only t3code's thread model needs

### Behaviour a first version needs an answer for

These don't depend on threads. Each still has a choice in it, for later tickets.

| Topic | What t3code does | Why it carries over |
| --- | --- | --- |
| Persisted next run | One UTC instant per task, polled | Works with any process model |
| Fixed time and interval rules | Calendar time versus elapsed time | The same on any machine |
| Daylight-saving edges | Gap moves forward, repeat fires once | Comes from the Effect library, so claude-mux would have to choose its own rule |
| Timezone | The machine's, not stored | A task belongs to one machine, and Leo schedules from a phone |
| Stale poll | Re-read before firing | Pause or delete from a phone can race a firing |
| Edits | Title or prompt keeps the pending run | Editing must not postpone or revive a run |
| A stuck "firing" state | Released at startup and on error | Any state the poll skips can block a task forever |
| Uncertain firing | Advance, don't retry | A retry could open a second session |
| Missed run | Rules in question 4 | The map settled on skipping; a skip leaves no trace in t3code |
| Workspace | Stored per task | A Run needs a directory, and the choice decides whether Runs can collide |
| Latest result on the task | Status, error, counter | The minimum for a list on a phone |
| Run now, pause, resume, delete | All present (`docs/user/project-settings.md:92`) | Same controls for managing from a phone |

### Thread-model only

These exist because a t3code run is a message in a thread owned by the server:

- Tasks bound to a thread, and with them queued sends, held queues, following a
  thread that moves project, and deleting a task with its thread (`Service:244-249`,
  `Service:866-898`, `apps/server/src/orchestration-v2/Orchestrator.ts:2288`,
  `Orchestrator.ts:5753`).
- `defer_start`, prepared runs and retrying a preparation (`Launch:1062-1093`).
- Command receipts and replay through the event log (`Launch:843`).
- Per-task model, runtime mode and interaction mode (`Contract:236-238`). claude-mux
  has one fixed command per agent (`src/agents.ts:13-35`).
- Resuming provider work after a restart. A tmux pane does not stop with the server.
- Live list subscriptions and the due-time hint. claude-mux has its own broadcast,
  and the hint exists to avoid idle SQL queries.
- Agents creating tasks through MCP, with limits on the modes they may set
  (`Launch:979-984`, `OrchestratorMcpService.ts:1926`). The map doesn't ask for this.

Webhooks are separate. They are about 40 percent of `Service` and are listed under "Not yet
specified" on the map. Their relay, signatures, deduplication and coalescing are not
needed for a clock-only first version.

### What the map needs that t3code cannot supply

t3code has no equivalent for these, so there is nothing to copy:

- **Knowing a Run is still working.** The map's "one hunting Run at a time" needs real
  knowledge of the session. t3code's guard stops when the launch returns.
- **A Run that ends itself, and a 45-minute limit.** A t3code thread stays open, and
  the scheduler sets no time limit.
- **Skipping on usage quota, or when Leo has a live session in the project.** t3code has
  no such check in the scheduler.
- **A real outcome for a Run.** t3code never updates the task when the agent finishes.
- **A record of each Run.** The map treats a Run as a thing in its own right. t3code has
  no such record for clock firings.

## How claude-mux differs today

**Storage.** There is no database. `src/db/` holds JSON files under `~/.claude-mux/`,
written atomically with a temp file and rename (`src/db/projects-json.ts:1-14`,
`src/db/settings-json.ts:1-6`). t3code relies on SQL transactions and conditional
updates for its races (`Service:720-730`, `Service:987-988`). JSON files have neither.
Session files need a per-file lock because the hook and the server both write them
(`src/db/session-lock.ts:3-9`).

**Starting.**

- `startSession` (`web/src/lib/server/start-session.ts:44-89`) opens a detached tmux
  session in a `cwd` and registers a row. It runs synchronously and throws if tmux fails.
  Like t3code's launch result, that says only whether the start was accepted.
- A first prompt goes on Claude Code's command line, for Claude only
  (`web/src/routes/api/projects/new-session/+server.ts:14-19`, `:34`).
- The CLI's `new-session` has no prompt option (`src/commands/new-session.ts:35-39`).
- Claude Code always starts with `--dangerously-skip-permissions` from the web path
  (`src/agents.ts:19`), and the command has no `-p`. Nothing in claude-mux makes it exit
  when the job is done.

**Linking a Run to a Session.** The id from `startSession` is provisional. The row is
"registered under until the hooks speak" (`start-session.ts:35`), and at SessionStart
the hook deletes rows with the same tmux target and writes its own under Claude Code's
session id (`src/hooks/claude-mux-hook.ts:484-488`). What stays stable is the tmux target
and session name. The closest precedent for tagging is `MAESTRO_ROLE` and `MAESTRO_ISSUE`,
read from the environment by the hook (`claude-mux-hook.ts:521-527`). `startSession`
doesn't currently take extra environment variables.

**Knowing it ended.** SessionEnd deletes the session file (`claude-mux-hook.ts:949-950`),
so a finished Run's row disappears and only its transcript remains, as a Past session.
`cleanupStaleSessions` does not touch rows with pid 0 (`src/db/sessions-json.ts:387`), which
is the state of a row whose hooks never fired.

**Restarts.** This is the largest difference from t3code. The tmux server is kept out of the
service's cgroup so that a claude-mux restart does not close panes
(`src/tmux/server.ts:5-18`). A Session therefore outlives a server restart, and a Run marked
"running" may really still be running. t3code's rule of marking it failed at startup assumes
the opposite. A reboot of the machine does end the panes.

**Workspace.** `startSession` takes a `cwd`. No code under `src/` or `web/src/` runs `git
worktree add`. The `.worktree/<issue>` layout on the map is a convention workers follow.

**Time.** Nothing in the server schedules by the clock today. The nearest thing is the 500 ms
session-file poll (`src/server/watcher.ts:33`). The usage report already has a notion of the
host's time zone (`src/usage/report.ts:144`).

## What was not checked

- Nothing was run, in t3code or claude-mux, so no timing or restart behaviour was observed.
  The Effect rules come from reading its source, not from running a date through it.
- Whether a long-running process sees an operating-system time zone change.
- How the phone learns the machine's zone in t3code. I only read the docs statement.
- Whether the queue behind a bound thread has a limit somewhere in `Orchestrator.ts`
  (about 14,000 lines, read only in part). The scheduler itself sets none.
- Worktree cleanup was read from the user docs, not from `apps/server/src/storageCleanup.ts`.
