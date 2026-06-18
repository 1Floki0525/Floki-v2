#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  echo "{\"ok\":false,\"marker\":\"FLOKI_V2_CHAT_STATUS_SCRIPT_FAIL\",\"error\":\"$1\",\"chat_mode_only\":true}" >&2
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

if ! command -v node >/dev/null 2>&1; then
  fail "node was not found on PATH"
fi

node src/chat/chat-mode-script-status.cjs
exit "$?"
