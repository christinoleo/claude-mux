# How t3code shows GitHub pull requests and issues

Research for claude-mux's read-only GitHub side-panel pane. Source:
[pingdotgg/t3code](https://github.com/pingdotgg/t3code) at commit
`7ac952c630ef8a60d14ca8f6a0c7adce33db4bae` (2026-10-14). Paths below are in that
repo unless they say claude-mux. Where a note says *measured here*, I ran the
command on this machine with `gh` 2.102.0. Everything else comes from t3code's
own code or docs.

## Short version

- t3code has a full pull request **review** surface: list, detail panel, review,
  merge, stacks, agent hand-offs. It has **no issue view**. A bare `#123` becomes
  a link to `/issues/123`, and the app opens it in the PR panel only after it
  reads successfully as a PR. Otherwise it stays an ordinary external link
  (`packages/shared/src/changeRequestUrl.ts`,
  `pullRequestCandidateUrlFromReferenceAutolink`).
- The server calls GitHub's REST and GraphQL APIs directly. It takes the token
  from settings, `GH_TOKEN` or `gh auth`, and does not shell out to `gh` for
  reads (`docs/user/source-control.md`, "GitHub").
- Speed comes from four things: a few purpose-built GraphQL queries instead of
  `gh pr view --json`; a detail read split into cheap and costly halves; caches
  that are short, shared and coalesced, and serve stale data while they
  revalidate; and ETag revalidation (304s are free) for the parts that poll.

## 1. What the PR view shows, in order

### Header (`PullRequestDetailPanel.tsx`, `PullRequestDetailLayout.tsx`)

1. **Top bar**: a state glyph, the number, a `⋯` menu (copy link and number,
   close/reopen/revert, rewrite guide) and the action pills (Merge now,
   auto-merge, merge method as a radio group, draft toggle).
2. **Title**: one line, truncated, full text in a tooltip, a pencil when you may
   edit it.
3. **Meta line**: author (avatar + login, linked to the profile), "updated
   3h ago", and a copyable checkout command pushed to the right.
4. **Branch line**: `base ← head` in mono, each name middle-truncated
   (`MiddleTruncate`) and capped at 40% of the width. The head name is
   click-to-copy. A stacked PR gets a stack glyph. A base that is behind turns
   amber and offers "Update branch" (`PullRequestBaseFreshnessWarning`, fed by
   `baseRef.compare(headRef).behindBy`). On the right: file count and `+a −d`.
5. **Condensing header**: once the body scrolls, rows 3–4 fold (a CSS grid-rows
   `0fr/1fr` transition) into a single dense row: avatar, relative time,
   `base ← head`, counts. The anchor scroll is corrected in the same frame, so
   nothing jumps.
6. **Tab bar**: Summary · Guide (beta, AI tour) · Timeline · Code. The right end
   of the bar changes with the tab. On Summary it is the checks status line
   ("7 of 16 running · 1 failed") with the checks popover. On Timeline it is
   the comment count. Hovering the Code tab starts loading the diff
   (`onTabIntent`). Tabs mount the first time they are opened and then stay
   mounted, hidden with `invisible`, so switching back is instant.

State colours (`pullRequestIcons.tsx`): open emerald, draft zinc, closed red,
merged violet. These match claude-mux's `githubRefVisual()`.

### Summary tab (`PullRequestSummaryTab.tsx`)

The tab is made of collapsible sections with **sticky headings**: a heading
rides the top of the scroll box, so you can collapse a section from wherever
you have read to.

1. **Meta rows**, in a `6rem | 1fr` grid. **Reviewers**: overlapping 16px
   avatars, each ringed in the colour of that reviewer's latest verdict
   (approved / changes requested). A verdict older than the newest commit is
   dimmed as stale. Requested reviewers and anyone who reviewed unasked are
   merged into one set, case-insensitively by login. **Labels**: tinted chips in
   the label's own colour, mixed toward the foreground colour for contrast.
2. **Description**: markdown, kept mounted.
3. **Checks**: collapsed by default. Inside, the order is needs-attention
   (failure/cancelled/action-required), then running, then passing, with
   passing folded behind "Show all" when anything else exists
   (`groupPullRequestChecks`). Each row shows a status icon, the name, a status
   label and "Details" (the check's URL).
4. **Comments (n)**: the newest 10, then "Show 10 older comments (n hidden)"
   (`COMMENT_PAGE = 10`). A newest/oldest toggle. A filter, saved per browser,
   that by default **hides bots** (`author.isBot` or a login ending in `[bot]`)
   and **hides resolved threads and dismissed reviews**. The filter shows one
   "n hidden" count.
   - Resolved and dismissed items render as `CollapsedComment`: one line with
     identity, a label and a plain-text preview of the body. The preview
     removes HTML comments, `[!NOTE]` markers, link syntax, `#>*-` and
     backticks.
   - Line comments show `path:line` and "Outdated".

### Timeline tab (`PullRequestTimelineTab.tsx`, `buildPullRequestTimeline`)

- Entries run **newest first** by default ("what happened last is what a
  reader opening the tab is asking about"). There is an order toggle.
- Item kinds: `opened`, `commit` (short sha + headline as plain text, +/−,
  author avatars), `comment`, `review`, `merged`, `closed`. Merged wins over
  closed, because GitHub stamps both.
- **Runs of consecutive plain comments fold** into one row: "9 comments ·
  3 authors · 2d ago" with stacked avatars, dimmed until opened
  (`groupPullRequestTimelineConversations`). **Verdicts never fold.** An
  approval or a request for changes is its own row, with the reviewer's face on
  the rail and the verdict icon.
- A vertical rail line sits at `left-[15px]` and each row carries an avatar
  marker on it.

### Code tab (`PullRequestCodeTab.tsx`)

Viewed checkboxes are synced to GitHub's own `viewerViewedState`, so marks
carry both ways between t3code and github.com. Files are sorted in three
reading passes: source, then proof (tests), then lockfiles and build output
(`pullRequestFileOrder.logic.ts`). The tab can be scoped to one commit. Line
comments are drafted into a pending review. None of this belongs in a
read-only pane.

### Linked pull requests and how a link opens

- A PR link in the conversation **opens beside the thread** in the right panel,
  so the reader stays in the thread, not on the PRs page
  (`apps/web/src/lib/openPullRequestLink.ts`, `useOpenChangeRequestLink`).
  **Cmd/Ctrl+click** goes to the host. On a real `<a>`, the default action is
  left alone so the browser handles the modifier
  (`shouldOpenPullRequestExternally`, `useOpenPrLink`).
- **Hovering** a PR link shows a preview card after 350 ms (repo, `#n`, state,
  title, author). Opening the card starts the **full detail query**, so a click
  that follows lands on a warm cache (`PullRequestLinkPreview.tsx`).
- For an autolinked `#n` (`confirmBeforeOpen`), the click first runs the cheap
  preview query against `/pull/n`. Success opens the panel. Failure opens the
  original `/issues/n` URL externally.
- Inside PR markdown, `#n` and 40-hex shas in prose (never in code or existing
  links) are autolinked to the same repo by a remark plugin
  (`pullRequestMarkdown.logic.ts`, `remarkPullRequestAutolinks`). Those links go
  through the same open-in-panel path.
- A thread can **link** several PRs. Its badges show the current review number
  plus a count of the others. The review header lists the threads that link
  to it (`docs/user/source-control.md`, "Linked pull requests").

## 2. Rendering details that make it read well

| Detail | Where | Why it matters |
|---|---|---|
| A long comment is capped at **240px** with a fade and "Show full comment"; focusing inside expands it | `PullRequestCommentBody.tsx` | Bot reports (coverage, previews) are pages long |
| `content-visibility: auto` with `contain-intrinsic-block-size` on every comment card and folded group | Summary, Timeline | Off-screen markdown skips layout and paint; "bot comments carry pages of highlighted code" |
| A body made only of `<!-- -->` markers counts as **no body** | `visibleBody()` | Review bots keep bookkeeping in HTML comments, which would otherwise render as an empty card |
| GitHub `> [!NOTE]`/TIP/IMPORTANT/WARNING/CAUTION alerts become styled callouts; a marker followed by text stays a plain quote (GitHub's rule) | `packages/shared/src/markdownGithubAlerts.ts` | remark-gfm leaves the marker as literal text |
| `<details>` blocks render collapsed with muted summary styling | `PullRequestMarkdown.tsx` (`data-markdown-details`) | Bots wrap noise in `<details>` |
| Media in a **private repo** (`github.com/user-attachments/assets/…`, `raw.githubusercontent.com`, LFS) is proxied through the server with the token. The token is sent only to GitHub, never to the signed object store that the 302 points at. SVGs get a no-script CSP | `apps/server/src/assets/GitHubMediaFetch.ts`, `packages/shared/src/githubMedia.ts` | Without this, screenshots in private PRs render as broken images |
| Videos play inline; any other attachment becomes an "Open attachment on GitHub" row | `PullRequestMarkdown.tsx` | |
| Relative times ("3h ago") with the absolute time in a tooltip; the timestamp links to the comment on GitHub | `CommentIdentity` | |
| Deleted accounts read **"ghost"** everywhere; two ghost reviews stay two reviewers | `pullRequestPresentation.tsx`, `latestPullRequestReviewOutcomes` | |
| One verdict per reviewer: the **latest** one wins, ordered by parsed time rather than text order, and a dismissal removes it | `latestPullRequestReviewOutcomes` | "Is this approved?" is the question |
| The checks summary names every live facet: "7 of 16 running · 1 failed" | `describePullRequestChecks` | |
| "Changes requested" is formatted from `CHANGES_REQUESTED` | `reviewStateLabel` | |
| Skeleton bars shaped like the real layout ("ghosts"), all pulsing on one layer | `PullRequestGhosts.tsx` | |
| The last detail read is **snapshotted to browser storage** and hydrated on reopen; live data then replaces fields in place | `readPullRequestDetailSnapshot` in `pullRequestDetail.logic.ts` | No full skeleton when a known PR is reopened |

## 3. Data layer and speed tricks

### Queries (GraphQL unless marked REST)

All are in `packages/source-control-github/src/server/gitHubPullRequestJson.ts`
and called from `GitHubPullRequestApi.ts`.

- **Core detail** (`pullRequestCoreGraphQlQuery`): `number title url body state
  isDraft mergeable reviewDecision additions deletions changedFiles createdAt
  updatedAt mergedAt closedAt headRefName baseRefName headRefOid
  isCrossRepository`, `author { login avatarUrl … }`, `autoMergeRequest`,
  `viewerCanUpdate`, `baseRef { compare(headRef: "refs/pull/N/head") { behindBy } }`,
  `reviewRequests(first:100)`, `labels(first:100) { name color }`, and the
  head commit's `statusCheckRollup.contexts(first:100)` (CheckRun: name status
  conclusion detailsUrl + workflow name; StatusContext: context state targetUrl
  description; `isRequired(pullRequestNumber:)` on github.com only, since
  older Enterprise servers reject the unknown field and fail the whole read).
  When the contexts have a next page, a separate walk reads every context. Each
  page carries the head sha, and the walk fails if a push lands mid-walk
  instead of mixing two revisions.
- **Activity** (`PULL_REQUEST_ACTIVITY_GRAPHQL_QUERY`): `author`, `commits(last:100)`,
  `comments(first:100, after:)`, `reviews(first:100, after:)`, each with
  `id body createdAt lastEditedAt url author { __typename login avatarUrl }`.
  `@include(if:)` flags turn each connection on only while it still has pages,
  so the two lists page independently.
- **Review threads** (`REVIEW_THREADS_GRAPHQL_QUERY`), run **in parallel** with
  activity (`GitHubPullRequestProvider.ts`, `getChangeRequestActivity`,
  `concurrency: 2`): `reviewThreads(first:100) { isResolved isOutdated path line
  diffSide comments(first:10) {…} }`, `reviewRequests`, `latestReviews`,
  `timelineItems(itemTypes:[REVIEW_DISMISSED_EVENT])`, `commits(last:100)` with
  additions/deletions/authors. Only **10 comments per thread**: 100 threads ×
  100 comments made GitHub reserve 10,000 nodes and charge 104 points. Longer
  threads are paged from their own node (`REVIEW_THREAD_COMMENTS_GRAPHQL_QUERY`).
  If this read fails, activity still renders, with a truncated conversation.
- **Preview** (`PULL_REQUEST_PREVIEW_GRAPHQL_QUERY`): `number title url state
  isDraft createdAt author`. Used by hover cards and to test whether a `#n` is a PR.
- **Avatars by node id** (`ACTOR_AVATARS_GRAPHQL_QUERY`): `nodes(ids:) { … on
  User/Bot { login avatarUrl } }`, because "no `gh` JSON field carries" an avatar.
- **Diff** (REST): `GET repos/o/r/pulls/N` with `Accept:
  application/vnd.github.diff`. A truncated response, or the 406 GitHub returns
  past 300 files, falls back to `GET repos/o/r/pulls/N/files?per_page=&page=`.
- **Files viewed**: `files(first:100) { path viewerViewedState }`.
- **Watch fingerprint** (`buildPullRequestWatchFingerprintsGraphQlQuery`): aliased
  per PR, `state mergeable headRefOid`, `comments(first:100, orderBy UPDATED_AT
  DESC) { totalCount nodes { lastEditedAt } }`, `reviews(last:100) {…}`,
  `reviewThreads { totalCount }`, and check counts by state. GitHub prices this
  at **1 point for 25 PRs**, against 16 points for one detail + activity read.
  The full reads run only when the fingerprint moved. It has two parts, so a
  change in `status` re-reads only the detail and a change in `remarks` also
  re-reads activity.
- **Listing**: one `search(type: ISSUE)` that carries up to 100 `repo:`
  qualifiers, instead of one call per repo. `additions/deletions` are left out
  of the list query (about 4.0s instead of about 7.1s over 12 repos) and fetched
  afterwards by a stats query.

### Caching (`apps/server/src/pullRequest/PullRequestService.ts`)

- Short, **shared** TTLs sized to the client's own stale time: list 30s; detail,
  activity and preview 60s; **merged PR 10 min** (it cannot change; a closed one
  can reopen, so it gets no such extension); checks and fingerprint 15s; diff
  60s; a commit's diff 10 min (content-addressed); viewer login 10 min.
  Identical concurrent reads are coalesced into one request.
- **Stale-while-revalidate** for the diff: a held value up to 10 min old is
  returned at once and refreshed in a detached fiber.
- **Last-good fallback**: when a refresh fails or is rate-limited, the server
  returns data up to 10 min old and logs a warning instead of failing.
  `serveHeld("reuse")` returns held title/author/state without a call at all.
- **Invalidation by epoch**: each cache key carries its PR's epoch. A refresh
  button or a mutation bumps the epoch, which strands every old entry without
  enumerating keys. An ordinary read cannot opt out of the cache; only
  `invalidate` can.
- **Persisted read cache** (`PullRequestReadCache.ts`): entries live on disk,
  with a 1-minute expiry and an hourly prune, so a server restart does not
  cold-start every open PR.
- On the client, queries are persisted (`persistQuery`) with `staleTimeMs`
  60s (detail, activity), 45s (checks) and 30s (list). Mobile reads them
  offline.

### ETag revalidation (`gitHubConditionalChecks.ts`)

For checks, the server keeps the ETag per endpoint and sends `If-None-Match`
when it revalidates `pulls/N`, `commits/<sha>/check-runs`, `commits/<sha>/status`
and (for forks) `actions/runs?head_sha=`. "A 304 is returned rather than
failed, and is free" (`GitHubApi.ts`). Only when something changed (or the
value is more than 5 min old) does it run the GraphQL detail read. A head-sha
change clears the stored validators. Hosts that answer 404/405/501 are marked
as not supporting this and use the plain read.

*Measured here*: three conditional `gh api -i -H 'If-None-Match: <etag>'
repos/christinoleo/claude-mux/issues/1` calls returned `304 Not Modified` and
left `X-Ratelimit-Remaining` at 4594. The next full read took it to 4593.
**`gh api` exits 1 on a 304**, so a caller has to read the status line from
`-i` output rather than trust the exit code.

### Rate-limit reserve (`GitHubQuota.ts`, `SourceControlRateLimit.ts`)

Background reads leave **10% of each quota** (`core`, `graphql`, `search`
tracked separately) for interactive clicks. The balance comes from GitHub's
`x-ratelimit-*` headers, so it counts what an agent's own `gh` calls spent
with the same token. Nothing is debited locally, because a 304 spends nothing.

### What loads first

1. The cached snapshot or preview paints the header immediately.
2. The core detail query fills in the header, Summary meta, description and checks.
3. Activity and review threads load in parallel, for the comments, Timeline and
   reviewer verdicts. While they are pending, the Timeline count is dimmed.
4. The diff loads on hover or open of the Code tab.
5. Hover cards prefetch detail before any click.

## 4. What claude-mux's read-only GitHub pane should borrow, and what to skip

The ranking is by value for a narrow (~360–480px) read-only pane that opens
from transcript chips. Each item lists the `gh` call that would supply it.
claude-mux already runs `gh` through `execFile` (`src/server/github-refs.ts`,
`src/server/github.ts`), so these slot in beside the existing calls.

### Borrow

1. **One GraphQL read for the header and body, kind-agnostic.**
   `issueOrPullRequest(number:)` answers for both, so the pane need not know in
   advance whether `#n` is a PR. *Measured here*:
   `gh api graphql -f query='query{repository(owner:"christinoleo",name:"claude-mux"){issueOrPullRequest(number:113){__typename … on PullRequest{title state}}}}'`
   returned `PullRequest / MERGED`. Fields:
   - PR: t3code's core selection, trimmed: `number title url body state isDraft
     mergeable reviewDecision additions deletions changedFiles createdAt updatedAt
     mergedAt closedAt headRefName baseRefName author{login avatarUrl}
     labels(first:20){nodes{name color}}`, plus
     `commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:50){…}}}}}`.
   - Issue: `number title url body state stateReason createdAt updatedAt closedAt
     author{login avatarUrl} labels(first:20){…} assignees(first:10){…}`.

   This one call replaces t3code's preview, core and avatar queries for the
   pane's first paint.
2. **Header layout**: state glyph and colour (already in `githubRefVisual()`),
   title on one line with a tooltip, "author · updated 3h ago", then
   `base ← head` middle-truncated with `+a −d · n files` on the right. Fold it
   to one row on scroll. The `#n` link and the "Open in Browser" button sit in
   this header, per the plan already agreed.
