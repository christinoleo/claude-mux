# What blocks acting on another machine's session (today's code)

Research for #79, map #76. Audited at `e857f61` (0.30.9). Live probes were GET or
OPTIONS requests only, run on 2026-10-14 from omarchy against engage and distilo.

## Summary

The network layer is mostly open already. Every machine sends CORS headers to
any `*.ts.net` or loopback origin, and no route uses cookies or a login. The
WebSockets check no origin at all. A page from omarchy can read and post JSON to
engage today, which the live probes confirmed. What blocks acting on a remote
session is the page. Nearly every request in the session page, the composer and
the side panel goes to the page's own origin, and the session is looked up only
in the local `sessionStore`. Two requests are refused by the server even when
the client gets the URL right: attachments, refused by SvelteKit's CSRF check,
and queue reorder/edit, because the CORS preflight does not allow `PATCH`.

Splits get around all of this already. A split pane is the remote machine's own
session page in an iframe (`?embed=1`), so it is same-origin with its own server.

## What already exists

- **`/api/servers/discover`** (`web/src/lib/server/discover.ts`) runs
  `tailscale status --json`, builds `https://<MagicDNS name>:<port>` for every
  online peer, probes `/api/health` (1.5 s), and removes duplicates by instance id.
  `<port>` is the port the request came in on, or 3456 when there is none
  (`routes/api/servers/discover/+server.ts:7`). Live: it returns distilo,
  engage and omarchy, all on `https://…taimen-pirarucu.ts.net:3456`.
  `/api/health` returns no version number.
- **`fleet.svelte.ts`** opens one read-only `/api/sessions/stream` socket per
  discovered peer (`RemoteSessions`), and keeps that machine's `sessions`,
  `projects` and `inbox`. `machines` puts the local machine first. The selected
  machine is kept in `localStorage` (`claude-mux-machine`).
- **The sidebar's own remote actions** (`AllSessionsPanel.svelte`, `apiBase(machine)`):
  it can kill a session, close a project (`DELETE /api/projects`), create a new
  session in a project (`POST /api/projects/new-session`), start a wayfinder
  ticket, and mark a session unread (`postVisit(base, …)`). Opening a remote
  session navigates to that machine (`:454`), and "New project" on a remote
  machine goes there too (`:572`).
- **Splits** (`split-refs.ts`, `SplitView.svelte`): `host@target` refs, and each
  pane is an iframe of `paneUrl()` on that machine. Remote pages send no
  `X-Frame-Options` and no CSP `frame-ancestors` (checked live on engage), so
  they can be framed.
- **Server-side fan-out already has a precedent**: `/api/usage/all` combines usage
  across the fleet on the server (`src/usage/fleet.ts`), so `/api/usage` needs no
  CORS headers.
- **CORS** (`web/src/hooks.server.ts:41-87`): `OPTIONS` under `/api/` answers 204.
  Every `/api/` response except `/api/browser/*` gets
  `Access-Control-Allow-Origin: <origin>`, with
  `Methods: GET, POST, DELETE, OPTIONS` and `Headers: Content-Type`. The origin
  must match `TRUSTED_ORIGIN` (`src/server/ws-handlers.ts:1998`), which accepts
  `http(s)://*.ts.net[:port]`, `localhost` and `127.0.0.1`. Live: engage and
  distilo answer omarchy's origin with 204/200 and the headers. An
  `https://evil.example` origin and the MagicDNS short name `http://omarchy:3456`
  get no CORS header.
- **No credentials**: there are no cookies and no `credentials:` option anywhere
  (grep), so the CORS requests need no `Allow-Credentials`.

## Request-by-request

"Can target" means the client code can already send the request to a machine
other than the one that served the page. Size: **S** means changing the base URL
at the call site, **M** means changing a component or store to be keyed by
machine, **L** means a structural change.

### WebSockets (`hooks.server.ts`, `src/server/ws-handlers.ts`)

| Channel | Used by | Can target | What blocks it | Size |
|---|---|---|---|---|
| `/api/sessions/stream` | `sessions.svelte.ts` (local), `fleet.svelte.ts` (peers) | **Yes**, through fleet | Nothing. It accepts any Origin (live: an `evil.example` upgrade got 101). | none |
| `/api/sessions/<target>/stream` (terminal) | `terminal.svelte.ts:68` | No | The URL is built from `window.location.host`. Nothing on the server blocks it: there is no origin check, and input goes over REST. The server also accepts `resize` from any origin. | S (store takes a base) |
| `/api/sessions/<id>[/agents/<a>]/transcript/stream` | `transcript.svelte.ts:87` | No | `window.location.host`. Nothing on the server blocks it. | S |
| `/api/browser/<tab>/stream` | `browserStream.svelte.ts:42` | No, **on purpose** | `browserOriginAllowed()` (`browser-view.ts:650`) requires Origin host == Host, and `/api/browser/*` is excluded from CORS (`hooks.server.ts:85`), because the stream drives a logged-in browser. | M, and needs a security decision |

