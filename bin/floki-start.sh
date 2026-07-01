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

startup_stage() {
  echo "[FLOKI STARTUP $1] $2"
}

preflight_core_brain() {
  BRAIN_OUTPUT="$(node src/brain/core-brain-status.cjs chat 2>&1)"
  BRAIN_STATUS="$?"

  if [ "$BRAIN_STATUS" -ne 0 ]; then
    echo "$BRAIN_OUTPUT" >&2
    fail "core brain preflight failed"
  fi

  if ! printf '%s\n' "$BRAIN_OUTPUT" |
    grep -q '"marker": "FLOKI_V2_CORE_BRAIN_STATUS_REPORT"'
  then
    echo "$BRAIN_OUTPUT" >&2
    fail "core brain preflight marker missing"
  fi

  echo "Core brain: configuration, module registry, identity, memory, emotion, and cognition factories loaded"
}

load_node_24() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    . "$HOME/.nvm/nvm.sh"
    if ! command -v node >/dev/null 2>&1 || ! floki_node_24_or_newer; then
      nvm use 24 >/dev/null 2>&1
    fi
  fi

  if ! command -v node >/dev/null 2>&1; then
    fail "node was not found on PATH"
  fi

  NODE_VERSION="$(node -v 2>/dev/null)"
  if ! floki_node_24_or_newer "$NODE_VERSION"; then
  fail "Node 24 or newer required, got $NODE_VERSION"
fi
}

print_active_config_and_paths() {
  node - <<'NODE'
'use strict';
const { configPathForMode, getPathConfig } = require('./src/config/floki-config.cjs');
const mode = 'chat';
const configFile = configPathForMode(mode);
const paths = getPathConfig(mode);
console.log('Active config file: ' + configFile);
console.log('Resolved production paths:');
for (const key of Object.keys(paths).sort()) {
  console.log('  ' + key + ': ' + String(paths[key]));
}
NODE
}

start_sleep_scheduler() {
  local output_file
  output_file="$(mktemp /tmp/floki-scheduler-start.XXXXXX)"
  bash bin/floki-sleep-scheduler-start.sh > "$output_file" 2>&1
  SCHEDULER_STATUS=$?
  SCHEDULER_OUTPUT="$(cat "$output_file" 2>/dev/null || true)"
  rm -f "$output_file"

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

VISION_STARTED=false

# FLOKI_CHAT_LOCAL_LIFECYCLE_HELPERS_BEGIN
CHAT_LOCAL_CLEANUP_DONE=0
CHAT_LOCAL_HANDED_OFF=0
SIGNAL_RECEIVED=0
CHAT_LOCAL_RUNTIME_DIR=""
CHAT_LOCAL_SUPERVISOR_LOCK_FILE=""
CHAT_LOCAL_SUPERVISOR_SESSION_FILE=""
CHAT_LOCAL_SESSION_ID=""
CHAT_LOCAL_RUNTIME_PID=""

# FLOKI_CHAT_LOCAL_SUPERVISOR_LEASE_BEGIN
acquire_chat_local_supervisor_lease() {
  command -v flock >/dev/null 2>&1 ||
    fail "flock is required for exclusive chat.local supervisor ownership"

  CHAT_LOCAL_RUNTIME_DIR="$(node - <<'NODE'
'use strict';
const path = require('node:path');
const {
  PROJECT_ROOT,
  getPathConfig
} = require('./src/config/floki-config.cjs');
process.stdout.write(
  path.resolve(
    PROJECT_ROOT,
    getPathConfig('chat').chat_runtime_root
  )
);
NODE
)" || fail "could not resolve the chat.local supervisor runtime directory"

  mkdir -p "$CHAT_LOCAL_RUNTIME_DIR" ||
    fail "could not create the chat.local runtime directory"

  CHAT_LOCAL_SUPERVISOR_LOCK_FILE="$CHAT_LOCAL_RUNTIME_DIR/chat-local-supervisor.lock"
  CHAT_LOCAL_SUPERVISOR_SESSION_FILE="$CHAT_LOCAL_RUNTIME_DIR/chat-local-supervisor-session.json"

  exec 9>"$CHAT_LOCAL_SUPERVISOR_LOCK_FILE"
  if ! flock -n 9; then
    fail "another chat.local supervisor is already active; close the existing neural interface before starting another session"
  fi

  CHAT_LOCAL_SESSION_ID="$(
    node src/runtime/chat-local-supervisor-lease.cjs       claim       "$CHAT_LOCAL_SUPERVISOR_SESSION_FILE"       "$$"       "$PROJECT_DIR"
  )" || fail "could not claim chat.local supervisor ownership"

  export FLOKI_CHAT_LOCAL_SESSION_ID="$CHAT_LOCAL_SESSION_ID"
  export FLOKI_CHAT_LOCAL_SESSION_FILE="$CHAT_LOCAL_SUPERVISOR_SESSION_FILE"
}

record_chat_local_runtime_lease() {
  local pid_file
  pid_file="$CHAT_LOCAL_RUNTIME_DIR/chat-local-runtime.pid"
  [ -f "$pid_file" ] ||
    fail "authoritative runtime PID file is missing after startup"

  CHAT_LOCAL_RUNTIME_PID="$(cat "$pid_file" 2>/dev/null || true)"
  case "$CHAT_LOCAL_RUNTIME_PID" in
    ''|*[!0-9]*)
      fail "authoritative runtime PID is invalid after startup"
      ;;
  esac

  node src/runtime/chat-local-supervisor-lease.cjs     set-runtime     "$CHAT_LOCAL_SUPERVISOR_SESSION_FILE"     "$CHAT_LOCAL_SESSION_ID"     "$CHAT_LOCAL_RUNTIME_PID"     >/dev/null ||
      fail "could not record authoritative runtime ownership"

  export FLOKI_CHAT_LOCAL_RUNTIME_PID="$CHAT_LOCAL_RUNTIME_PID"
}
# FLOKI_CHAT_LOCAL_SUPERVISOR_LEASE_END