3. **Conversation with sane defaults**: newest 10 first with "Show older",
   **bots hidden by default** (`__typename == "Bot"` or a `[bot]` suffix) behind
   one "n hidden" toggle, long bodies capped at ~240px with "Show full
   comment", `visibleBody()` to drop marker-only bot comments, and
   `content-visibility: auto` on each card.
   - PR: t3code's activity query (`comments` + `reviews`, paged with
     `@include` flags).
   - Issue: `comments(last:30){nodes{id body createdAt url author{__typename login avatarUrl}}}`,
     or REST `gh api repos/o/r/issues/N/comments?per_page=100`.
4. **Verdicts as their own rows, one per reviewer (latest wins), stale when older
   than the newest commit.** This is the "is it approved?" answer, and it is
   cheap: `latestReviews(first:20){nodes{state submittedAt author{login avatarUrl}}}`
   inside the same PR query, plus `reviewRequests(first:20)`.
5. **Checks line and list**: "7 of 16 running · 1 failed" in the header, and a
   collapsed section ordered attention → running → passing, with passing folded
   away. The data comes from `statusCheckRollup.contexts` in item 1; no extra
   call.
6. **Markdown fidelity for GitHub bodies**: GitHub alerts, collapsed `<details>`,
   `#n` and sha autolinks in prose scoped to the ref's repo, all through
   claude-mux's existing `renderMarkdown()` with `github.bare`. Links to other
   issues and PRs open in the pane (the plan already agreed). Borrow t3code's
   probe for bare `#n` only if the pane were PR-only; with `issueOrPullRequest`
   it is not needed.
