# claude-mux

A dashboard for the Claude Code sessions running in tmux on one or more computers, from which a person watches, answers and directs them.

## Machines

**Machine**:
A computer that runs claude-mux and owns the sessions in its own tmux.
_Avoid_: Server, host, node

**Origin machine**:
The machine that served the page a person has open.
_Avoid_: Local server, home, hub

**Fleet**:
Every machine a person reaches over their tailnet, taken together.
_Avoid_: Cluster, servers

## Sessions

**Project**:
A codebase a person works in, the same one on every machine that holds it: matched by its git remote, else by its folder name under `~/Projects`.
_Avoid_: Repo, folder, workspace

**Session**:
A Claude Code process running in a tmux pane on a machine.
_Avoid_: Agent, pane, chat

**Live text**:
The words of a reply while Claude writes them, before they enter the session's record.
_Avoid_: Preview, streaming, draft

**Held dialog**:
A question or approval whose hook is waiting for a person's answer from the dashboard, while the terminal can still answer it.
_Avoid_: Pending request, blocked hook

**Past session**:
A Claude Code conversation whose transcript is on a machine's disk but which has no live pane.
_Avoid_: Dead session, history, closed session

## Triggers

**Trigger**:
When plus what: a schedule or an event the GitHub polling finds, and the rule or session it fires. Set up per machine.
_Avoid_: Job, cron, hook, automation

**Run**:
One firing of a Trigger, kept with what came of it: run, or skipped with the reason, and for a session a link to it.
_Avoid_: Execution, job, instance

**Scheduled Task**:
A Trigger on the clock that opens a session with a prompt, in a project, and closes it when its turn ends or its time limit falls.
_Avoid_: Cron job, routine, scheduled session