cleanup_chat_local() {
  local last_exit="$?"
  if [ "$CHAT_LOCAL_CLEANUP_DONE" = "1" ]; then
    return "$last_exit"
  fi

  CHAT_LOCAL_CLEANUP_DONE=1
  trap - EXIT INT TERM HUP

  if [ -z "$CHAT_LOCAL_SESSION_ID" ] ||
     [ -z "$CHAT_LOCAL_SUPERVISOR_SESSION_FILE" ]; then
    return "$last_exit"
  fi

  timeout 30s bash bin/floki-chat-local-cleanup.sh >/dev/null 2>&1
  local cleanup_exit="$?"
  if [ "$cleanup_exit" -ne 0 ]; then
    echo "FLOKI_V2_CHAT_LOCAL_CLEANUP_FAIL: cleanup exited with status $cleanup_exit" >&2
    return "$cleanup_exit"
  fi

  return "$last_exit"
}

interrupt_chat_local() {
  SIGNAL_RECEIVED=1
  cleanup_chat_local
  echo "FLOKI_V2_CHAT_LOCAL_INTERRUPTED" >&2
  exit 130
}
# FLOKI_CHAT_LOCAL_LIFECYCLE_HELPERS_END

start_chat_webcam_vision() {
  export FLOKI_ALLOW_WEBCAM_CAPTURE=1
  export FLOKI_ALLOW_CHAT_VISION=1
  VISION_OUTPUT="$(bash bin/floki-chat-vision-start.sh 2>&1)"
  VISION_STATUS="$?"

  if [ "$VISION_STATUS" -ne 0 ]; then
    echo "$VISION_OUTPUT" >&2
    fail "chat webcam vision did not start"
  fi

  VISION_STARTED=true
  echo "$VISION_OUTPUT"
}

stop_chat_webcam_vision() {
  if [ "$VISION_STARTED" = true ]; then
    bash bin/floki-chat-vision-stop.sh
  fi
}

HEARING_STARTED=false

start_chat_hearing() {
  local output_file
  output_file="$(mktemp /tmp/floki-chat-start.XXXXXX)"
  bash bin/floki-chat-start.sh > "$output_file" 2>&1
  HEARING_STATUS=$?
  HEARING_OUTPUT="$(cat "$output_file" 2>/dev/null || true)"
  rm -f "$output_file"

  if [ "$HEARING_STATUS" -ne 0 ]; then
    echo "$HEARING_OUTPUT" >&2
    fail "chat hearing and spoken reply loop did not start"
  fi

  HEARING_STARTED=true
  echo "Runtime: $HEARING_OUTPUT"
}

stop_chat_hearing() {
  if [ "$HEARING_STARTED" = true ]; then
    bash bin/floki-chat-stop.sh >/dev/null 2>&1 || true
  fi
}

trap stop_chat_webcam_vision EXIT
trap 'exit' TERM INT HUP

if [ ! -d "$PROJECT_DIR" ]; then
  fail "Project directory not found: $PROJECT_DIR"
fi

cd "$PROJECT_DIR" || fail "Could not cd into $PROJECT_DIR"
load_node_24

if [ "$COMMAND" = "chat" ] || [ "$COMMAND" = "chat.local" ]; then
  node src/config/host-config-guard.cjs >/dev/null ||
    fail "active host configuration failed protected-path validation"
fi

case "$COMMAND" in
  chat)
    start_sleep_scheduler
    verify_sleep_scheduler
    start_chat_webcam_vision
    node src/chat/floki-live-chat-interface.cjs "$@"; RC=$?
    stop_chat_webcam_vision
    exit $RC
    ;;
  chat.local)
    acquire_chat_local_supervisor_lease
    trap cleanup_chat_local EXIT
    trap interrupt_chat_local INT TERM HUP

    startup_stage "1/7" "Node 24 runtime ready: $(node -v)"
    print_active_config_and_paths

    startup_stage "2/7" "Loading and validating the complete chat-mode core brain"
    preflight_core_brain

    startup_stage "3/7" "Starting the sleep, REM, and dream scheduler"
    start_sleep_scheduler
    verify_sleep_scheduler

    startup_stage "4/7" "Resolving Floki's sleep state before enabling eyes or ears"
    LIFECYCLE_JSON="$(node - <<'NODE'
'use strict';
const { buildFlokiLifecycleStatus } = require('./src/chat/floki-lifecycle-status.cjs');
const status = buildFlokiLifecycleStatus();
process.stdout.write(JSON.stringify({
  state: status.state,
  display_label: status.display_label,
  is_awake: status.is_awake === true,
  is_asleep: status.is_asleep === true,
  is_dreaming: status.is_dreaming === true,
  sleep_window: status.sleep_window_label
}));
NODE
)" || fail "could not resolve lifecycle before sensory startup"
    echo "Lifecycle: $LIFECYCLE_JSON"

    startup_stage "5/7" "Starting the authoritative backend with eyes and ears held off until the interface is visible"
    start_chat_hearing
    record_chat_local_runtime_lease

    CHAT_LOCAL_HANDED_OFF=1
    bash bin/floki-chat-local-start.sh "$@"
    CHAT_LOCAL_STATUS="$?"

    exit "$CHAT_LOCAL_STATUS"
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
echo "  bin/floki-start.sh chat.local        native Electron neural interface"
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