7. **Server cache shaped like t3code's**: about 60s for open items, **10 min for
   merged/closed issues and merged PRs**, coalesced concurrent reads, and
   return-last-good on failure or rate limit. claude-mux's `github-refs.ts` already
   caches for a minute; extend it with the state-aware TTL and stale fallback.
8. **ETag revalidation for refresh** while the pane is open: `gh api -i -H
   "If-None-Match: <etag>" repos/o/r/issues/N` (this works for PRs too) and
   `…/issues/N/comments`. Run the GraphQL read again only on a 200. Parse the
   status line; do not trust the exit code. This is the right way to poll every
   15–30s at no quota cost.
9. **Hover warms the cache.** The chip's hover card already calls
   `/api/github/ref`. Have that route (or a sibling) start the pane's full read
   in the background, so a click opens instantly.
10. **Snapshot of the last read per ref in the browser** (claude-mux already keeps
    "the last few opened refs"), painted on reopen and replaced in place.
11. **Private-repo images**: proxy `github.com/user-attachments/assets/*` and
    `raw.githubusercontent.com` through a server route using
    `gh auth token`, following the 302 **without** forwarding the token. Without
    it, screenshots in Leo's private repos break. Medium effort; worth it if
    the pane renders images at all.
12. **Timeline, folded**: if a timeline is wanted beyond the conversation,
    copy t3code's grouping (consecutive comments fold, commits and verdicts
    and merged/closed stay first-class, newest first). For a narrow pane,
    merging commits into the comment list as one-line rows is probably enough.
    Source: `commits(last:30){nodes{commit{oid messageHeadline committedDate}}}`.
    For issues, `timelineItems(itemTypes:[CROSS_REFERENCED_EVENT, CLOSED_EVENT,
    REFERENCED_EVENT, CONNECTED_EVENT], last:30)` gives "mentioned in #x" and
    "closed by PR #y", which is useful for a worker's issue (the call ran here; the fields inside each event were not checked).

