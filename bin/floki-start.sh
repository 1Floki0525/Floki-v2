#!/usr/bin/env bash

PROJECT_DIR="/media/binary-god/1tb-ssd/Floki-v2"
COMMAND="$1"

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
    node src/chat/floki-chat.cjs
    exit "$?"
    ;;

  chat-smoke)
    node src/chat/floki-chat.cjs --smoke
    exit "$?"
    ;;

  game)
    node src/game/floki-game.cjs
    exit "$?"
    ;;

  game-smoke)
    node src/game/floki-game.cjs --smoke
    exit "$?"
    ;;

  senses)
    node src/senses/offline-senses.cjs
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
echo "  bin/floki-start.sh chat          open terminal chat mode"
echo "  bin/floki-start.sh chat-smoke    run terminal chat smoke proof"
echo "  bin/floki-start.sh game          start Minecraft/in-game mode when wired"
echo "  bin/floki-start.sh game-smoke    prove game entrypoint is guarded until wired"
echo "  bin/floki-start.sh senses        offline USB webcam/mic senses when wired"
echo "  bin/floki-start.sh senses-smoke  prove offline senses entrypoint is guarded/detect-only"
echo "  bin/floki-start.sh senses-status show detected offline camera/mic devices"
echo "  bin/floki-start.sh status        show current game-mode readiness"
echo ""
echo "Current stage:"
echo "  chat mode works with qwen cognition + Broca speech"
echo "  game mode exists but is guarded until Minecraft body/eyes/bridge are wired"
echo "  senses mode exists but is detect-only until webcam/mic capture stages are wired"
exit 0
