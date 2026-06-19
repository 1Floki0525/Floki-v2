#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$#" -gt 0 ]; then
  COMMAND="$1"
  shift
else
  COMMAND=""
fi

fail() {
  echo "FLOKI_V2_START_FAIL: $1" >&2
  exit 1
}

if [ ! -d "$PROJECT_DIR" ]; then
  fail "Project directory not found: $PROJECT_DIR"
fi

cd "$PROJECT_DIR" || fail "Could not cd into $PROJECT_DIR"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$HOME/.nvm/nvm.sh"
  if [ -f "$PROJECT_DIR/.nvmrc" ]; then
    nvm use >/dev/null 2>&1
  else
    nvm use 24 >/dev/null 2>&1
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  fail "node was not found on PATH"
fi

case "$COMMAND" in
  chat)
    node src/chat/floki-live-chat-interface.cjs "$@"
    exit "$?"
    ;;
  text-chat)
    node src/chat/floki-chat.cjs "$@"
    exit "$?"
    ;;
  chat-smoke)
    node src/chat/floki-chat.cjs --smoke
    exit "$?"
    ;;
  chat-loop-start)
    bash bin/floki-chat-start.sh "$@"
    exit "$?"
    ;;
  chat-loop-stop)
    bash bin/floki-chat-stop.sh "$@"
    exit "$?"
    ;;
  chat-loop-status)
    bash bin/floki-chat-status.sh "$@"
    exit "$?"
    ;;
  game)
    node src/game/floki-game.cjs "$@"
    exit "$?"
    ;;
  game-smoke)
    node src/game/floki-game.cjs --smoke
    exit "$?"
    ;;
  senses)
    node src/senses/offline-senses.cjs "$@"
    exit "$?"
    ;;
  senses-smoke)
    node src/senses/offline-senses.cjs --smoke
    exit "$?"
    ;;
  senses-status)
    node src/senses/offline-senses.cjs --status
    exit "$?"
    ;;
  brain-status)
    MODE="${1:-chat}"
    node src/brain/core-brain-status.cjs "$MODE"
    exit "$?"
    ;;
  life-status)
    node src/chat/floki-lifecycle-status.cjs "$@"
    exit "$?"
    ;;
  status)
    node src/game/floki-game.cjs --status
    exit "$?"
    ;;
  "")
    ;;
  *)
    echo "FLOKI_V2_START_UNKNOWN_COMMAND: $COMMAND" >&2
    ;;
esac

echo "Floki-v2 start commands:"
echo "  bin/floki-start.sh chat              live chat: typed text + spoken wake-word input"
echo "  bin/floki-start.sh text-chat         old typed-only terminal chat"
echo "  bin/floki-start.sh chat-loop-start   start background spoken wake-word listener"
echo "  bin/floki-start.sh chat-loop-stop    stop background spoken wake-word listener"
echo "  bin/floki-start.sh chat-loop-status  show background spoken listener status"
echo "  bin/floki-start.sh life-status       show awake/sleep/REM lifecycle status"
echo ""
echo "Current stage:"
echo "  chat mode accepts typed text and spoken wake-word input"
echo "  public transcript excludes private thoughts"
echo "  private thought summaries are recorded only in private review/memory logs"
echo "  game mode remains guarded"
exit 0