### REST from the session page, composer and status line (`routes/session/[target]/+page.svelte`)

| Request | Can target | What blocks it | Size |
|---|---|---|---|
| Session lookup (`sessionStore.sessionByTarget` / `sessionById`, `:65-71`) | No | Only the local socket is consulted, and the route `/session/[target]` has no machine in it. tmux targets (`main:1.0`) can repeat across machines; session ids are UUIDs. | **L**: the page needs a machine context, from the route or from `fleetStore` |
| `POST send` / `steer` / `send-now` / `rc` / `restart` / `kill` | No (relative) | JSON POST, so CORS allows it. Only the URL is in the way. | S each |
| `GET/POST/DELETE queue` | No | Relative URL. | S |
| `PATCH queue` (edit, `:1358`; reorder, `QueueStrip.svelte:70`) | No | **Not in `Access-Control-Allow-Methods`**, so the browser's preflight rejects it. | S (add `PATCH` in `hooks.server.ts`) |
| `POST attach` (`:1406`, `multipart/form-data`) | No | **SvelteKit CSRF** (`@sveltejs/kit` 2.70.3 `respond.js:81-97`): a cross-origin POST/PUT/PATCH/DELETE with a form content type gets a 403 before `handle` runs, so the 403 also has no CORS headers. This check runs only in production builds (`!__SVELTEKIT_DEV__`), so testing on the dev server will not show it. | S–M: `kit.csrf.trustedOrigins` cannot express `*.ts.net`, so either `csrf.checkOrigin: false` plus a check of our own in `handle`, or send the file as a raw body (as voice does) |
| `POST voice` (`voice.svelte.ts:217`, `Content-Type: audio/*` raw body) | No | Relative URL. A non-form type is preflighted and allowed. Each machine needs its own Whisper key. | S |
| `POST visit` | **Yes** (`postVisit(base, …)`) | Nothing, but the session page calls it with `''`. | S |
| `GET commands` (slash-command list) | No | Relative. The list comes from the serving machine's `~/.claude`, so on a remote session it would list the wrong machine's commands. | S |
| `GET github/ref` | No | Relative. Runs `gh` on the serving machine. It works from any machine whose `gh` is logged in, so it does not block. | none / S |
| `GET changes?source=session` (`:340`) | No | Relative. | S |
| `GET/POST rename`, `kill` (`RenameSessionDialog.svelte`) | No | Relative. | S |
| `GET tmux/panes` (`tmuxPanes.svelte.ts`) | No | Relative, and lists only the local tmux. The page uses it to decide "plain pane vs Claude" (`:81`). | M |
| `GET/POST settings`, `projects` (`sessions.svelte.ts`) | Partly (`DELETE projects` in the sidebar) | Relative. These are per-machine settings. | S |
| `<img src="/api/files/image?path=…">` (`TranscriptView.svelte:856`, `ScreenshotsPanel.svelte`) | No | Relative. Cross-origin `<img>` loads need no CORS, so only the URL is wrong. | S |
| `screenshots` | No | Relative. | S |

### Side panel (`web/src/lib/components/side-panel/`)

| Pane | Requests | Can target | What blocks it | Size |
|---|---|---|---|---|
| Files | `files/tree`, `files/read`, `files/list` (`FilesPane.svelte:43`, `api` derived from a relative base) | No | Relative URL. All GET, so CORS allows them. | S |
| Changes | `changes`, `changes/diff`, `files/read` | No | Relative. | S |
| History | `history`, `history/commit`, `history/diff`, `history/file` (`HistoryPane.svelte:28`) | No | Relative. | S |
| Project | `sessions/<id>/project` | No | Relative. | S |
| Web | `sessions/<id>/web` (dev servers found by `ss` on that machine), `/api/web/frame` (header check) | No | Relative. `resolveEmbed()` (`side-panel/web.ts`) decides how to frame using the page's own origin and the tailscale serve mappings, so a remote machine's `localhost` URL would be resolved against the wrong machine. | M |
| Browser view | `/api/browser/tabs` + browser stream | No, **on purpose** | CORS is excluded and the WebSocket origin is checked (see above). | M + security decision |

### Sidebar and app-level

| Request | Can target | What blocks it | Size |
|---|---|---|---|
| Open a remote session | Navigates away (`AllSessionsPanel.svelte:454`) | A design choice, not a blocker. The page has nowhere to render a remote session. | L (see session lookup) |
| New session on a remote machine (`projects/new-session`) | **Yes** | Nothing. JSON POST, CORS allows it. After it is created, it navigates to the remote machine. | none |
| Folder picker / `GET /api/browse` | No (`:572`, navigates away) | Relative, and lists `homedir()` of the serving machine. It is a GET, so CORS allows it. | S–M |
| Kill / close project / mark unread | **Yes** | Nothing. | none |
| `/api/usage`, `/api/usage/quota` | Fleet usage combined on the server | Not needed. | none |
| `/api/client-log` (page, service worker) | No | It logs to the serving machine. Harmless. | none |
| `/api/chrome` | No | Local Chrome only. | n/a |

