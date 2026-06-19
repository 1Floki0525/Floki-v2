#!/usr/bin/env bash

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
  nvm use 24 >/dev/null 2>&1
fi

NODE_VERSION="$(node -v 2>/dev/null)"
case "$NODE_VERSION" in
  v24.*)
    ;;
  *)
    fail "Node 24 required, got $NODE_VERSION"
    ;;
esac

node src/chat/sleep-cycle-scheduler.cjs --status
exit "$?"
