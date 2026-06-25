#!/usr/bin/env bash

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$HOME/.nvm/nvm.sh"
  nvm use 24.17.0 >/dev/null 2>&1 || nvm use 24 >/dev/null 2>&1
fi

fail() {
  echo "FLOKI_CHAT_LOCAL_PRODUCTION_VERIFY_FAIL: $1" >&2
  exit 1
}

run_step() {
  LABEL="$1"
  shift
  echo
  echo "=== $LABEL ==="
  "$@"
  STATUS="$?"
  [ "$STATUS" -eq 0 ] || fail "$LABEL status=$STATUS"
}

[ "$(node -v 2>/dev/null)" = "v24.17.0" ] || fail "Node v24.17.0 required; actual=$(node -v 2>/dev/null || printf unavailable)"

ROOT_SESSION_FILE="$(find "$ROOT" -maxdepth 1 -type f -name 'session-*.md' -print -quit)"
[ -z "$ROOT_SESSION_FILE" ] || fail "session evidence is inside the active source root: $ROOT_SESSION_FILE"

run_step "Syntax: config" node --check src/config/floki-config.cjs
run_step "Syntax: wake continuation" node --check src/chat/wake-command-continuation.cjs
run_step "Syntax: live audio" node --check src/senses/live-audio-service.cjs
run_step "Syntax: dream engine" node --check src/chat/dream-engine.cjs
run_step "Syntax: scheduler" node --check src/chat/sleep-cycle-scheduler.cjs
run_step "Chat.local config authority" node tests/chat-local-config-authority-contract-test.cjs
run_step "Chat.local YAML model authority" node tests/chat-local-yaml-model-authority-contract-test.cjs
run_step "Complete chat.local test suite" npm run test:chat-local
run_step "Production interface build" npm run build

echo
echo "FLOKI_CHAT_LOCAL_PRODUCTION_STATIC_VERIFY_PASS"
echo "Next: bash bin/floki-start.sh chat.local"
echo "Then say exactly: Hey Floki, what can you see?"
echo "After the spoken test, run the live production proof script."