### Push, service worker, per-browser state

| Thing | Can target | What blocks it | Size |
|---|---|---|---|
| Web Push (`lib/push.ts`, `/api/push*`) | No | The subscription belongs to the service worker registration of one origin. Each machine has its own VAPID keys (`~/.claude-mux/vapid.json`) and pushes only its own sessions. A registration holds one subscription under one `applicationServerKey`, and subscribing with another key fails until the old one is removed. The code already replaces a subscription made under another key. So omarchy's page cannot hold subscriptions for engage's and distilo's keys at once. That leaves two options: every machine shares one VAPID key pair, or one machine relays pushes for the rest. | **L**: design question (map #76, "Not yet specified") |
| Service worker (`service-worker.ts`) | n/a | A notification click opens `url` relative to the worker's origin, so a URL pointing at a remote session must be absolute. It has no fetch handler, so it never interferes with cross-origin requests. | S |
| `localStorage` (drafts, view modes, side-panel and files-pane prefs, voice settings, folded machines, opened agents, split ratio, server cache, last session) | Per origin | Different origins mean separate stores. Drafts are keyed by session UUID, so they would not collide if one page held them for every machine. `claude-mux-last-session` and the view-mode and panel keys use the tmux target or session id without a machine, so tmux targets could collide. | S (add the machine to the keys) |

## Hard blockers

These are things that cannot be fixed by swapping a base URL:

1. **The session page has no machine context.** `/session/[target]` looks the
   session up only in the local `sessionStore` and opens every socket against
   `window.location.host`. About 50 client call sites use relative `/api/` URLs.
   Six are already base-aware: `apiBase`, `postVisit`, the fleet socket and
   splits. Fixing this means threading a machine (origin) through the session
   page, the composer, `QueueStrip`, the side-panel panes and the stores. They
   would read a remote session from `fleetStore`, and route identity would need
   the machine because tmux targets repeat across machines. This is the bulk of
   the work (L).
2. **Attachments are refused cross-origin by SvelteKit CSRF** (403 before
   `handle`, production builds only). It needs a config change plus a check of our
   own, or a non-form upload.
3. **`PATCH` is missing from the CORS allowed methods**, so queue edit and reorder
   fail the preflight. A one-line fix.
4. **Web Push is tied to one origin and one VAPID key.** A registration holds
   one subscription under one key, so one page cannot subscribe to every
   machine's keys. Alerting for the whole fleet needs a design decision: share
   one key pair across the fleet, or relay through one machine. It is not a code
   fix.
5. **The remote browser view is deliberately same-origin only** (CORS excluded,
   WebSocket origin checked). Opening it to the fleet is a security decision to
   put to Leo.

## Not blockers, but they affect the design

- **Discovery reuses the port of the incoming request.** A page opened through
  omarchy's `https://…:8443` mapping (it exists, proxying to 3456) would probe
  peers on 8443 and find none. A peer without `tailscale serve` on the same HTTPS
  port is simply not discovered, and nothing says why.
- **`TRUSTED_ORIGIN` covers only `*.ts.net` and loopback.** A page opened as
  `http://omarchy:3456`, by tailnet IP or by LAN IP gets no CORS header from its
  peers. Live: `http://omarchy:3456` got none. Plain-HTTP origins are also not
  secure contexts, so voice, clipboard and push are unavailable there anyway.
  Mixed content is not a problem today, because discovery always produces
  `https://` URLs and an HTTP page can call HTTPS.
- **No WebSocket checks Origin except the browser stream.** Any web page the user
  visits while on the tailnet can read the sessions list, transcripts and
  terminal output, and can resize panes (live: `Origin: https://evil.example` got
  101). Acting stays behind CORS because input goes over JSON REST, but a fleet
  design that moves input onto sockets would need an origin check first.
- **No version field anywhere** (`/api/health` and discover have none), so
  flagging a machine that runs a different version (map #76) needs one added.
- **The iframe approach already works.** Splits show that framing the remote
  machine's own page avoids every blocker above, push and per-origin storage
  included, since each frame keeps its own origin. A single-session view could
  be a one-pane split. That is an architecture option to put to Leo, not a
  recommendation.

## Unverified

- The attachment 403 is read from SvelteKit source and the CORS method list, not
  observed. Observing it would mean sending a POST to a live server, which this
  ticket ruled out.
- The push limit (one subscription and one key per registration) comes from the
  Push API spec's `subscribe()` steps, as I remember them. I did not test it in a
  browser here.
