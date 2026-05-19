#!/usr/bin/env bash
# claude-mux install/update script
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/christinoleo/claude-mux/main/scripts/install.sh | bash
#
# Flags via env:
#   CLAUDE_MUX_VERSION=0.7.1   pin a specific version
#   CLAUDE_MUX_NO_SETUP=1      skip post-install `setup --yes`
#   CLAUDE_MUX_NO_SERVE=1      skip starting the prod server
#   CLAUDE_MUX_PORT=3456       prod port (default 3456, loopback only)

set -euo pipefail

PORT="${CLAUDE_MUX_PORT:-3456}"
VERSION_SPEC="${CLAUDE_MUX_VERSION:-latest}"

log() { printf '\033[1;36m[claude-mux]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[claude-mux]\033[0m %s\n' "$*" >&2; }

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    log "bun present: $(bun --version)"
    return
  fi
  log "Installing bun (required runtime)..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
}

ensure_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    err "npm not found. Install Node.js (e.g. via nvm or your package manager) and re-run."
    exit 1
  fi
}

install_pkg() {
  log "Installing claude-mux@${VERSION_SPEC} globally..."
  npm i -g "claude-mux@${VERSION_SPEC}"
}

run_setup() {
  if [ "${CLAUDE_MUX_NO_SETUP:-0}" = "1" ]; then
    log "Skipping setup (CLAUDE_MUX_NO_SETUP=1)."
    return
  fi
  log "Running setup --yes to install Claude Code hooks..."
  claude-mux setup --yes
}

restart_prod() {
  if [ "${CLAUDE_MUX_NO_SERVE:-0}" = "1" ]; then
    log "Skipping prod server start (CLAUDE_MUX_NO_SERVE=1)."
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    PIDS=$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
      log "Stopping old server on :$PORT (pids: $PIDS)..."
      kill -TERM $PIDS 2>/dev/null || true
      sleep 2
      kill -KILL $PIDS 2>/dev/null || true
    fi
  fi
  log "Starting claude-mux serve on 127.0.0.1:$PORT (loopback only)..."
  nohup claude-mux serve --port "$PORT" --host 127.0.0.1 \
    >/tmp/claude-mux-prod.log 2>&1 &
  disown || true
  sleep 1
  log "Logs: /tmp/claude-mux-prod.log"
}

main() {
  ensure_bun
  ensure_npm
  install_pkg
  run_setup
  restart_prod
  log "Done. Version: $(claude-mux --version 2>/dev/null || echo unknown)"
  log "Reachable at http://127.0.0.1:$PORT (front via Tailscale HTTPS if configured)."
}

main "$@"
