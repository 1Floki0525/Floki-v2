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

load_node_24() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    . "$HOME/.nvm/nvm.sh"
    nvm use 24 >/dev/null 2>&1
  fi

  if ! command -v node >/dev/null 2>&1; then
    fail "node was not found on PATH"
  fi

  NODE_VERSION="$(node -v 2>/dev/null)"
  case "$NODE_VERSION" in
    v24.*)
      ;;
    *)
      fail "Node 24 required, got $NODE_VERSION"
      ;;
  esac
}

start_sleep_scheduler() {
  SCHEDULER_OUTPUT="$(bash bin/floki-sleep-scheduler-start.sh 2>&1)"
  SCHEDULER_STATUS="$?"

  if [ "$SCHEDULER_STATUS" -ne 0 ]; then
    echo "$SCHEDULER_OUTPUT" >&2
    fail "sleep-cycle scheduler did not start"
  fi

  echo "Sleep scheduler: $SCHEDULER_OUTPUT"
  export FLOKI_ALLOW_SLEEP_CYCLE=1
}

verify_sleep_scheduler() {
  SCHEDULER_STATUS_OUTPUT="$(bash bin/floki-sleep-scheduler-status.sh 2>&1)"
  SCHEDULER_STATUS_CODE="$?"

  if [ "$SCHEDULER_STATUS_CODE" -ne 0 ]; then
    echo "$SCHEDULER_STATUS_OUTPUT" >&2
    fail "sleep-cycle scheduler status check failed"
  fi
}

start_chat_webcam_vision() {
  export FLOKI_ALLOW_WEBCAM_CAPTURE=1
  export FLOKI_ALLOW_CHAT_VISION=1
  VISION_OUTPUT="$(bash bin/floki-chat-vision-start.sh 2>&1)"
  VISION_STATUS="$?"

  if [ "$VISION_STATUS" -ne 0 ]; then
    echo "$VISION_OUTPUT" >&2
    fail "chat webcam vision did not start"
  fi

  echo "$VISION_OUTPUT"
}

if [ ! -d "$PROJECT_DIR" ]; then
  fail "Project directory not found: $PROJECT_DIR"
fi

cd "$PROJECT_DIR" || fail "Could not cd into $PROJECT_DIR"
load_node_24

case "$COMMAND" in
  chat)
    start_sleep_scheduler
    verify_sleep_scheduler
    start_chat_webcam_vision
    node src/chat/floki-live-chat-interface.cjs "$@"
    exit "$?"
    ;;
  text-chat)
    start_sleep_scheduler
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
  chat-vision-start)
    bash bin/floki-chat-vision-start.sh "$@"
    exit "$?"
    ;;
  chat-vision-stop)
    bash bin/floki-chat-vision-stop.sh "$@"
    exit "$?"
    ;;
  chat-vision-status)
    bash bin/floki-chat-vision-status.sh "$@"
    exit "$?"
    ;;
  sleep-start)
    bash bin/floki-sleep-scheduler-start.sh "$@"
    exit "$?"
    ;;
  sleep-stop)
    bash bin/floki-sleep-scheduler-stop.sh "$@"
    exit "$?"
    ;;
  sleep-status)
    bash bin/floki-sleep-scheduler-status.sh "$@"
    exit "$?"
    ;;
  sleep-once)
    FLOKI_ALLOW_SLEEP_CYCLE=1 FLOKI_ALLOW_DREAM_ENGINE=1 node src/chat/sleep-cycle-scheduler.cjs --once
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
echo "  bin/floki-start.sh chat-loop-stop    stop background spoken listener"
echo "  bin/floki-start.sh chat-loop-status  show background spoken listener status"
echo "  bin/floki-start.sh chat-vision-start start continuous chat webcam vision"
echo "  bin/floki-start.sh chat-vision-stop  stop continuous chat webcam vision"
echo "  bin/floki-start.sh chat-vision-status show continuous chat webcam vision status"
echo "  bin/floki-start.sh sleep-start       start continuous sleep/REM scheduler"
echo "  bin/floki-start.sh sleep-stop        stop continuous sleep/REM scheduler"
echo "  bin/floki-start.sh sleep-status      show continuous sleep/REM scheduler status"
echo "  bin/floki-start.sh sleep-once        run one guarded scheduler tick"
echo "  bin/floki-start.sh life-status       show awake/sleep/REM lifecycle status"
echo ""
echo "Current stage:"
echo "  chat mode starts the continuous sleep-cycle scheduler"
echo "  public transcript excludes private thoughts"
echo "  private thought summaries are recorded only in private review/memory logs"
echo "  game mode remains guarded"
exit 0
