# What a public door for GitHub's webhooks takes on omarchy

Research for [#179](https://github.com/christinoleo/claude-mux/issues/179), part of the map [#177](https://github.com/christinoleo/claude-mux/issues/177). Written 2026-11-01. Nothing was enabled for this note: no Funnel, no tunnel, no endpoint, no webhook. Everything about behaviour comes from docs and source reading, and the commands below have not been run.

Sources pinned: Tailscale at tag `v1.102.3` (the running `tailscaled`), `cloudflare/cloudflared` at its default branch (latest release 2026.10.7, installed 2026.10.2), SvelteKit 2.70.3 as installed, and claude-mux at `origin/main` `4e40577`.

## Short answer

Opening one path takes little work on any of the three options. The real work is on the claude-mux side, because the server has no authentication of its own.

- **Tailscale Funnel on `:10000`** is the cheapest door. It costs nothing, needs no domain and no new daemon, and the relay cannot read the traffic. It is the only Funnel port that does not already carry a claude-mux or dev entry. The other two ports must stay private, because Funnel opens a whole port and `:8443` proxies to prod claude-mux at `/`.
- **A Cloudflare Tunnel** gives a normal `:443` URL and an exact path rule. It adds a daemon, and Cloudflare sees payloads in plaintext. The existing `~/.cloudflared/config.yml` must not be reused.
- **A hosted relay** is the only option that holds events while `omarchy` is off, and with HTTP pull it opens nothing on `omarchy`. It is also code to write, deploy and keep. The map's periodic check already catches missed events, so the relay buys little.

Whichever door is chosen, I suggest the path lands on a separate localhost listener that answers only that one route. Then a wrong proxy setting exposes one route and not the whole server. That is an architecture choice for Leo.

## What omarchy has today

Read with `tailscale serve status`, `tailscale status --json`, `ss -ltn` and `cloudflared --version`.

- `tailscaled` is 1.102.3 and the client is 1.104.2, so every CLI call prints a version warning. Restarting `tailscaled` would clear it.
- The node has the `https` and `funnel` capabilities and `funnel-ports?ports=443,8443,10000`. The tailnet needs no policy change.
- Serve has more entries than the ticket's brief listed. All are tailnet only:
  - `:443` proxies `/` to `127.0.0.1:5173`
  - `:3456` proxies `/` to `127.0.0.1:3456`, prod claude-mux
  - `:3773` proxies `/` to `127.0.0.1:3773`
  - `:8443` proxies `/` to `localhost:3456`, prod claude-mux again
  - `:8446` proxies `/` to `127.0.0.1:5176`
  - `:9091` proxies `/` to `127.0.0.1:9091`
  - `:13378` proxies `/` to `127.0.0.1:13378`
- Nothing uses `:10000`.
- Prod claude-mux listens on `127.0.0.1:3456` only, so the proxies are its only way in from other machines.
- `cloudflared` 2026.10.2 is installed and no process is running. `~/.cloudflared/` holds a zone certificate, tunnel credentials and a `config.yml` that routes four `*-local` hostnames on Leo's Cloudflare zone to local dev ports.

## Option 1: Tailscale Funnel

**Ports.** Funnel listens only on 443, 8443 and 10000 ([Funnel docs](https://tailscale.com/kb/1223/funnel), and [`CheckFunnelPort`](https://github.com/tailscale/tailscale/blob/v1.102.3/ipn/serve.go#L667)).

**Funnel opens a port, and a path does not narrow it.** `AllowFunnel` is a map keyed by host and port ([`ipn/serve.go#L64`](https://github.com/tailscale/tailscale/blob/v1.102.3/ipn/serve.go#L64)). An ingress connection is checked against that key only ([`HandleIngressTCPConn`](https://github.com/tailscale/tailscale/blob/v1.102.3/ipn/ipnlocal/serve.go#L444)). From there it reaches every mount on the port. The docs say the same: if the last command on a port was `funnel`, "the port will be completely public" ([Funnel docs](https://tailscale.com/docs/features/tailscale-funnel)). This decides the fit with the existing entries:

- `tailscale funnel --https=8443 --set-path=/hooks/github ...` would put claude-mux's `/` on the internet with no login, because the `:8443` mount at `/` goes public with it. This is the worst mistake available on this machine.
- The same command on `:443` would publish whatever runs on `:5173`.
- `:10000` is free, so a mount there exposes only that mount. Any later mount added to `:10000` goes public too, without a warning.

**A mount is a prefix, not an exact path.** [`getServeHandler`](https://github.com/tailscale/tailscale/blob/v1.102.3/ipn/ipnlocal/serve.go#L804) cleans the request path and walks up it until it finds a mount, so `/hooks/github/anything` matches a mount at `/hooks/github`. [`serveWebHandler`](https://github.com/tailscale/tailscale/blob/v1.102.3/ipn/ipnlocal/serve.go#L1173) then strips the mount from the uncleaned path and forwards the rest. A path outside the mount gets 404. A path such as `/gh/../../../gh/x` cleans to something inside mount `/gh`, yet arrives at a target of `/api/webhooks/github` as `/api/webhooks/github/../../../gh/x`, which a URL parser reduces to `/gh/x`. I read this in the source and did not run it. I found no way to reach `/api/...` this way, since the mount's own name stays in the result, but the mount should not be the only guard.

**A useful header.** `tailscaled` deletes any incoming `Tailscale-Funnel-Request` and sets it to `?1` on Funnel traffic only ([`addTailscaleIdentityHeaders`](https://github.com/tailscale/tailscale/blob/v1.102.3/ipn/ipnlocal/serve.go#L1078)). The backend can therefore tell a public request from a tailnet one. The docs pages I read do not mention this header, so it is an implementation detail. It also sets `X-Forwarded-For` to the real client address and keeps the incoming `Host`.

**What it exposes.** Public DNS gives out a relay's address, not the machine's. The relay proxies TCP and does not decrypt, and `tailscaled` terminates TLS ([Funnel docs](https://tailscale.com/kb/1223/funnel)). The URL contains the machine name and the tailnet name, and the Funnel docs list the public DNS step for them. Anyone given the URL learns both.

**Downtime.** Docs do not describe what a caller sees with the machine off. The relay reaches the device over Tailscale, so I expect a failed connection (inferred). With the machine up and claude-mux down, the proxy fails to reach its backend. Either way GitHub records a failed delivery.

**Cost.** Free. Funnel is "available on all plans" per the [Funnel docs](https://tailscale.com/kb/1223/funnel), and the [pricing page](https://tailscale.com/pricing) puts Personal at $0 but says the free tier is for non-commercial use. Leo should check that against what `omarchy` does. Funnel is labelled beta. Its bandwidth limits exist and are not published, which should not matter at webhook sizes.

**Open question.** GitHub's docs neither allow nor forbid a port in a payload URL. Third-party guides show custom ports in use, and I found no GitHub statement. A real delivery to `:10000` is the first thing to try if this option wins, and it cannot be tested under this ticket's rules.

**What enabling would look like** (not run):

```bash
sudo systemctl restart tailscaled   # clears the version skew
tailscale funnel --bg --https=10000 --set-path=/hooks/github http://127.0.0.1:<port>/hooks/github
tailscale funnel --https=10000 --set-path=/hooks/github off   # the way back
```

Public DNS can take up to 10 minutes. The config survives reboots. Do not use `tailscale serve reset` or `tailscale funnel reset` as the way back. Both run [`runServeReset`](https://github.com/tailscale/tailscale/blob/v1.102.3/cmd/tailscale/cli/serve_v2.go#L755), which writes an empty `ServeConfig` and so removes every Serve entry listed above.

## Option 2: Cloudflare Tunnel

**What it takes.** A named tunnel, one DNS record on Leo's Cloudflare zone, and a `cloudflared` daemon. The connection is [outbound only](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), so no port opens. Leo already has the zone. A hostname is a CNAME to `<UUID>.cfargotunnel.com` ([routing docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/)). Quick tunnels are out: the [docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) call them testing tools whose hostname changes each time.

**What it exposes.** Only what the ingress rules name. Rules run in order, `path` is a Go regular expression, and the file must end in a catch-all such as `http_status:404` ([configuration file docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/)). The rule [matches the path itself](https://github.com/cloudflare/cloudflared/blob/master/ingress/rule.go), so an anchored `^/hooks/github$` is exact, which is tighter than a Funnel mount. Cloudflare terminates TLS, so it reads every payload, private repository issues included. Funnel's relay cannot.

**A trap on this machine.** `cloudflared` reads `~/.cloudflared/config.yml` by default, and that file routes four dev hostnames. Adding the webhook there and starting the daemon would also bring those four dev hostnames back online. A webhook tunnel needs its own tunnel, credentials and `--config` file.

**Downtime.** With no connector, Cloudflare answers with [error 1033](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/). GitHub records a failed delivery.

**Cost.** Free: Cloudflare made the outbound connection free for any organisation in [April 2021](https://blog.cloudflare.com/tunnel-for-everyone). I did not find a current docs page that repeats this, and the [limits page](https://developers.cloudflare.com/cloudflare-one/account-limits/) lists 1,000 tunnels per account with no price. The second cost is a daemon to keep alive.

## Option 3: a small hosted relay

A Cloudflare Worker is the natural fit because the account exists. It takes the delivery, checks the signature, stores the raw body and headers, and answers 2xx. `omarchy` then collects the events.

**Holding while off.** Queues keeps messages 24 hours on the free plan (not configurable), and 4 days by default, up to 14, on paid ([Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)). A Durable Object with SQLite storage, available on the free plan, would hold them for as long as Leo keeps them ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).

**What it exposes.** Nothing on `omarchy` if it pulls. [HTTP pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/) work from any environment with an API token, and unacknowledged messages come back after a visibility timeout. Cloudflare reads the payloads, as with the tunnel, and the webhook secret must live in the Worker.

**The catch.** A pull returns at once when the queue is empty and does not hold the connection. So `omarchy` would be polling Cloudflare, and the delay equals the poll interval. A pull every 30 seconds is 2,880 requests a day against a free allowance of 10,000 queue operations. Each write, read and delete counts as an operation, and the page does not say whether an empty pull does. Instant delivery means `omarchy` holding a socket open to a Durable Object, which is more code. I did not design or price that further.

**Cost.** $0 at this volume on the free plans, with 100,000 Worker requests a day. Workers Paid is $5 a month ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). The larger cost is one more deployed program with its own secret, its own failures and no place in the fleet.

**Bought services do not fit:**

- [Hookdeck](https://hookdeck.com/docs/destinations) with an HTTP destination still needs a public URL on `omarchy`. Its CLI destination connects outward but does not queue events for a listener that is absent. The free plan keeps 3 days and 10,000 events, and the first paid plan starts at $39 a month ([pricing](https://hookdeck.com/pricing)).
- [`gh webhook forward`](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing) is "not supported for use in production environments".
- [smee.io](https://smee.io/) presents itself as a way to reach an app on localhost during development, and states nothing about storage or access.

## What downtime means for all three

GitHub "does not automatically redeliver failed deliveries" ([docs](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)). Deliveries can be redelivered through the REST API for [3 days](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks), by a repository admin, an organisation owner or the App's owner. So a door without a relay loses the event unless something asks again.

The map already answers this. A webhook is a doorbell and a periodic check reads the real state, so a lost delivery delays work until the next check. A relay shortens that delay only for outages, and only for a door that would otherwise have missed the event. That is why I rate it low. A redelivery sweep is a smaller option if the delay ever matters.

## What exposing one path touches in claude-mux

**The server has no authentication, by design.** ADR 0004 says "The tailnet is the only authentication between machines". `pageOriginAllowed` in `src/server/page-origin.ts` is not a login: a request with no `Origin` passes, because a peer machine or curl sends none. `handle` in `web/src/hooks.server.ts` asks only that question for sockets, and `/api/` routes ask at most that. A public request that reaches this server's other paths can therefore:

- call any of the 57 `+server.ts` API routes, including `POST /api/update`, which installs and restarts
- open terminal and transcript sockets
- drive the logged-in remote browser through `/api/browser/<tab id>/stream`
- reach sessions, whose start path uses `--dangerously-skip-permissions`
- go through `/fleet/<machine>/api/...`, which `relayRequest` forwards with no route allowlist to any machine, `engage` included

So this is one wrong flag from remote control of the whole fleet.

**What the door needs from the code:**

- **A way in that fails closed.** There are two candidates, and Leo should choose.
  - A separate `Bun.serve` on another localhost port that answers only `POST` on the exact path. A mistake in the proxy then exposes one route. It needs a home outside `src/commands/serve.ts`, or the Vite dev server will not have it, and it means a second port per machine.
  - A route in the existing server, with a guard at the top of `handle` that returns 404 for any other path carrying `Tailscale-Funnel-Request`. This is less code, but it depends on an undocumented header, covers Funnel only (a tunnel needs its own check), and keeps the door and the 57 routes on one port. The guard must run before the WebSocket branch.
- **Signature check first.** Verify `X-Hub-Signature-256`, an HMAC-SHA256 of the raw body, with a constant-time compare, before parsing anything ([docs](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)). Ignore the legacy SHA-1 header.
- **A fast answer.** Answer 2xx within [10 seconds](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks) and do the work after. `X-GitHub-Delivery` identifies a delivery, and a redelivery reuses it.
- **`application/json` on the GitHub side.** If the route is inside SvelteKit, a form-encoded webhook gets 403 in production: [the CSRF check](https://svelte.dev/docs/kit/configuration) refuses form content types whose `Origin` is not the server's, and GitHub's deliveries are not a page. The Vite dev server skips this check, so it would pass in dev and fail in prod. A separate listener avoids the question.
- **A body limit chosen on purpose.** GitHub [caps payloads at 25 MB](https://docs.github.com/en/webhooks/webhook-events-and-payloads). `src/commands/serve.ts` builds its own `Bun.serve` and sets no limit, so the adapter's 512K default does not apply there. A new listener should set one.
- **No raw forwarding across the fleet.** After verifying and consulting the state map, `omarchy` should send its own request over the relay to the owning machine. The public body must not reach the relay as it arrived.
- **An ADR.** ADR 0004 assumes nothing public touches this server. A new ADR should record the one exception and the rule that keeps it to one route.

`pageOriginAllowed` and the relay themselves need no change.

## Not settled here

- Whether a door is worth having at all. That is [#182](https://github.com/christinoleo/claude-mux/issues/182), with [#180](https://github.com/christinoleo/claude-mux/issues/180) on what polling costs.
- Which hook type and which events. That is [#178](https://github.com/christinoleo/claude-mux/issues/178), and it decides how many deliveries arrive.
- Whether GitHub delivers to `:10000`, how the relays behave with the machine off, and every path case above. Each of these needs a live trial, which this ticket forbids.
