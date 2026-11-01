#!/bin/sh
# Stands in for gh so the real maestro stop gate can run without touching GitHub.
# $GH_STUB_DIR/view holds what `gh issue view --jq` would print; a file named
# fail makes `gh issue view` exit 1. Every call is appended to calls.log.
echo "$*" >>"$GH_STUB_DIR/calls.log"
case "$1 $2" in
  "issue view")
    [ -e "$GH_STUB_DIR/fail" ] && exit 1
    cat "$GH_STUB_DIR/view" ;;
esac
exit 0
