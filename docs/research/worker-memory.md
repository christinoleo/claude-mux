# How much memory a worker takes, and what sets a machine's limit

Research for [#181](https://github.com/christinoleo/claude-mux/issues/181), on the map [#177](https://github.com/christinoleo/claude-mux/issues/177). Measured read-only on `omarchy` (15.46 GiB RAM, 8 cores) on 2026-11-01. `engage` and `distilo-1` were not touched, so nothing here is measured for them.

## Answer

- **Typical worker:** 1.0 to 1.4 GiB that cannot be reclaimed (anonymous memory, shared memory and swap).
- **Worker at peak:** 2.4 GiB of that kind, seen once, in a sample where Vite held most of it. The `memory peak` systemd logs is higher, 1.9 GiB at the median and 4.1 GiB at most, because it includes file cache the kernel can take back.
- **Largest parts:** Claude Code takes about 0.3 GiB and its MCP servers about 0.4 GiB, before any work. Browser, dev server and builds are what vary.
- **The limit:** use a fixed number per machine, with a free-memory check that only holds back a start. Do not derive the limit from free memory.
- **The number here:** 4 workers on `omarchy`. This is a judgement from the figures below, not a measured breaking point.

## How it was measured

- **Live cgroups.** Read `memory.current`, `memory.peak`, `memory.swap.current` and `memory.stat` for each worker's scope, and `/proc/<pid>/smaps_rollup` for each process in it. Process figures are PSS plus swapped PSS, so shared pages are not counted twice.
- **Two samplers.** One ran every 15 s from 23:35:40 to 23:45:35 (38 samples). The other ran every 20 s from 23:41:47 to 23:54:53 (40 samples).
- **Workers observed.** Three: #173 for the whole run, #175 until its window closed, and #174 from when it started. Two ran at any one time.
- **History.** Parsed 385 `Consumed` lines from the user journal since 2026-10-25, which give a peak per finished scope.
- **Which scopes were workers.** Matched each scope to a transcript that started within 60 s of it, and called it a worker if the first prompt was `/ak:maestro-worker`. That matched 54 scopes against 58 worker transcripts from the period.

## What a worker takes

### Live, by part

Each figure is the range of per-worker medians, with the highest single sample in brackets, in MB of PSS plus swap.

- **Claude Code:** 263 to 332 (386). As RSS it reached about 500.
- **MCP servers:** 363 to 464 (517). This is two `chrome-devtools-mcp` instances plus `mcp-pdf-server`, which alone takes 130 to 156.
- **`npm exec` wrappers and small helpers:** 47 to 73 (92).
- **Browser:** 0 to 321 (869). This is the headless Brave or Chromium the MCP starts, and it is absent until first used.
- **Vite, dev or build:** 0 at the median (1397). A `vite dev` left running held 416 after 20 minutes.
- **Test and lint tools:** 0 at the median (349).
- **Short-lived Node processes:** 1.0, 1.4 and 1.8 GiB RSS, each visible for only one or two samples. The two in #175 fall near its lint, test and `bun run build` runs, and the largest had an `esbuild` child. The process names do not prove which command each one was, so this link is an inference.

### Live, by scope

MB, median (highest).

- **#173:** non-reclaimable 967 (2400), file cache 170 (298), `memory.peak` 2974.
- **#174:** non-reclaimable 1361 (1393), file cache 929 (956), `memory.peak` 1590. Includes about 800 of shared memory.
- **#175:** non-reclaimable 1049 (1529), file cache 585 (602), `memory.peak` 3552.

The peak arrives quickly and does not last. #173 was at 608 MB seven seconds after its scope started and its `memory.peak` reached 2720 about two minutes later. By then `memory.current` had fallen back to about 650.

### History, by `memory peak`

MB, for the 54 finished worker scopes.

- **All workers:** median 1946, p75 2253, p90 3584, highest 4096.
- **dustline (44):** median 1946, highest 3584, running about 17 minutes.
- **zapSell (7):** median 3686, highest 4096, running about 100 minutes. The two checked ran database tests and made about 20 browser MCP calls each.
- **claude-mux (3):** median 1946, highest 3789.

These numbers overstate the cost, because the journal does not separate file cache. They also rise with project weight, so a planning figure from dustline alone would be too low.

### What the large peaks were

The cluster at 23:25:32 is 17 scopes ending together. It matches the `tmux kill-server` incident the map describes, so these scopes did not end by finishing. Attribution comes from the transcript with the matching start time.

- **8.8 G (swap peak 4.4 G):** session `a24729e2`, opened in `moonsweep`, open 36.8 hours. It is an orchestrating session, not a worker. It ran `npm ci`, `bun install`, `npm test`, `bun run build`, Vite and simulation runs for dustline in its own scope, plus 11 subagents. The transcript cannot say which of these set the peak.
- **3.7 G:** session `e1195cec`, a claude-mux worker with 33 browser MCP calls and test runs, over 34 minutes.
- **2.2 G:** session `60650e25`, in `homelab`, open 194 hours, with Docker commands among its tools.
- **2.1 G:** session `3ff54fe8`, the claude-mux session that runs the maestro daemon.
- **1.9 G:** no transcript found, open 241 hours.
- **1.8 G:** session `2f7db518`, in `claude-watch`, open 23 hours.
- **1.3 G:** session `862dd407`, in `random`, open 25 hours.
- **675 M:** session `3c07f351`, in a directory named `proj`, open 25 minutes. Not looked at further.

The largest scope outside that cluster, 6.4 G on 10-31 (`ed6c8401`), has no transcript and used 157 CPU hours over 341 hours. It looks like a long-running server in a tmux pane, but that is not established.

### What scope totals miss

- **Peak per scope is not per worker.** A worker testing with its own tmux server starts panes in separate scopes. While sampling, #173's `tmux -L p173` had a `claude --model haiku` in another scope, holding about 208 MB.
- **Short scopes.** 271 scopes lived under two minutes, with a median peak of about 250 MB, and 254 of them fell between 20:00 and 22:00 on 11-01. Nearly all have no transcript. They resemble the same kind of short Claude start, but their source was not found, and they are excluded from the worker figures.
- **Resident leftovers.** A scope outlives its worker if anything in it survives, and the limit will not see these:
  - `2d2f8962`: 7 `node build` processes from the deleted `zapSell/.worktree/84`, running since 10-09, holding about 420 MB.
  - `f3da7a02`: headless Brave from the deleted `.worktree/175`, holding about 260 MB.
  - `408ee261`: 1143 MB of swap charged to a scope whose 3 processes hold 3 MB. `/tmp` is tmpfs here and this session has a scratchpad there, so swapped tmpfs pages are the likely cause, not a confirmed one.

## What the machine shows

- **Non-worker load.** At the end of sampling, with two workers running, MemAvailable was about 5.5 GiB. Taking off 2.4 GiB for the workers leaves about 7.6 GiB for everything else, including the desktop, personal apps, zram (2.7 GiB), the orchestrating session and the leftovers above.
- **MemAvailable moves a lot.** It ranged from 3.6 to 6.8 GiB in the first sampler and 4.2 to 6.6 GiB in the second, under ordinary work.
- **Swap is doing real work.** 7.9 to 8.6 GiB is swapped, mostly in zram, compressing about 3 to 1 (7.9 G of data in 2.7 G).
- **Pressure is almost nil.** `full` PSI totals about 732 s over 28 days of uptime. The highest `full avg10` seen while sampling was 1.92%.
- **Six workers have fitted.** The most running together was 6 dustline workers, on 10-31 around 21:13, with the highest sum of their peaks 9.1 GiB. Nothing was killed. PSI has no history, so how the machine felt at that moment is unknown.
- **The current default is 2.** `MAX_WORKERS=2` in `maestro-daemon.sh`, from the `ak` plugin.

## How systemd-oomd behaves here

- **Configuration.** `/etc/systemd/oomd.conf.d/10-omarchy.conf` sets 50% pressure for 20 s. `oomctl` reports a swap limit of 90%, and `oomd.conf(5)` says both memory and swap must pass it, which here means about 32 GiB of swap used.
- **What it watches.** `app.slice` only, via `/usr/lib/systemd/user/app.slice.d/10-oomd.conf`. The compositor sits outside it on purpose.
- **It has not acted, as far as the logs show.**
  - The user journal has no line mentioning an oomd kill or `oom-kill` across its whole history, back to 2025-11.
  - The system journal has nothing from `systemd-oomd`, and the kernel log has no OOM kill, since 2026-10-01.
  - One gap: the unit shows a start on 10-23 that has no matching journal entry, so the system journal may be incomplete for this unit.
- **What a kill would take.** `systemd.resource-control(5)` says it selects a descendant cgroup and sends SIGKILL to all its processes. Each tmux pane is its own scope under `app.slice`, so a kill takes a worker with its dev server and browser in one go. Leo's own session and browsers are candidates too.
- **Which one it picks.** The man pages read here do not state the rule, and `oomctl` showing `Pgscan` only hints at reclaim activity. `ManagedOOMPreference=avoid` could protect a scope, subject to the ownership conditions in the man page. That was not tried.

Other memory failures are not oomd's. Core dumps on 10-08 and 10-11 are `node` aborting with V8's out-of-memory handler in the stack, including `eslint .` in zapSell. They are a sign of how large a single tool can get, and they would happen on an empty machine too.

## Fixed number or free memory

A limit derived from free memory fits poorly, for four reasons.

1. **Free memory says little about what a worker will need.** A worker starts at about 0.6 GiB and costs its peak minutes later, so a start decided on today's figure is decided too early.
2. **The signal is noisier than the thing it measures.** MemAvailable moved by about 3 GiB under ordinary work, which is more than one worker's peak.
3. **Starts race.** Several due in one tick would all see the same free memory.
4. **It is hard to explain.** The map wants a person to see what fired and what did not. "Limit 4, 4 running" is clear. A number that changes from minute to minute is not.

Free memory is still useful for one thing: it sees what a worker count cannot, such as Leo's own load and the leftovers. So it should hold back a start, and not set the limit.

### Proposal

- **Limit:** a fixed number configured per machine, **4 on `omarchy`**.
- **How 4 was reached:** about 7.9 GiB is left after non-worker load.
  - At the peak figure (2.4 GiB) that fits 3, and at the typical figure (1.25 GiB) it fits 6. Peaks are brief, and none coincided in these samples, though two workers is a small sample.
  - Six light workers have fitted, while zapSell workers are heavier, so 4 is a margin below that known case. Going over briefly lands in swap, which has room.
- **Starting figure on other machines:** (MemTotal minus measured non-worker load) divided by 2 GiB, rounded to the nearest whole number. That gives 4 here. It comes from one machine, so check it against `engage` and `distilo-1` before relying on it.
- **Brake:** hold a start, and show it as held, when MemAvailable is under 2.5 GiB or `full avg60` PSI is over 10%. These thresholds are judgement. Neither was reached today: MemAvailable stayed above 3.6 GiB and `full avg10` stayed under 2%, well short of oomd's 50%.

## What could lower the cost per worker

These came up during measurement and are outside this ticket.

- **MCP servers per worker.** About 0.4 GiB per worker, more than Claude Code itself. Every worker observed starts `mcp-pdf-server`, whether or not it opens a PDF.
- **Leftovers.** The three scopes above hold about 1.8 GiB between them, mostly swap. Something should reap a worker's scope when its worktree goes.

## Limits of this evidence

- One machine, one evening, three live workers, all on claude-mux. Live non-reclaimable figures for a heavy worker such as zapSell were not measured, only its raw peak.
- Sampling every 15 to 20 s misses short spikes, so the real peaks are at least these.
- The historic peak has two-figure precision and no split between anonymous memory and cache.
- The scope-to-transcript match goes by start time, so a wrong pairing is possible, most of all where several sessions started together.
- The scope of the session that ran this research carried about 2.4 GiB of file cache, partly from reading journals and transcripts for it. That session is not counted as a worker.

## Sources

- Kernel: `/proc/meminfo`, `/proc/pressure/memory`, `/proc/<pid>/smaps_rollup`, cgroup v2 `memory.*` files under `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/`.
- systemd: `journalctl --user`, `journalctl -k`, `coredumpctl`, `oomctl`, `systemctl --user show`, and the man pages `systemd-oomd(8)`, `oomd.conf(5)`, `systemd.resource-control(5)`.
- Omarchy: `/etc/systemd/oomd.conf.d/10-omarchy.conf`, `/usr/lib/systemd/user/app.slice.d/10-oomd.conf`.
- Sessions: `~/.claude/projects/*/*.jsonl`, `~/.claude-mux/sessions/*.json`.
- Daemon: `~/.claude/plugins/cache/aknakos-workflow/ak/1.10.0/scripts/maestro-daemon.sh`.