### Skip

- **Code tab, files viewed, line-comment drafting, review forms**: the pane is
  read-only, and claude-mux's Changes pane already shows the session's diff.
  At most, add a "n files, +a −d" line linking to the Changes pane when the PR's
  head is the session's branch.
- **Review threads with inline diff context**: costly (104-point lesson) and
  wide. If wanted later, list unresolved threads as `path:line` with the first
  comment, from `reviewThreads(first:50){nodes{isResolved isOutdated path line
  comments(first:3){…}}}`.
- **Merge, auto-merge, approve-workflows, stacks, revert, reviewer and label pickers**:
  actions go through "Open in Browser" by design.
- **Guide tab (AI review tour)**, agent hand-offs ("Fix in a thread"), and
  linked-PR bookkeeping per thread. claude-mux's worker-issue and branch-PR
  defaults cover the "what is relevant here" need.
- **Watch fingerprints and the background sweep with a 10% reserve**: needed only
  for polling many PRs with no one looking. Revisit if Needs-you ever watches PRs.
- **Cross-repo `search` listing with stats**: no list view is planned.
- **Persisted on-disk server cache**: claude-mux restarts rarely, and the browser
  snapshot covers reopen.

## Unverified

- Checked here and confirmed: `issueOrPullRequest` on issue #1 (`__typename
  Issue`, `state`, `stateReason`, `assignees`, `timelineItems` returning
  `CrossReferencedEvent`/`ReferencedEvent`), and a 304 from `If-None-Match` on
  `repos/o/r/issues/N/comments`. Not checked: whether a 304 on the comments
  endpoint also leaves the quota untouched (it did for `issues/N`).
- How t3code's `ChatMarkdown` renders `<details>` was inferred from the
  `data-markdown-details` selectors in `PullRequestMarkdown.tsx`. The file
  itself was not read.
- The mobile app (`apps/mobile/src/features/pull-requests/*`) was not read; it
  may have narrow-screen patterns worth a look.
