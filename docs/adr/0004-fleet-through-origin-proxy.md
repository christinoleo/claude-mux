# The page reaches other machines through its origin machine, never directly

To run every machine's sessions from one page, the browser talks only to the
machine that served it. That machine forwards anything under
`/fleet/<machine>/api/` (any method, WebSockets included) to the same path on
the owning machine, and every machine runs the same forwarding code, so any
link can be the way in and none is a hub. Each machine also subscribes to every
other machine's sessions broadcast and keeps their last known state on disk,
which the sidebar reads from its origin.

We chose this over the browser talking to each machine directly, which is how
the fleet sidebar first worked and how t3code works, because browser storage
and push subscriptions are per origin: the omarchy link and the engage link
would each keep their own offline state and preferences, and every machine
would have to accept cross-origin requests and sockets, the opening that let
any site read the sessions sockets until 0.30.10. A central app with agents on
the machines was rejected as a hub and a rewrite.

## Consequences

- Terminal and transcript bytes take two hops (owner, origin, browser), and
  the origin carries every stream its viewer watches. On a tailnet that costs a
  few milliseconds, and if the origin goes down the page goes with it, which
  was already true.
- A forwarded request reaches the owner without an `Origin` and is trusted as
  its own page's. The tailnet is the only authentication between machines.
- Session URLs name the machine (`/m/<name>/session/<target>`) because tmux
  targets repeat across machines.
- Preferences about the fleet live on the servers and spread between them;
  preferences about the device stay in the browser.
