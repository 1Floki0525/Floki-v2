#!/usr/bin/env bash


floki_node_24_or_newer() {
  local floki_node_version="${1:-}"
  local floki_node_major
  if [ -z "$floki_node_version" ]; then
    command -v node >/dev/null 2>&1 || return 1
    floki_node_version="$(node -v 2>/dev/null)" || return 1
  fi
  floki_node_version="${floki_node_version#v}"
  floki_node_major="${floki_node_version%%.*}"
  case "$floki_node_major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$floki_node_major" -ge 24 ]
}

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  echo "{\"ok\":false,\"marker\":\"FLOKI_V2_SLEEP_CYCLE_SCHEDULER_STATUS_ERROR\",\"error\":\"$1\",\"chat_mode_only\":true,\"game_mode_started\":false}" >&2
  exit 1
}

if [ ! -d "$PROJECT_DIR" ]; then
  fail "Project directory not found: $PROJECT_DIR"
fi

cd "$PROJECT_DIR" || fail "Could not cd into $PROJECT_DIR"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$HOME/.nvm/nvm.sh"
  if ! command -v node >/dev/null 2>&1 || ! floki_node_24_or_newer; then
    nvm use 24 >/dev/null 2>&1
  fi
fi

NODE_VERSION="$(node -v 2>/dev/null)"
if ! floki_node_24_or_newer "$NODE_VERSION"; then
  fail "Node 24 or newer required, got $NODE_VERSION"
fi

node src/chat/sleep-cycle-scheduler.cjs --status
exit "$?"
