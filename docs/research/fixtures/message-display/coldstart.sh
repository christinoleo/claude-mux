#!/bin/bash
# Mean wall time of one hook-shaped process, run through /bin/sh with one JSON payload on stdin.
# usage: coldstart.sh <tools dir> <claude-mux src> <n>
T=$1; M=$2; N=${3:-30}; R=$(mktemp -d)
PAY='{"hook_event_name":"MessageDisplay","delta":"x\n","index":0,"final":false,"message_id":"m","turn_id":"t"}'
b(){ local s=$(date +%s%N); for i in $(seq $N); do echo "$PAY" | /bin/sh -c "$2" >/dev/null; done; local e=$(date +%s%N); echo "$1: $(( (e-s)/N/1000 )) us per run (n=$N)"; }
b "sh true" "true"
b "python3 -I logger" "PROBE_RUN=$R python3 -I $T/hook.py"
b "bun minimal" "PROBE_RUN=$R MUX_SRC= bun $T/display-hook.ts message-display"
b "bun with claude-mux imports" "PROBE_RUN=$R MUX_SRC=$M bun $T/display-hook.ts message-display"
b "jq" "jq -c . "
rm -rf "$R"
