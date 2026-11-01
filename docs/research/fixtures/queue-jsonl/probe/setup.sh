#!/bin/sh
# Prepares a throwaway probe directory. Usage: PROBE159_DIR=/some/scratch sh setup.sh
# Then run scenarios.py and scenarios-interrupt.py with PROBECOLOR=256 (default) or PROBECOLOR=truecolor.
# Uses a private tmux socket and project-only settings; afterwards run:
#   tmux -L probe159 kill-server; rm -rf ~/.claude/projects/*probe159-proj
set -e
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$PROBE159_DIR/probe159-proj/.claude" "$PROBE159_DIR/run"
python3 -I - "$PROBE159_DIR" "$here/hook.py" <<'PY'
import json, sys
root, hook = sys.argv[1:]
command = f"PROBE={root} python3 -I {hook}"
events = ["UserPromptSubmit", "Stop", "PreToolUse", "PostToolUse", "PermissionRequest"]
settings = {
    "permissions": {"allow": ["Bash(sleep:*)"]},
    "hooks": {e: [{"hooks": [{"type": "command", "command": command}]}] for e in events},
}
json.dump(settings, open(f"{root}/probe159-proj/.claude/settings.json", "w"), indent=1)
PY
