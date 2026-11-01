# What polling alone costs across Leo's projects

Research for [#180](https://github.com/christinoleo/claude-mux/issues/180), part of [#177](https://github.com/christinoleo/claude-mux/issues/177). Measured on 2026-11-01, 22:35 to 23:03 UTC, with read-only calls. No issue, label or webhook was created to test. The only events I caused were pushes of this note.

## Answer

Polling can do the whole job within quota at all three scopes. One GraphQL sweep and one search, once a minute, cover all 118 owned repos for about 3 points a minute, or under 5% of the hourly budget. The cost of polling is delay, about a minute at worst at that rate, and it does not grow with the number of repos.

The account events feed cannot be the trigger on its own. Issue and PR events arrived within one poll, but pushes were at least 23 hours late, and 9 of 25 label events named the wrong label.

## What runs today

**`src/server/github.ts`.** Each git root with a live session gets one `repos/<slug>/issues?state=open&per_page=100` a minute. It sends no ETag, so every read is billed: 60 REST calls an hour per root. A worktree is its own root, so a worker in one adds another 60 for the same repo. A worker's closed issue adds one call per refresh, and a changed `needs-help` issue adds one comment read. It reads no pushes.

**`maestro-daemon.sh`.** Each tick is every 30 seconds and runs `gh issue list` twice, once with `--search` and once with `--label`. That is at least 240 GraphQL points an hour per daemon, before claims and workers. `GH_DEBUG=api` shows the search call is one real GraphQL query. A second query, for the `SearchType` enum, comes from `gh`'s 24-hour cache.

**Measured background load**, with one local daemon, two workers and this research's calls removed:

- REST: about 700 calls an hour, leaving about 4,300.
- GraphQL: about 900 points an hour, leaving about 4,100.

## Measurements

**Rate limits.**

- REST has 5,000 calls an hour and GraphQL has a separate 5,000 points an hour, shared by everything on Leo's account ([REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)).
- Secondary limits are 900 REST points a minute (a GET costs 1), 2,000 GraphQL points a minute, and 100 concurrent requests.
- `GET /rate_limit` does not agree with GraphQL. At the same moment it reported 67 GraphQL points used, resetting at one time, while GraphQL's own `rateLimit` field reported 678, resetting at another. I do not know why. The GraphQL figures here come from the field, not from `/rate_limit`.

**A conditional request that returns 304 is free.**

- Ten requests with `If-None-Match` returned 304 and `X-RateLimit-Used` stayed at 219. Five without it returned 200 and moved it from 220 to 224.
- This matches [GitHub's docs](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), which say a 304 does not count against the primary limit. They do not say whether it counts toward the secondary limit of 900 a minute.
- ETags save less on a busy repo. Over 14 minutes of real worker activity on claude-mux, the open issue list changed on 5 reads and `commits/main` on 1. That is about 25 billed calls an hour for both, against 120 without ETags.

**`GET /users/christinoleo/events`.** I polled it every 45 seconds for 25 minutes. That is faster than the `X-Poll-Interval: 60` it returns, and a real poller should obey the header.

- **Scope.** It includes private repos and only shows Leo's own actions. A release published by `github-actions[bot]` appeared in `repos/.../events` but not here.
- **Issues, comments and PRs.** All 12 new events appeared on the first poll after they happened, so the delay was under 45 seconds. One label event showed up 7 seconds after its timestamp. This is well below the documented [30 seconds to 6 hours](https://docs.github.com/en/rest/activity/events), but it is one evening.
- **Labels are complete but not trustworthy.** All 25 label events from `repos/.../issues/events` were in the feed. In 9 of them the feed's `payload.label` said `ready-for-agent` where the issue's own events said `in-progress`, which is the daemon claiming the issue. A rule reading that field would fire on the daemon's own claim. Used only as a doorbell, followed by a read of the real state, it is safe.
- **Pushes are very late.**
  - The newest `PushEvent` in the feed at 23:03 was from 10-31 14:22, almost 33 hours old.
  - Pushes to claude-mux `main` from 10-31 23:21 and later were absent, so that lag is at least 23 hours.
  - One old push arrived while I watched, 32.4 hours after its timestamp.
  - This note's own push at 22:40:18 was still absent 23 minutes later.
  - `CreateEvent` and `DeleteEvent` lag the same way. All of this is past the documented 6-hour ceiling, and I measured it on one evening only.
- **Depth.** The feed holds 300 events and 30 days at most. On this busy day, 300 events reached back about 25 hours, ignoring the late pushes.

**`GET /notifications`.** It does not work as a trigger here. It stayed at 304 for the whole 25 minutes, through 13 events on claude-mux, and its last change was on 2026-10-08. It stayed silent for Leo's own labels and pushes, which are the actions that start work. It also has no push thread, since [threads cover issues, PRs and commits](https://docs.github.com/en/rest/activity/notifications).

**Reading state directly sees changes quickly.**

- This note's push finished by 22:40:20. REST `pushed_at` showed it on the first read, and GraphQL `pushedAt` by 22:40:21.
- `commits/main` showed the #187 merge 5 seconds after it happened.
- `git ls-remote` shows branch heads over the git protocol rather than the API. It took 1.3 seconds over SSH and 0.4 over HTTPS, the latter on a public repo. GitHub's rate limit pages I read give no number for it, and I could not isolate its effect on quota because other work was running.

**GraphQL search has its own constraints.**

- A `search` query cost 1 point at `first: 50` by both dry run and the real field.
- It did not draw on the REST search bucket of [30 a minute](https://docs.github.com/en/rest/search/search). A REST search straight after `gh issue list --search` reported only 1 used.
- GraphQL's rate limit page publishes no limit specific to search, so the 5,000 points an hour and 2,000 a minute apply. REST search caps a query at 1,000 results, and I did not test whether GraphQL does the same.
- Results can lag, as the daemon's own comment says. All 6 changes I watched appeared on the first poll after they happened, with a 60-second poll and one seen at 5 seconds. A search scoped to `user:christinoleo` covers every repo for that 1 point.
- Nesting matters. `viewer.repositories(first: 100)` with one issue each costs 1 point. With 100 issues and 20 labels each it costs 101.

## Cost by scope, polling once a minute

Owned repos now number 118 (60 private, 58 public, 27 forks), not 100. Only 8 were pushed to in the last week and 13 in the last 30 days. Figures for "about 10 private projects" assume about 10.

**1. Today's method extended: issue list and `commits/main` per repo, no ETags.**

- claude-mux: 120 REST calls an hour.
- 10 projects: 1,200 an hour.
- 100 repos: 12,000 an hour, over the limit.

**2. The same reads with ETags.** Requests stay the same and only changes are billed.

- claude-mux: about 25 an hour when busy.
- 10 projects: at most about 250 an hour, if all are as busy as claude-mux was.
- 100 repos: about 250 an hour, assuming about 10 busy and the rest idle. That is 200 requests a minute, which fits under the secondary limit even if 304s count. At about 1 second per `gh` call, they would have to run in parallel.
- A restart adds one billed read per request, because ETags sit in memory: 2, 20 or 200.

**3. Account events feed with ETag.** It is one account-wide read, so the cost is the same at every scope.

- About 17 billed calls an hour, 60 at most.
- It misses pushes for a day or more, so it cannot stand alone.

**4. One GraphQL sweep plus one search.** `viewer.repositories` sorted by `PUSHED_AT` returns `pushedAt`, the default branch head and the latest issue update per repo. A search across the account finds `ready-for-agent`.

- claude-mux: 120 points an hour for both, or less if scoped to the repo.
- 10 projects: the same 120.
- 100 repos: the same 120 points.
- All 118 repos: 180 points an hour, because of a second page. That is under 5% of the remaining GraphQL budget.
- There is no ETag on GraphQL, so every sweep is billed. A changed repo then needs a read or two to see what changed.
- The one timed 100-repo sweep took 8.1 seconds.

**For comparison, per-repo daemons at their minimum.**

- 1 daemon: 240 points an hour.
- 10 daemons: 2,400, or more than half of what is left.
- 100 daemons: 24,000, over the limit.

**Faster intervals.** Option 4 at 10 seconds costs about 1,080 points an hour for all 118 repos, about a quarter of what is left, and would cut the worst-case delay from a minute to about 10 seconds. I calculated that and did not run it. At 1 second it would cost about 10,800, which is over the limit. The events feed should not go below its 60-second header.

## What polling cannot do

- **Be instant.** The delay is at least the poll interval. A webhook should arrive in seconds, but I created none, so that is not measured.
- **See what happened between two reads.** A label added and removed, or a branch force-pushed twice, leaves no trace in a state read. Issue events recover labels. For pushes, the only history source tested is the feed, which is a day late.
- **Say who acted, from a state read.** A head SHA or label list has no actor. `issues/events` does, but all 100 entries I read said `christinoleo`, because the daemon and workers share Leo's token. That cannot separate Leo's label from the daemon's. I expect a webhook's `sender` to have the same limit, since it reports the same account, but I did not test one.
- **Cover everything for the same price.** Option 4 sees pushes and issue changes. Failed deploys, Actions runs and deleted issues would each need other reads I did not cost.
- **Be sure of the secondary limits.** Sustained polling near them is unmeasured, and `X-Poll-Interval` can rise under load.
- **Run independently per machine.** All pollers on one account share one budget, so each machine polling on its own multiplies the cost. A single poller passing events over the fleet relay avoids this, and that relay is already on the map. I assumed all machines use Leo's account.

Being off is not a difference. The map already needs a periodic check because webhooks are lost while a machine is off, and the catch-up has to be a state read, because the feed's 300 events only reach back about a day.

## The tradeoff

**Polling only.**

- No public endpoint exists, and with it goes the signature-checking and stranger-input surface on a fleet that runs `--dangerously-skip-permissions`.
- It costs under 5% of the budget at 60 seconds and about a quarter at 10 seconds.
- A push or `ready-for-agent` waits up to the interval.

**A public door.**

- It would reduce that wait to what I expect to be seconds.
- It does not remove polling, since the map keeps a periodic check.
- GitHub has [no user-account webhook](https://docs.github.com/en/webhooks/types-of-webhooks). It takes one hook per repo or a GitHub App.
- It adds an endpoint to run and defend, and [redelivery after downtime](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks) is on the receiver to request.

So the question is whether a wait of 10 to 60 seconds matters for a push that updates the fleet or a label that starts a worker. These numbers do not answer that. They show that quota does not force the door, at any of the three scopes.

## How far to trust this

- One Sunday evening, 28 minutes, mostly one busy repo. Small samples: 12 feed events, 25 label events, 6 search changes.
- The push lag could be a backlog rather than the norm. Reading the feed on another day would settle it.
- Delay is measured to the resolution of the poll, so "first poll after" means under 45 or 60 seconds, not a precise figure.
- "Busy" comes from claude-mux with one daemon and two workers. Other projects may differ.
