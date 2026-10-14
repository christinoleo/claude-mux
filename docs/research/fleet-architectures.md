# How remote tools split the app from the machines

Research for [#78](https://github.com/christinoleo/claude-mux/issues/78), part of
map [#76](https://github.com/christinoleo/claude-mux/issues/76) "Run the whole
fleet from one page". Read on 2026-10-14.

Sources are the tools' own docs and source. Repos were read at these commits:

- t3code `pingdotgg/t3code` @ [`06a84de`](https://github.com/pingdotgg/t3code/tree/06a84de3bd613b00f6a1fc61f7f71ea26534ef09) (abbreviated `T3:` below, paths relative to the repo)
- Happy `slopus/happy` @ [`fda37d2`](https://github.com/slopus/happy/tree/fda37d23fa044bb03093a62bdb48a1d5689790c9) (`HP:`)
- Omnara `omnara-ai/omnara` @ [`d6324a1`](https://github.com/omnara-ai/omnara/tree/d6324a1dd3e889cee97e5bac728c701f8017ebfe) (`OM:`), plus its README at [`fa80862`](https://github.com/omnara-ai/omnara/blob/fa808622ed5eead79cfdb4eb6411bff4e76ab722/README.md) (September 2025) for the older Claude Code wrapper
- VS Code: [Remote overview](https://code.visualstudio.com/docs/remote/remote-overview), [Tunnels](https://code.visualstudio.com/docs/remote/tunnels), [Remote FAQ](https://code.visualstudio.com/docs/remote/faq), [Supporting remote development](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
- Zed: [Remote development](https://zed.dev/docs/remote-development)
- Tailscale: [Serve, identity headers](https://tailscale.com/kb/1312/serve)

## The short version

Every tool keeps execution, files and terminals on the machine that owns the
work. They differ in two ways: where the UI's code comes from, and whether the
UI reaches each machine directly or through something in the middle.

| Tool | UI runs | UI reaches machines | Middle | Discovery and auth | Version rule | Machine offline |
|---|---|---|---|---|---|---|
| t3code | Browser, desktop or mobile client, served from anywhere (even app.t3.codes) | **Directly**, one HTTP+WebSocket connection per environment | Optional T3 Connect relay brokers credentials and tunnels; it carries no app traffic | Pairing link/QR per device, or a cloud account; scoped sessions issued by each environment | Same orchestration protocol or the connection is refused; features gated on advertised capabilities | Cached projections stay readable, marked not live |
| VS Code Remote | Local desktop, or vscode.dev in a browser | Through SSH, or a Microsoft dev tunnel | Azure dev tunnels relay (tunnels mode only) | SSH keys, or the same GitHub/Microsoft account on both ends | Server must match the client version exactly; client installs it | Unreachable; nothing cached |
| Zed remote | Local desktop | Over one SSH ControlMaster per project | None | SSH | Server must match exactly; client downloads it | Reconnect later; unsaved edits kept locally |
| Happy | Mobile/web/desktop app | **Through a central server** (Socket.IO), never directly | Happy server holds sessions, messages, presence (end-to-end encrypted) | Account keypair; daemon and app both sign in to the server | Envelope versioning in a shared wire package; app-store version check | Server keeps history; machine marked inactive after 10 min |
| Omnara (2025) | Web dashboard, mobile app | **Through a central API** | Omnara cloud stores agent messages | API key | n/a (pip upgrade) | Cloud keeps history |
| Omnara (2026) | Web dashboard / API | **Through the control plane** | Control plane owns the agent; machines run `omnarad` | Machine token; daemon dials out | Daemon updates itself | Machine `offline`; agent survives in the control plane |

## t3code

t3code is the closest match to claude-mux: an agent-session dashboard where
one client drives many machines, each running its own server.

**Where the UI runs.** Execution stays in the "environment" (a server on a
machine); web, desktop and mobile clients control it over authenticated RPC
([T3: docs/internals/overview.md](https://github.com/pingdotgg/t3code/blob/06a84de3bd613b00f6a1fc61f7f71ea26534ef09/docs/internals/overview.md)).
The desktop renderer is not served by its own backend: a `t3code://` scheme
serves the bundled client from disk, and "API traffic always goes to the
environment's own URL". The desktop app can even run with no local
environment and drive only remote ones
([T3: docs/internals/remote.md](https://github.com/pingdotgg/t3code/blob/06a84de3bd613b00f6a1fc61f7f71ea26534ef09/docs/internals/remote.md)).

**Who talks to whom.** "Each connection joins a client to one environment over
HTTP and WebSocket." Direct access, Tailscale, SSH and T3 Connect only change
how the client reaches that server. The hosted web app "stores its connection
catalog in the browser and connects directly to each environment. It does not
proxy traffic or hold server-side pairing state", so an HTTPS-hosted UI cannot
reach a plain-HTTP LAN backend (same doc). Web, desktop and mobile share one
connection owner per environment in `packages/client-runtime`, with one retry
supervisor, jittered backoff capped at five minutes, and a registry scoped by
environment
([T3: docs/internals/connection-runtime.md](https://github.com/pingdotgg/t3code/blob/06a84de3bd613b00f6a1fc61f7f71ea26534ef09/docs/internals/connection-runtime.md)).

**Identity and routes.** "An environment keeps its ID across server restarts
and endpoint changes." A saved environment holds an ordered list of routes
(LAN, Tailscale, public URL, SSH, T3 Connect); the client connects over the
first that works and keeps checking earlier ones. A connected server reports
its LAN and tailnet addresses, which the client saves as learned routes.
"Advertised endpoints are reachability hints. Only the connecting device can
prove that a route works", and a host's loopback must never be handed to
another device (remote.md;
[T3: docs/user/remote-access.md](https://github.com/pingdotgg/t3code/blob/06a84de3bd613b00f6a1fc61f7f71ea26534ef09/docs/user/remote-access.md)).

**Discovery and auth.** No network scan: a device is added by a one-time
pairing link or QR code, or by signing in to T3 Connect, which lists the
account's environments. Tailscale "supplies an endpoint for ordinary pairing,
so it needs no separate environment type. Authentication remains the
environment's responsibility for every route" (remote.md). Pairing delegates
scopes (`orchestration:read`, `filesystem:read`, `source-control:write`, ...);
every RPC declares a required scope, checked before its handler runs, and
bearer clients get short-lived WebSocket tickets so tokens stay out of socket
URLs
([T3: docs/internals/environment-auth.md](https://github.com/pingdotgg/t3code/blob/06a84de3bd613b00f6a1fc61f7f71ea26534ef09/docs/internals/environment-auth.md)).
The T3 Connect relay (a Cloudflare Worker plus managed Cloudflare tunnels) is
a credential broker: "After bootstrap, clients send application traffic
through the environment's tunnel hostname; the relay Worker does not proxy
their HTTP or WebSocket sessions"
([T3: docs/internals/t3-connect.md](https://github.com/pingdotgg/t3code/blob/06a84de3bd613b00f6a1fc61f7f71ea26534ef09/docs/internals/t3-connect.md)).

**Version mismatch.** Clients and servers are "independently versioned"; the
RPC contract is the boundary. "A client and server must speak the same
orchestration protocol. If they do not, the connection is refused rather than
running half-upgraded": an app newer than the server is blocked with a notice
naming the machine to update; a newer server refuses the app
([T3: docs/user/updating.md](https://github.com/pingdotgg/t3code/blob/06a84de3bd613b00f6a1fc61f7f71ea26534ef09/docs/user/updating.md)).
Within one protocol, features are negotiated through capabilities the
environment advertises, "never through a client version" (overview.md). One
sidebar button "updates every connected machine in one step", servers first,
the desktop app last, listing machines it skips (offline, manual) and the
running threads the restarts will interrupt (updating.md). A stable launcher
under systemd/launchd stages an exact version, trials it, and rolls back on
failure; clients correlate an update ID after reconnecting, since a reconnect
alone cannot tell success from rollback
([T3: docs/internals/server-updates.md](https://github.com/pingdotgg/t3code/blob/06a84de3bd613b00f6a1fc61f7f71ea26534ef09/docs/internals/server-updates.md)).

**Machine offline.** "An involuntary disconnect retains the registration and
cached data." "Cached projections remain readable offline. They must neither
imply a live connection nor overwrite newer live data during a reconnect"
(connection-runtime.md). The cache lives in each client (the mobile app has an
`environment-cache-store`), so it is per device.

**Terminal and files.** "The environment server owns PTYs, session lifetime,
and retained output. Every client, including the desktop renderer, attaches
through the environment connection", so clients can reconnect to or share a
running terminal. Live events carry only new chunks; history is capped at
5,000 lines / 8 MiB per terminal on the server and 512 KiB in the client
([T3: docs/internals/terminal-runtime.md](https://github.com/pingdotgg/t3code/blob/06a84de3bd613b00f6a1fc61f7f71ea26534ef09/docs/internals/terminal-runtime.md)).
Files go over the same connection under `filesystem:read`/`write` scopes;
media uses signed per-file asset URLs (environment-auth.md). Browser tabs
belong to the environment and are streamed to other devices
(remote-access.md).

**Cross-machine features.** Projects group checkouts across environments, and
optional load balancing picks a machine for a new thread from CPU and memory;
"existing threads stay where they started" (remote-access.md). "A project and
its threads belong to one environment" and identity "never routes work
between them" (remote.md).

## VS Code Remote (SSH, tunnels)

**Where the UI runs.** UI extensions "are always run on the user's local
machine"; workspace extensions run in a "Remote Extension Host that sits in a
small VS Code Server" on the remote. Webviews always run locally or in the
browser, and `localhost` inside a webview is the user's machine, so remote
servers are reached by message passing or port forwarding
([Supporting remote development](https://code.visualstudio.com/api/advanced-topics/remote-extensions)).

**Transport.** Remote-SSH uses "an authenticated, secure SSH tunnel"; the
server "is started with a randomly generated key, and any new connection to
the server needs to provide the key"
([FAQ](https://code.visualstudio.com/docs/remote/faq),
[Troubleshooting](https://code.visualstudio.com/docs/remote/troubleshooting)).
Tunnels mode uses Microsoft dev tunnels hosted in Azure: both ends dial out,
"VS Code doesn't set up any network listeners", and an SSH session runs over
the tunnel for end-to-end encryption
([Tunnels](https://code.visualstudio.com/docs/remote/tunnels)).

**Discovery and auth.** Remote-SSH: the user names a host. Tunnels: "Both
hosting and connecting to a tunnel requires authentication with the same
GitHub or Microsoft account on each end"; registered machines appear in Remote
Explorer and at `https://vscode.dev/tunnel/<machine>/<folder>` (Tunnels).

**Version mismatch.** "The server needs to match the VS Code client version
exactly" (Supporting remote development). The client installs and updates the
server on connect, so mismatch is solved by installing the matching build per
client (FAQ). (Not checked in the docs: that builds are kept side by side
under `~/.vscode-server` keyed by commit; that is common knowledge, not cited.)

**Machine offline.** A tunnel exists only while its host process runs;
`code tunnel service install` keeps it up. A tunnel instance "is designed to
be accessed by one user or client at a time" (Tunnels). Nothing is cached for
an unreachable machine.

**Terminal and files.** Not described in the docs read; both travel over the
same remote connection as everything else, since workspace extensions and the
terminal run in the server.

## Zed remote development

"On your local machine, Zed runs its UI"; "the source code, language servers,
tasks, and the terminal all run on the remote server", a headless Zed. "The
two communicate over SSH": Zed creates one SSH ControlMaster per project and
multiplexes the Zed protocol, terminals and tasks over it. The server binary
lives in `~/.zed_server` and "the version must exactly match the version of
Zed itself"; Zed downloads it on a mismatch. Each connection runs the server
in proxy mode, which "will start the daemon if it is not running, and
reconnect to it if it is"; unsaved changes persist locally so a later
reconnect restores them. The docs say nothing about multiple clients on one
remote or an offline-machine view
([Remote development](https://zed.dev/docs/remote-development)).

## Happy

**Where the UI runs.** A mobile/web/desktop app; on each machine a CLI wraps
Claude Code or Codex and a daemon spawns sessions in the background
([HP: README.md](https://github.com/slopus/happy/blob/fda37d23fa044bb03093a62bdb48a1d5689790c9/README.md),
[HP: docs/cli-architecture.md](https://github.com/slopus/happy/blob/fda37d23fa044bb03093a62bdb48a1d5689790c9/docs/cli-architecture.md)).

**Who talks to whom.** Everything goes through the Happy server (Fastify,
Postgres, Redis, S3). One Socket.IO endpoint `/v1/updates` takes three scopes:
user-scoped (apps), session-scoped (one session process), machine-scoped (one
daemon). Durable changes fan out as `update` events to rooms; presence as
`ephemeral` events. Point-to-point control is RPC over the same socket: a
session or daemon registers a method in room `rpc:<userId>:<method>`, the
caller emits `rpc-call`, the server forwards it, and "if no target is present,
the server waits briefly for reconnect before failing"
([HP: docs/realtime-sync-and-rpc.md](https://github.com/slopus/happy/blob/fda37d23fa044bb03093a62bdb48a1d5689790c9/docs/realtime-sync-and-rpc.md),
[HP: docs/backend-architecture.md](https://github.com/slopus/happy/blob/fda37d23fa044bb03093a62bdb48a1d5689790c9/docs/backend-architecture.md)).
"All RPC flows through Socket.IO. No direct REST exposure" of the machine
(cli-architecture.md). The daemon's own control server binds `127.0.0.1` only.

**Discovery and auth.** Accounts are keypairs: `POST /v1/auth` verifies a
signature and returns a bearer token; a terminal auth request is approved from
an already signed-in app
([HP: docs/api.md](https://github.com/slopus/happy/blob/fda37d23fa044bb03093a62bdb48a1d5689790c9/docs/api.md)).
A daemon registers its machine (`POST /v1/machines`) with encrypted metadata
(host, platform, CLI version, paths) and heartbeats; the app lists machines
from the server. Content is encrypted on the clients and the server is kept
"blind to user content"
([HP: docs/encryption.md](https://github.com/slopus/happy/blob/fda37d23fa044bb03093a62bdb48a1d5689790c9/docs/encryption.md)).

**Version mismatch.** Wire schemas live in a versioned shared package
(`@slopus/happy-wire`), and encrypted blobs carry a version byte so clients
"can interoperate across versions" (encryption.md). The server's
`/v1/version` only tells mobile apps whether the store build is current
([HP: packages/happy-server/sources/app/api/routes/versionRoutes.ts](https://github.com/slopus/happy/blob/fda37d23fa044bb03093a62bdb48a1d5689790c9/packages/happy-server/sources/app/api/routes/versionRoutes.ts)).
The daemon "validates the running version" at start; the CLI version is
recorded in machine metadata. No fleet-wide update was found.

**Machine offline.** Sessions and messages live in Postgres, so history stays
readable. A loop marks sessions and machines `active: false` after 10 minutes
without activity and emits an ephemeral to the user's apps
([HP: packages/happy-server/sources/app/presence/timeout.ts](https://github.com/slopus/happy/blob/fda37d23fa044bb03093a62bdb48a1d5689790c9/packages/happy-server/sources/app/presence/timeout.ts)).

**Terminal and files.** There is no remote PTY: the app shows the session as
synced chat messages. Machine actions are RPC handlers a session registers:
`bash` (run a command, return output), file read/write, `ripgrep`,
`difftastic`
([HP: packages/happy-cli/src/modules/common/registerCommonHandlers.ts](https://github.com/slopus/happy/blob/fda37d23fa044bb03093a62bdb48a1d5689790c9/packages/happy-cli/src/modules/common/registerCommonHandlers.ts)).
New sessions start by `spawn-session` RPC to the daemon.

## Omnara

Omnara changed shape between the two snapshots read.

**2025 (Claude Code wrapper).** `omnara` wrapped Claude Code or Codex so a
session was "synced between terminal, web, and mobile"; `omnara headless` ran
it with no terminal UI and `omnara serve` "exposes an endpoint that allows you
to launch Claude Code instances remotely from the Omnara dashboard". The
architecture diagram has agents sending updates to the Omnara API server,
which stores them in Postgres, syncs them to the web and mobile apps and
delivers user responses back to the agent
([OM 2025: README.md](https://github.com/omnara-ai/omnara/blob/fa808622ed5eead79cfdb4eb6411bff4e76ab722/README.md)).
A central app, with the machine as a reporter.

**2026 (managed agent platform).** "Every machine runs the same small daemon,
`omnarad`, which connects outbound to the control plane. You do not need to
open inbound ports." "The machine does not own the agent. Agents live in the
control plane as event logs; machines are execution environments they can
attach and release. Disconnecting a machine does not kill the agent." A
machine has a `connection_state` of `online`, `asleep` or `offline`; while
offline, new commands fail with a retryable error and waiting tool calls
eventually return `machine_unreachable`
([OM: docs/machines/overview.mdx](https://github.com/omnara-ai/omnara/blob/d6324a1dd3e889cee97e5bac728c701f8017ebfe/docs/machines/overview.mdx)).
A machine is registered by a one-time machine token, and the installer sets
`omnarad` up as a systemd/launchd user service that "updates itself"
([OM: docs/machines/connect.mdx](https://github.com/omnara-ai/omnara/blob/d6324a1dd3e889cee97e5bac728c701f8017ebfe/docs/machines/connect.mdx);
self-update in
[OM: internal/omnarad/update.go](https://github.com/omnara-ai/omnara/blob/d6324a1dd3e889cee97e5bac728c701f8017ebfe/internal/omnarad/update.go)).
The daemon holds a JSON WebSocket with heartbeats; the control plane offers it
processes and actions (`process_offer`, `action_offer`, `report`), and it runs
them with a PTY where needed
([OM: internal/daemonprotocol/protocol.go](https://github.com/omnara-ai/omnara/blob/d6324a1dd3e889cee97e5bac728c701f8017ebfe/internal/daemonprotocol/protocol.go),
[OM: internal/machinedaemon/client_socket.go](https://github.com/omnara-ai/omnara/blob/d6324a1dd3e889cee97e5bac728c701f8017ebfe/internal/machinedaemon/client_socket.go)).
Omnara no longer wraps Claude Code; it runs its own agent loop.

## What claude-mux has today

Each machine runs its own server, serving the page and the API at
`https://<machine>.<tailnet>.ts.net:<port>`
(`web/src/lib/server/discover.ts`). `/api/servers/discover` reads `tailscale
status` and probes peers. The page's `fleet.svelte.ts` opens a read-only
sessions socket to each other machine; acting on a remote session navigates to
that machine's URL. `hooks.server.ts` already answers CORS (GET, POST, DELETE)
for every `/api/` route from tailnet origins (`*.ts.net`, loopback) except
`/api/browser/`, and WebSockets carry no origin check except the browser
stream. That is t3code's "client connects directly to each environment",
used only for reads so far.

## Candidate architectures for claude-mux

Checked against the settled constraints in #76: no machine is a hub; any link
serves the same interface; tailnet membership is the authentication; one fleet
version with mismatches flagged and offered an update; an off machine keeps
its sessions dimmed with last known state and "seen X ago"; pain order is
finding, acting remotely without leaving the page, reopening past sessions,
knowing the machine.

### A. The browser talks to every machine directly (t3code's model)

The page, wherever it was loaded from, opens sessions, transcript and terminal
sockets and makes API calls straight to the machine that owns each session.
Today's fleet store, extended from reads to everything.

- No hub, and every link is the same page: holds by construction.
- Tailnet auth: each request comes from the user's own device, so `tailscale
  serve` can attach `Tailscale-User-Login` (not for tagged devices). Most of
  the cross-origin plumbing exists (CORS on `/api/`); the open items are the
  browser-control routes, which refuse other origins on purpose, and a
  deliberate origin check on the terminal and input sockets, which today
  accept any origin.
- Version: the page's code from machine X calls machine Y's API. With one
  fleet version this works; during a rolling update the page must read Y's
  version first and degrade or block (t3code refuses on protocol mismatch).
- Offline machines: the last known state has to live in the browser, and
  browser storage is per origin, so the omarchy link and the engage link would
  each have their own cache, and a fresh phone has none. This collides with
  "the same interface from any link".
- Acting remotely: the terminal and transcript stream straight from the owner,
  one hop. A phone holds N sockets (three machines today).
- Fleet actions (update all, combined usage, Needs you) run in the browser by
  fanning out; they stop when the tab closes.
- Smallest change from today.

### B. The origin machine relays to the others

The browser talks only to the machine that served the page. That server opens
server-to-server connections to every peer and proxies API calls and sockets
(or re-broadcasts merged streams). Every machine runs the same relay code, so
any of them can be the origin.

- No hub: holds, since every server is a relay; a machine that is down is only
  not an origin, and any other link still works.
- Same origin: no CORS, no cross-site WebSocket checks; one browser socket can
  carry every machine's sessions.
- Tailnet auth: peer-to-peer calls are authenticated by the tailnet, but the
  peer sees the origin machine, not the user (no identity headers between
  tagged or machine identities). Fine for one person's tailnet; it loses
  per-user identity if that ever matters.
- Offline machines: the origin server can persist each peer's last broadcast
  on disk, so "seen X ago" survives reloads and new devices. Every server keeps
  its own copy, so two links can still disagree slightly on when a machine was
  last seen.
- Version: version checks become server-to-server, in one place; the origin
  can flag a peer's version and call its update route.
- Fleet actions and Web Push can run on the server, independent of any tab
  (the push monitor already runs at server start).
- Cost: terminal and transcript bytes take two hops (owner, origin, browser);
  on a tailnet that is a few milliseconds, but the origin's server now carries
  every stream the user watches, and the proxy has to cover WebSocket upgrade,
  backpressure and reconnects for every channel.

### C. One app, with agents on the machines (Happy, Omnara, VS Code tunnels)

A single service holds sessions, history and presence; each machine runs a
thin agent that dials in and executes commands. This is the shape Happy and
Omnara use.

- Breaks "no machine is a hub" unless the service is replicated across
  machines, which turns it into a distributed-state problem. It is a change of
  model and would need to be argued for and agreed with Leo.
- Gives the best offline story (history stored in one place, machine shown
  offline, Omnara's "the machine does not own the agent") and one place for
  fleet actions and push deduplication.
- The cost is a rewrite of the server into two roles, a new protocol, and a
  single point of failure for the page.

### D. Mesh for state, direct for streams (found in combining A and B)

Every server subscribes to every peer's sessions stream (a server-side mesh,
which `discover.ts` and the usage aggregator already half do) and keeps the
merged fleet state with each machine's last-seen time. The browser gets the
fleet list, Needs you, and offline machines from its origin, same-origin. The
heavy, per-session streams (terminal, transcript, input) go straight from the
browser to the owner, as in A.

- No hub; the same interface from any link, with server-held offline state.
- Fleet actions and Push run server-side, as in B.
- Streams stay one hop, but the cross-origin concerns from A remain for the
  per-session channels.
- Two paths to reason about instead of one.

### What the others teach, whichever is chosen

- Give each machine an ID that survives restarts and address changes, and
  treat its addresses as hints (t3code). claude-mux keys machines by hostname
  today; `INSTANCE_ID` exists in `discover.ts`.
- Refuse a protocol mismatch outright and name the machine to update; gate
  smaller features on capabilities the machine advertises, not on its version
  (t3code). One "update all" that orders servers and lists what it skips
  (t3code).
- Keep one connection owner per machine in the client, with one retry policy
  and jittered backoff, so several views do not race reconnects (t3code).
- Separate "socket open" from "data current" and never let cached state look
  live (t3code).

## Not verified

- VS Code's on-disk layout of server builds by commit, and how its terminal
  traffic is framed: not stated in the docs read.
- Zed: behaviour with several clients on one remote, and any offline view.
- Happy: whether any client offers a raw terminal view; the docs and the
  handlers read show only chat sync and command RPC.
- Omnara 2025: details beyond its README (transport, version handling) were
  not read, since that code has been replaced.
- Latency and memory of proxying terminal streams through an origin (B) were
  reasoned, not measured.
