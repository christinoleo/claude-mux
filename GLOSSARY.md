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

**Past session**:
A Claude Code conversation whose transcript is on a machine's disk but which has no live pane.
_Avoid_: Dead session, history, closed session
