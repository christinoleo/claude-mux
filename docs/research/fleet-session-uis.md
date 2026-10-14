# How other tools find, place and resume sessions across machines

Research for #77, part of map #76 ("Run the whole fleet from one page").
Gathered 2026-10-14 from each tool's own docs, README and source. Where a
claim comes from source code, the file is linked at the commit or branch read.

**Short answer.** The tools that handle many sessions well list them flat,
newest activity first, and offer grouping (by machine, project or state) as a
toggle rather than as the only view. They name the machine on a row only when
the row's position doesn't already say it. They grey out a session whose
machine is gone, keep it in the list and say "last seen X". Old sessions go
behind a separate archive or history control, and Resume is tied to the
machine that owns the session, with a stated reason when that machine is
offline. Tailscale's Machines page and Lens add two things the agent tools
lack: a query language over the list (`lastseen:<5d`, `source=…`) kept in the
URL, and a version column that flags out-of-date machines and offers an update.

## Status of the tools (it matters for how much to copy)

| Tool | State on 2026-10-14 | Source |
|---|---|---|
| Claude Squad | Active, terminal app (tmux + worktrees) | [README](https://github.com/smtg-ai/claude-squad) |
| Conductor | Active, macOS app; Conductor Cloud adds remote workspaces | [docs](https://www.conductor.build/docs/) |
| Crystal | Deprecated Feb 2026, replaced by Nimbalyst | [README](https://github.com/stravu/crystal) |
| vibe-kanban | Company shut down 10 Apr 2026; local app continues as community open source, hosted services removed | [shutdown post](https://www.vibekanban.com/blog/shutdown) |
| Happy | Active; mobile/web app + CLI + relay, desktop app separate | [README](https://github.com/slopus/happy) |
| Omnara | Claude Code wrapper (2025) deprecated; now a managed agent platform with "machines" | [old README](https://github.com/omnara-ai/omnara/blob/a255b601da5881ee596aa8cedf7985c803ab36d7/README.md), [docs](https://docs.omnara.com/introduction) |
| Lens | Lens K8s IDE (commercial); OpenLens source last pushed Feb 2025 | [docs](https://docs.lenshq.io/k8slens/using-lens/navigator/), [source](https://github.com/lensapp/lens) |
| Tailscale admin console | Active | [filter docs](https://tailscale.com/docs/features/access-control/device-management/how-to/filter) |

Only Happy, Omnara (new), vibe-kanban (remote access) and Conductor Cloud
actually span machines. Claude Squad and Crystal are single-machine, but their
list design still answers the "find one among many" pain.

## Tool by tool

### Claude Squad

- **List.** One flat "Instances" list in a TUI, navigated with `j/k`; each row
  is title plus a second line with the branch and a diff count. A spinner shows
  a running agent, `●` a ready one, `⏸` a paused one.
  ([ui/list.go](https://github.com/smtg-ai/claude-squad/blob/main/ui/list.go))
- **Placement.** The repo name is appended to the branch line *only when more
  than one repo is in the list* (`hasMultipleRepos`; the list keeps a count of
  instances per repo). Same file.
- **Search/filter.** None.
- **Old sessions.** `c` "Checkout" commits the changes and pauses the session;
  `r` resumes a paused one; `D` kills it. No history of killed sessions.
  ([README](https://github.com/smtg-ai/claude-squad#menu))
- Screenshot: [assets/screenshot.png](https://github.com/smtg-ai/claude-squad/blob/main/assets/screenshot.png).

### Conductor

- **List.** Sidebar of workspaces grouped under their project (repo): a
  project holds "the list of workspaces for that codebase".
  ([workspaces and branches](https://www.conductor.build/docs/concepts/workspaces-and-branches))
- **State grouping.** An experimental option (0.33.5, 0.35.0, Feb 2026) sorted
  workspaces into backlog / in progress / in review / done; 0.39.0 added counts
  on collapsed groups. 0.44.0 (Mar 2026) introduced "a new, simplified sidebar"
  showing GitHub status per row (merged, failing CI, conflicts), when an agent
  needs permission, and metadata plus next actions on hover; clicking a selected
  workspace jumps to its oldest unread chat. Whether group-by-status survived
  0.44.0 is not stated.
  ([0.35.0](https://www.conductor.build/changelog/0.35.0-workspace-status),
  [0.33.5](https://www.conductor.build/changelog/0.33.5-better-archiving),
  [0.44.0](https://www.conductor.build/changelog/0.44.0-new-sidebar-rebuilt-composer-codex-checkpoints),
  sidebar image: [0.44.0 image](https://conductor-marketing.t3.tigrisfiles.io/uploads/1774395513472-image.png))
- **Search.** Exists (0.44.0: "Exact branch name matches now appear first in
  search results"); its scope is not documented.
- **Old sessions.** "Archive finished workspaces so your sidebar stays focused.
  To restore an archived workspace later, open the History pane in the sidebar
  and restore it from there, including its chat history." Archiving commits
  uncommitted files; unarchive always works even if the branch moved.
  ([workflow](https://www.conductor.build/docs/concepts/workflow), 0.33.5)
- **Remote machines (Conductor Cloud).** A cloud workspace "keeps the chat,
  diff, git, terminal, and pull request workflow" of a local one. It sleeps
  after four hours idle; "files and chat history survive sleep; running
  processes don't." While asleep or unreachable, "cloud terminals are
  read-only" and cached git information stays available; opening the workspace
  wakes it; a stuck one shows **Unresponsive** with a **Restart** action.
  ([working with cloud workspaces](https://www.conductor.build/docs/cloud/working-with-cloud-workspaces))
  How a cloud workspace is marked in the sidebar next to local ones is not
  documented.

### Crystal (read at the last pre-deprecation commit)

- **List.** Tree of projects (folder icons, expandable) with sessions under
  each; expansion state remembered, a new session expands its project.
  ([ProjectTreeView.tsx](https://github.com/stravu/crystal/blob/5f36368addeede63872280adb28e932d5ad142e5/frontend/src/components/ProjectTreeView.tsx))
- **Row.** Status text from a fixed set: Initializing, Running, Waiting for
  input, Completed, **New activity** ("Session has new unviewed results"),
  Error; plus a git status indicator, a favourite star and an archive button.
  ([StatusIndicator.tsx](https://github.com/stravu/crystal/blob/5f36368addeede63872280adb28e932d5ad142e5/frontend/src/components/StatusIndicator.tsx),
  [SessionListItem.tsx](https://github.com/stravu/crystal/blob/5f36368addeede63872280adb28e932d5ad142e5/frontend/src/components/SessionListItem.tsx))
- **Search.** None in the sidebar.
- **Old sessions.** Archive (with an archive-progress indicator, since it
  removes the worktree). Continuing a conversation is "Continue conversations
  with your AI assistant" in the same session.
  ([README](https://github.com/stravu/crystal/blob/5f36368addeede63872280adb28e932d5ad142e5/README.md))

### vibe-kanban

- **List.** Left "Workspace Sidebar" with two layouts: a flat list (timestamps,
  change counts) and an accordion "grouped by Needs Attention, Idle, and
  Running". Pinned workspaces stay on top "regardless of their last activity
  time", so the flat list is by activity.
  ([interface](https://vibekanban.com/docs/workspaces/interface),
  [managing workspaces](https://vibekanban.com/docs/workspaces/managing-workspaces);
  screenshots: [flat](https://mintcdn.com/vibekanban/RasI-IDzFWa02fCE/images/workspaces-sidebar.png),
  [accordion](https://mintcdn.com/vibekanban/QA35mU65cg2kMRzj/images/workspaces-sidebar-accordion.png))
- **Row.** Running / Idle / Needs Attention (raised hand), pinned, a blue dot
  when a dev server runs, a PR status badge. The workspace state is derived
  from its sessions.
- **Search.** "Filter workspaces by name or branch." Cmd/Ctrl+K command bar
  reaches workspace actions.
- **Old sessions.** Archive keeps everything (conversation, sessions, notes,
  worktree); archived workspaces are reached through **View Archive** at the
  foot of the sidebar; unarchive any time. Delete is separate and permanent.
- **Other machines.** "Remote Access": the host shows a pairing code, the
  client logs into cloud.vibekanban.com, links the host, and then "clicking on
  the host will list the host's workspaces" — a host-first drill-down, one
  machine at a time. Offline hosts are not documented. This depended on the
  hosted service that the shutdown removes.
  ([remote access](https://vibekanban.com/docs/remote-access),
  [mobile screenshot](https://mintcdn.com/vibekanban/6aVQAAybViVaue7Q/images/remote-access-cloud-mobile.png))

### Happy (the closest match to claude-mux's problem)

All from [`packages/happy-app/sources/components/SessionsList.tsx`](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/components/SessionsList.tsx)
and the English strings in [`text/translations/en.ts`](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/text/translations/en.ts).

- **List.** Default is "the activity-sorted chat list". A setting
  (`sessionListGrouping: 'project'`) switches to a hierarchy: a **machine
  header** (a centred label between two rules, tappable to open the machine's
  page) with project groups under it, each project showing its path and the
  machine's display name.
- **Row.** Avatar, session name, a subtitle (folder name or identity line), and
  a status line: model name, then one of "permission required", "input
  required", "unread", a working message, "online" — or for a disconnected
  session **"last seen <time>"**. Disconnected rows get a grey dot, a
  *monochrome* avatar and a dimmed title. Needing the user stays orange and
  pulsing even when the session is also unread.
- **Offline machines.** When every linked machine is offline the list shows one
  quiet banner ("<name> is offline" / "All machines offline", → Troubleshoot),
  styled "so it reads as a notice rather than an alarm"
  ([OfflineMachinesBanner.tsx](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/components/OfflineMachinesBanner.tsx)).
  The machines list in settings hides offline ones behind "Show N offline
  machines". Starting a session on an offline machine is disabled with "Launcher
  disabled while machine is offline" and a checklist.
- **Old sessions.** Archived sessions are "a flat, date-grouped tail" at the
  bottom, opened by a "Show archived" divider (the setting is synced across
  devices). An inactive session says "This session is inactive." and offers
  **Resume Session** — "Resume this session on the same machine" — refused with
  a stated reason: "This session can only be resumed on the same machine it
  started on", "This machine is offline. Resume is only available while it is
  online", missing machine metadata, or no resumable Claude/Codex id. It also
  prints how to resume from the terminal, and offers **Fork session** ("Continue
  in a new session with the same context"), likewise only while the owning
  machine is online.
- **Search.** None found in the session list.

### Omnara

- **2025 wrapper** (web dashboard,
  [SidebarDashboardLayout.tsx](https://github.com/omnara-ai/omnara/blob/a255b601da5881ee596aa8cedf7985c803ab36d7/apps/web/src/components/dashboard/SidebarDashboardLayout.tsx)):
  sidebar grouped by **agent type** (Claude Code, Codex…), groups expanded by
  default when they hold active instances, a search box matching instance name
  *or latest message*, and a count of instances awaiting input. The instance
  table has Active (active + awaiting input) / Completed / All tabs with counts
  ([InstanceListWithFilters.tsx](https://github.com/omnara-ai/omnara/blob/a255b601da5881ee596aa8cedf7985c803ab36d7/apps/web/src/components/dashboard/instances/InstanceListWithFilters.tsx)).
  No machine was shown. It was dropped because wrapping the Claude Code CLI
  "became unfeasible to maintain with Claude Code's constant updates".
- **Current platform** ([machines overview](https://docs.omnara.com/machines/overview)):
  "the machine does not own the agent" — agents are event logs in the control
  plane and attach machines through bindings; disconnecting a machine does not
  kill the agent. Each machine reports two independent states:
  `lifecycle_state` (provisioning, active, deleting…) and `connection_state`
  (`online`, `asleep`, `offline`). "An `active` machine can be `offline`, for
  example when someone closes a laptop. New commands fail with a retryable
  error", and after a grace period waiting tool calls return
  `machine_unreachable`.

### Lens (several Kubernetes clusters)

- **List.** The Navigator groups clusters by source: *Kubernetes Clusters →
  Local Kubeconfigs*, then EKS/AKS/GKE discovered clusters, then *Teamwork*.
  ([navigator](https://docs.lenshq.io/k8slens/using-lens/navigator/))
  The Catalog is a table whose default columns are Source, Labels and Status
  ([default-category.injectable.tsx](https://github.com/lensapp/lens/blob/master/packages/core/src/renderer/components/catalog/columns/default-category.injectable.tsx)).
- **Search.** A Search dialog lists local and team clusters, also on
  Ctrl/Cmd+P; picking one opens it
  ([find a cluster](https://docs.lenshq.io/k8slens/how-to/find-cluster/)).
  Catalog search matches each column's `searchFilter`, e.g. the token
  `source=<source>` and the status phase.
- **Hotbar.** A left rail of pinned clusters, added by "Add to hotbar", banks
  of up to twelve ([hotbar](https://docs.lenshq.io/k8slens/using-lens/hotbar/)).
  Each icon carries a small LED that lights only when the cluster is
  `connected` ([hotbar-entity-icon](https://github.com/lensapp/lens/blob/master/packages/core/src/renderer/components/hotbar/hotbar-entity-icon.module.scss)).
- **Offline/unreachable.** Phases are connecting, connected, disconnected,
  deleting; the context menu offers Connect or Disconnect accordingly
  ([kubernetes-cluster.ts](https://github.com/lensapp/lens/blob/master/packages/core/src/common/catalog-entities/kubernetes-cluster.ts)).
  A cluster that fails shows its errors and a **Reconnect** button
  ([cluster-status.tsx](https://github.com/lensapp/lens/blob/master/packages/core/src/renderer/components/cluster-manager/cluster-status.tsx)).
  Connecting is an explicit act per cluster.

### Tailscale admin console, Machines page

- **Row.** Machine name, address, OS, the **Version** column — "A gray arrow
  indicates that a standard update is available, a red arrow indicates that a
  security update is available" — and **Last seen**, which shows "connected" or
  a timestamp.
  ([update docs](https://tailscale.com/docs/features/client/update);
  last-seen column wording from a [forum answer](https://forum.tailscale.com/t/api-to-check-if-a-device-is-currently-connected-bool/987),
  not first-party)
- **Search and filters.** Free-text search over machine name, host name, IP,
  user, OS and version "along with text-based equivalents for the filter
  criteria". Filter menus include Last seen (currently connected, not
  connected, in the last / before the last `m h d w y`), Managed by, Version
  (older than, update available), OS, Disabled (expired key, needs approval).
  Different filters AND together, values within one filter OR
  (`managedby:alice,bob lastseen:<5d`). The whole query lives in the URL
  (`?q=…`), so a filter is saved by copying the link.
  ([filter docs](https://tailscale.com/docs/features/access-control/device-management/how-to/filter))
- **Fleet update.** "Start update" sits on a machine's row menu and appears only
  when the device is online and has auto-updates on; the docs give the ready
  filter `version:update-available auto-update:enabled lastseen:connected` to
  list exactly the machines that can be updated now.
  ([update docs](https://tailscale.com/docs/features/client/update))

## Patterns to borrow for the drawer

1. **Flat by recent activity as the default, grouping as a toggle.** Happy
   (activity list ↔ machine → project), vibe-kanban (flat ↔ by state),
   Conductor (by project, experimental by state). For claude-mux: a toggle
   between "by machine" (today's tmux-session grouping under a machine header,
   Happy-style) and a flat recency list across the fleet.
2. **Name the machine only where position doesn't.** Claude Squad shows the
   repo only when more than one repo is listed. Under a machine header, rows
   carry no machine chip; in the flat view, in search results and in Needs you,
   each row gets one. With one machine reachable, no chip at all.
3. **An unreachable machine's sessions stay, dimmed, saying when.** Happy:
   grey dot, monochrome avatar, dimmed title, "last seen 3h ago" in the status
   slot. This matches the map's settled rule. Add Happy's single quiet banner
   when *all* other machines are down, rather than one per machine.
4. **Keep "is the machine reachable" separate from "what was the session
   doing".** Omnara's `connection_state` vs lifecycle, Conductor's
   asleep/unresponsive. A session on an offline machine shows its last known
   state (e.g. `waiting`) greyed, not a fake "dead". Conductor's degraded mode is
   the model for acting on it: transcript readable from cache, terminal and
   composer read-only, with the reason shown.
5. **One search box, two layers.** Free text over session name, project,
   branch *and latest message* (Omnara, vibe-kanban, Tailscale), plus
   structured tokens that the UI filters also write: `machine:engage
   state:waiting seen:<1d` (Tailscale's `lastseen:<5d`, Lens's `source=`). Put
   the query in the URL so a filtered view is a link — this also helps the
   map's open question on shareable links.
6. **A quick switcher on Ctrl/Cmd+K or P** that searches every machine (Lens
   Ctrl+P, vibe-kanban Cmd+K), opening the session where it lives.
7. **Past sessions behind their own control, date-grouped.** Happy's "Show
   archived" tail, vibe-kanban's "View Archive", Conductor's History pane. The
   live drawer stays about live sessions.
8. **Resume belongs to the origin machine, and says so.** Happy's Resume is
   "on the same machine", greyed with the exact reason when that machine is
   offline, and offers the terminal command as a fallback. claude-mux's
   transcripts live on the origin machine, so the same rule fits; Fork (new
   session with the context) is the escape hatch.
9. **Version drift as a column with a filter and a guarded action.**
   Tailscale's grey/red arrow on the version, a filter for "update available",
   and "Start update" only when the machine is online. Maps directly to the
   map's "flag a machine that differs and offer to update it".
10. **Attention first, everywhere.** vibe-kanban's Needs Attention group,
    Omnara's awaiting-input count, Conductor showing permission requests in
    the sidebar, Happy keeping "needs you" orange even when unread. Already
    claude-mux's Needs you; across the fleet it just needs the machine chip.
11. **Pin** (vibe-kanban pin to top, Crystal star) for the few sessions Leo
    returns to, independent of activity order.

## Patterns to avoid

1. **Machine first, then drill in.** vibe-kanban's remote access lists hosts
   and you click a host to see its workspaces; Lens makes you connect each
   cluster before it is usable. Both defeat "find any session quickly" — the
   top pain. Sessions from every machine must be in one list and one search.
2. **Hand-curated rails.** Lens's hotbar (twelve per bank, added one by one)
   is upkeep; pin plus recency covers the need.
3. **Pairing codes, accounts or a relay.** vibe-kanban (pairing code + cloud
   login) and Happy (account + relay) need them because they cross networks;
   the tailnet already authenticates claude-mux machines, and vibe-kanban's
   remote access died with its hosted service.
4. **Hiding offline machines by default.** Happy hides them in its machine list
   behind "Show N offline machines"; for the drawer the map has already decided
   the opposite. Fine for a machines settings page, wrong for sessions.
5. **Status columns as the main view.** Conductor's backlog/in progress/in
   review/done grouping stayed behind an experimental flag and was followed by
   a "simplified" sidebar; vibe-kanban built its product around kanban and shut
   down (for business reasons, but its sidebar still defaulted to a flat list).
   Grouping by state is a useful toggle, not the default.
6. **Resuming silently somewhere else.** No tool moves a session to another
   machine on resume; Happy refuses explicitly. Don't offer "resume here" for a
   session whose transcript and worktree are on another machine without saying
   that it will run there.
7. **Grouping by agent type** (Omnara 2025). Leo runs one agent; group by
   machine or project instead.

## What I could not verify

- Tailscale's exact row styling (connected dot colour, how an offline row is
  drawn): the console needs a login and the docs don't describe it; the "Last
  seen shows connected or a timestamp" detail comes from a forum answer.
- Conductor: whether group-by-status survived the 0.44.0 sidebar, how a cloud
  workspace is marked next to local ones, and the scope of its search.
- vibe-kanban: how an offline paired host looked.
- Happy: whether the desktop app (separate repo, `slopus/happy-desktop`) lays
  out the list differently from the mobile/web app read here.
- Screenshots are linked, not copied into the repo.
