#!/usr/bin/env bash
# Runs the real hooks/maestro-stopgate.sh (read only) against gh-stub.sh, with no
# model and no GitHub. usage: stopgate-matrix.sh <path to maestro-stopgate.sh> <work dir>
set -u
GATE=$1; W=$2; HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$W/bin" "$W/repo"; cp "$HERE/gh-stub.sh" "$W/bin/gh"; chmod +x "$W/bin/gh"
git -C "$W/repo" init -q 2>/dev/null
export GH_STUB_DIR=$W; export PATH="$W/bin:$PATH"; cd "$W/repo"
STOP='{"hook_event_name":"Stop","stop_hook_active":false}'
run() { # label, env assignments...
  local label=$1; shift
  local out; out=$(printf '%s' "$STOP" | env "$@" bash "$GATE" 2>&1); local rc=$?
  printf '%-44s rc=%s %s\n' "$label" "$rc" "$(printf '%s' "$out" | cut -c1-70)"
}
W_ENV="MAESTRO_ROLE=worker MAESTRO_ISSUE=7"
printf 'OPEN\nin-progress\n' >"$W/view"
run "no MAESTRO_ROLE"                     X=1
run "role=worker, no MAESTRO_ISSUE"       MAESTRO_ROLE=worker
run "role=scout, issue set"               MAESTRO_ROLE=scout MAESTRO_ISSUE=7
for n in 1 2 3 4; do run "open+labelled, stop $n" $W_ENV; done
echo "gh writes after the 4th stop:"; grep -v '^issue view' "$W/calls.log" | cut -c1-90
: >"$W/calls.log"
printf 'CLOSED\nin-progress\n' >"$W/view"; run "closed issue" $W_ENV
printf 'OPEN\nneeds-help\n' >"$W/view";  run "open, needs-help" $W_ENV
printf '' >"$W/view";                    run "open, no labels: jq prints nothing" $W_ENV
touch "$W/fail";                         run "gh fails" $W_ENV; rm "$W/fail"
printf 'OPEN\nin-progress\n' >"$W/view"
run "block count after one block" $W_ENV
echo "count file: $(cat "$W/repo/.worktree/.maestro/stopgate-7")"
run "second session, same issue: count carries" $W_ENV
echo "count file: $(cat "$W/repo/.worktree/.maestro/stopgate-7")"
