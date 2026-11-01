# How GitHub reports events across an account and its organisations

Research for [#178](https://github.com/christinoleo/claude-mux/issues/178), part of map [#177](https://github.com/christinoleo/claude-mux/issues/177). Sources were read on 2026-11-01. Everything was read-only: no webhook, App or setting was created.

## Short answer

No GitHub feature reports events for a whole personal account. One receiver can still hear everything through a GitHub App, because an App has a single webhook that serves every account it is installed on. The catch is that an App that installs on more than one account must be public, and then any GitHub user can install it.

For this map's first stages no organisation has to approve anything: claude-mux and the private projects can sit under `christinoleo`. Only organisation D and `UtrechtUniversity` would need someone else's approval, and the map does not reach them yet.

Both beliefs in the brief hold:

- **Personal accounts have no account-wide webhook. Confirmed.** "You cannot create webhooks for individual user accounts." ([Types of webhooks][types])
- **GitHub does not retry failed deliveries. Confirmed.** "GitHub does not automatically redeliver failed deliveries." ([Handling failed deliveries][failed])

## What the account holds

Read from the REST API with Leo's token on 2026-11-01.

- **`christinoleo` owns 118 repos, 58 of them public, not 100 and 49.** That is 60 private, 31 public originals and 27 public forks. The figure of 100 may come from a listing cut off at one page of 100, but I could not confirm that or explain 49.
- **Owner of organisation A, organisation B and organisation C** (API role `admin`). Other owners exist in organisation A and organisation C. Leo is the only owner of organisation B.
- **Plain member of organisation D.** He has no admin right on any of its repos that the API shows him.
- **Plain member of `UtrechtUniversity`.** The org enforces SAML and his token is not authorised for it, so its repos could not be read.
- **Collaborator on a few repos under other people's personal accounts**, without admin. No option below reaches these unless the account's owner acts.

## The options

### A webhook per repo

- **Needs:** repo owner or admin rights ([Creating webhooks][creating]). One webhook on each repo, created through the UI or REST.
- **Org approval:** none where Leo is a repo admin. Without admin he cannot create one, so organisation D is closed to him, and `UtrechtUniversity` is too unless he turns out to be admin on a repo there.
- **Leaving a repo out:** automatic. A repo without a webhook sends nothing.
- **Costs:** a new repo is silent until it gets a webhook, and catching up after downtime means walking the deliveries of every webhook separately. Each webhook has its own secret to set and rotate.

### An organisation webhook

- **Needs:** an org owner. "You must be an organization owner to create and manage webhooks in an organization." ([Types of webhooks][types]) A classic token also needs `admin:org_hook` ([REST: org webhooks][rest-org]), which Leo's `gh` token does not have today.
- **Reach:** "events that happen in all repositories owned by the organization." ([Types of webhooks][types])
- **Leaving a repo out: not possible.** The docs offer only event selection, not repo selection. The receiver could ignore a repo, but its payloads, including issue text, would already have reached `omarchy`.

### A GitHub App

- **Reach:** "Each GitHub App has a single webhook" ([Types of webhooks][types]), and it can be installed on several accounts ([Installing from a third party][install]). This is the only option that gives one URL, one secret and one delivery log across accounts.
- **Who installs:** anyone on their personal account; org owners on their org. Repo admins can install for repos they administer if the App requests no organisation permissions and not "Repository administration", unless owners have restricted that. Anyone else must ask. ([Installing from a third party][install], [Limiting installations][limit])
- **Request flow:** members and outside collaborators can request an install by default; owners may disable requests. An owner can change the selected repos and decides whether to install. ([Limiting installations][limit], [Requesting an App][request])
- **Leaving a repo out: yes.** An install chooses "All repositories" or "Only select repositories" ([Installing your own App][own]). With a selection, a repo that is not chosen is not one the App can access, so it should send no events. That last step is my inference from "a repository that your app can access" ([Webhooks with Apps][app-hooks]).
- **A selection can grow without Leo.** By default a repo admin can add their repo to an org's existing install, even when the App requests organisation permissions ([Limiting installations][limit]). The receiver should keep its own list of enabled repos.
- **Limits:** an account can register up to 100 Apps, and installs are unlimited ([Registering an App][register]).

**Private or public is the real choice.** A private App "can only be installed on the account that owns the app"; a public one can be installed by "any user on GitHub" ([Public or private][visibility]). That leaves two shapes:

- **One private App per owning account.** One each for `christinoleo`, organisation A, organisation B and organisation C if they are ever needed, all pointing at the same URL with separate secrets. Strangers cannot install it, but it means several registrations and it cannot reach an org Leo does not own, unless that org registers the App itself.
- **One public App.** It has one registration and can be requested in organisation D and `UtrechtUniversity`. But a stranger who installs it gets GitHub to send correctly signed events about their own repos to Leo's receiver. A valid signature would then no longer mean "one of Leo's repos". The receiver would have to check `installation.id` against a list on every delivery. Given the map's rule that a stranger's issue must never reach a worker, this is a real cost.

## Which orgs' approval is needed

- **`christinoleo`:** nobody's. Leo installs or creates what he likes.
- **organisation A, organisation B, organisation C:** no approval, because Leo is an owner. Telling the other owners of organisation A and organisation C is a courtesy GitHub does not require.
- **organisation D:** an org owner's. Leo has no admin to fall back on, so a webhook is out and an App means a request that an owner approves. A private App owned by Leo could not be installed there at all.
- **`UtrechtUniversity`:** an org owner's, with the same limit on private Apps. The exception would be a repo where he is admin, for an App that requests no org permissions, if owners allow that. I could not check either condition.

## When the receiver is down

- **No retry.** A delivery fails if the server is down or takes more than 10 seconds to answer ([Handling failed deliveries][failed], [Best practices][best]), and GitHub does not try again.
- **Manual redelivery covers the past 3 days only** ([Redelivering][redeliver]). It needs repo admin, org owner, or App owner or manager rights, matching the webhook type.
- **It can be automated.** List with `GET .../hook(s)/.../deliveries?status=failure`, redeliver with `POST .../deliveries/{id}/attempts` ([REST: repo webhooks][rest-repo], [REST: org webhooks][rest-org]). An App has one endpoint, `GET /app/hook/deliveries`, which needs a JWT signed with the App's private key ([REST: App webhooks][rest-app]). That is one call per App, against one call per webhook.
- **Duplicates are detectable.** A redelivery keeps the original `X-GitHub-Delivery` value ([Best practices][best]), so it works as a dedupe key.
- **Some events never exist.** Nothing is created when more than three tags or 5000 branches are pushed at once, and payloads over 25 MB are not delivered ([Events and payloads][events]). These leave nothing to redeliver.

An outage past 3 days loses events for good, and some events never get sent, so the periodic check on the map is required and is not only a backup. The Events API cannot replace it for prompt detection: "event latency can be anywhere from 30s to 6h" and it is "not built to serve real-time use cases" ([REST: events][rest-events]).

## Verifying signatures

Set a secret, then compare `X-Hub-Signature-256` with `sha256=` plus the HMAC-SHA256 hex digest of the raw body, using a constant-time comparison and never `==`. Handle the body as UTF-8. `X-Hub-Signature` (SHA-1) exists only for legacy reasons. ([Validating deliveries][validate], [Events and payloads][events])

GitHub also suggests answering 2XX quickly and processing from a queue, subscribing only to needed events, and optionally allowlisting the IPs from `GET /meta` ([Best practices][best]). This fits the map's event queue.

A valid signature shows that GitHub sent the event. It says nothing about who acted, or whose repo it was.

## Who applied a label, who pushed

Field names come from GitHub's [OpenAPI description][openapi] as well as [Events and payloads][events], because the docs page leaves `sender` out of the `push` table.

- **Label:** `issues` with `action: labeled`. `sender` is required and `label` carries the name. Require `label.name == "ready-for-agent"` and that `sender.id` is Leo's. His id is `1745901`, and an id is safer than a login, which can change.
- **Push:** the `push` event. `sender` is present but not marked required, so treat a missing one as "not Leo". `pusher` has only `name` as required, described as "the git author's name", so it should not decide trust. Commit authors are whatever git was told. `ref`, `before`, `after` and `forced` say what moved.
- **`ghost`:** `sender` can be the placeholder user `ghost`, and "Don't assume `sender` always identifies the person" ([Events and payloads][events]). An id check rejects it.
- **Reading it back:** the doorbell design can confirm from `GET /repos/{owner}/{repo}/issues/{n}/timeline` or `/events`, whose `labeled` entries carry `actor`, `label` and `created_at` ([Issue event types][issue-events]). With an App this takes the Issues read permission ([App permissions][permissions]).
- **Checking the sender and not the label's presence matters on public repos.** Applying labels needs triage access or above ([Repository roles][roles]), but an issue template can add labels by itself ([Issue forms][forms]), so a stranger's new issue could carry `ready-for-agent` if a template named it. The docs do not say who `sender` is in that case.

## An issue edited after being labelled

- **What arrives:** `issues` with `action: edited`, described as "The title or body on an issue was edited." It carries `sender` (the editor), `issue` as it now stands, and `changes.title.from` and/or `changes.body.from` with the old text ([Events and payloads][events], [OpenAPI][openapi]).
- **`labeled` is not sent again.** The docs tie `labeled` to a label being added, so an edit should produce only `edited`, and a handler that listens for `labeled` alone will miss it. This is my reading of the docs. I did not observe it.
- **Why it matters.** The author of an issue can normally change its text after Leo labels it. Leo's label approved the text he read, and a worker started later, or from a re-read during a catch-up, would see the new text. Reading the live state, as the doorbell design does, makes this easy to miss, because the label is still there.
- **What can detect it:** the GraphQL `Issue` has `lastEditedAt`, `editor` and `userContentEdits` ([GraphQL: Issues][gql]). Comparing `lastEditedAt` with the label's `created_at` shows whether the text changed afterwards, and `editor` shows by whom. `updated_at` is too broad, because other activity also moves it.

## What I could not establish

- **Why Leo's figures differ** from the API's 118 and 58.
- **Leo's repo access in `UtrechtUniversity`.** Reads returned 403 for SAML, so whether he is admin on any repo there is unknown. The same token would also fail for reading state there until it is authorised for SSO ([About SSO][sso]).
- **App policies in the orgs.** Whether each org has restricted repo-admin installs or disabled requests needs owner access, and I did not try to read it.
- **Which repos are a client's.** Nothing in the API marks this, so Leo has to name them. It decides where an org webhook is ruled out.
- **Whether an App receives events for a public repo it is not installed on.** It has read access to all public repos ([Installing your own App][own]). The docs imply that events need an install but do not say so. Filter by `installation.id` either way.
- **Payload behaviour not seen live.** No webhook exists on `claude-mux` and creating one was out of scope, so the field descriptions come from docs and schema, not captured deliveries. Three points need a real delivery: whether `issues.edited` ever fills `label`, what `pusher.name` holds in practice, and who `sender` is on a template-applied label.
- **Delivery order, and whether a long-failing webhook gets disabled.** The pages I read state neither, so do not rely on order.
- **Plan limits.** organisation A, organisation B, organisation D and organisation C are on the Free plan. I found no statement that this limits webhooks or Apps, but no statement that it does not either.

[types]: https://docs.github.com/en/webhooks/types-of-webhooks
[failed]: https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
[redeliver]: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
[creating]: https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks
[best]: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
[validate]: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
[events]: https://docs.github.com/en/webhooks/webhook-events-and-payloads
[install]: https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party
[own]: https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app
[request]: https://docs.github.com/en/apps/using-github-apps/requesting-a-github-app-from-your-organization-owner
[limit]: https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/limiting-oauth-app-and-github-app-access-requests-and-installations
[visibility]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private
[register]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
[app-hooks]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps
[permissions]: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
[rest-org]: https://docs.github.com/en/rest/orgs/webhooks
[rest-repo]: https://docs.github.com/en/rest/repos/webhooks
[rest-app]: https://docs.github.com/en/rest/apps/webhooks
[rest-events]: https://docs.github.com/en/rest/activity/events
[issue-events]: https://docs.github.com/en/rest/using-the-rest-api/issue-event-types
[gql]: https://docs.github.com/en/graphql/reference/issues
[roles]: https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization
[forms]: https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms
[sso]: https://docs.github.com/en/authentication/authenticating-with-single-sign-on/about-authentication-with-single-sign-on
[openapi]: https://github.com/github/rest-api-description
