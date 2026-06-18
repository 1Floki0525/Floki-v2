#!/usr/bin/env bash

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/floki-chat-start.sh"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$PROJECT_DIR/state/floki/chat/runtime"
PID_FILE="$RUNTIME_DIR/chat-mode-loop.pid"
STOP_FILE="$RUNTIME_DIR/chat-mode-loop.stop"
LOG_FILE="$RUNTIME_DIR/chat-mode-loop.log"
KNOWN_AUDIO="$PROJECT_DIR/.floki-tools/input/microphone-smoke/microphone_smoke_20260617204048.wav"
LOOP_CHILD_PID=""

fail() {
  echo "{\"ok\":false,\"marker\":\"FLOKI_V2_CHAT_START_SCRIPT_FAIL\",\"error\":\"$1\",\"chat_mode_only\":true}" >&2
  exit 1
}

load_node() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    . "$HOME/.nvm/nvm.sh"
    nvm use 24 >/dev/null 2>&1
  fi
}

runner_active() {
  CHECK_PID="$1"

  if [ -z "$CHECK_PID" ]; then
    return 1
  fi

  if ! kill -0 "$CHECK_PID" >/dev/null 2>&1; then
    return 1
  fi

  if [ -r "/proc/$CHECK_PID/cmdline" ]; then
    CMDLINE="$(tr '\000' ' ' < "/proc/$CHECK_PID/cmdline")"
    case "$CMDLINE" in
      *floki-chat-start.sh*"--runner"*)
        return 0
        ;;
      *)
        return 1
        ;;
    esac
  fi

  return 1
}

run_loop_once() {
  export FLOKI_ALLOW_CHAT_MODE_LOOP=1
  export FLOKI_CHAT_MODE_LOOP_TURNS="${FLOKI_CHAT_MODE_LOOP_TURNS:-1}"

  # Read defaults from YAML config via Node helper
  cd "$PROJECT_DIR" || fail "could not cd into project"
  WHISPER_MODEL_DEFAULT="$(node -e "const c=require('./src/config/floki-config.cjs');console.log(c.getAudioConfig('chat').whisper_model_size)" 2>/dev/null || echo 'small')"
  HEARING_SECONDS_DEFAULT="$(node -e "const c=require('./src/config/floki-config.cjs');console.log(c.getAudioConfig('chat').proof_capture_seconds)" 2>/dev/null || echo '2')"
  LIVE_REPLY_MODE_DEFAULT="$(node -e "const c=require('./src/config/floki-config.cjs');console.log(c.getLiveChatConfig('chat').live_reply_mode)" 2>/dev/null || echo '1')"

  export FLOKI_HEARING_CAPTURE_SECONDS="${FLOKI_HEARING_CAPTURE_SECONDS:-$HEARING_SECONDS_DEFAULT}"
  export FLOKI_WHISPER_MODEL_SIZE="${FLOKI_WHISPER_MODEL_SIZE:-$WHISPER_MODEL_DEFAULT}"
  export FLOKI_CHAT_LIVE_REPLY_MODE="${FLOKI_CHAT_LIVE_REPLY_MODE:-$LIVE_REPLY_MODE_DEFAULT}"

  if [ "${FLOKI_CHAT_MODE_USE_KNOWN_AUDIO:-0}" = "1" ] && [ -f "$KNOWN_AUDIO" ] && [ -z "$FLOKI_HEARING_INPUT_WAV" ]; then
    export FLOKI_HEARING_INPUT_WAV="$KNOWN_AUDIO"
  fi

  npm run proof:chat-mode-loop &
  LOOP_CHILD_PID="$!"
  wait "$LOOP_CHILD_PID"
  CHILD_STATUS="$?"
  LOOP_CHILD_PID=""
  return "$CHILD_STATUS"
}

stop_runner() {
  touch "$STOP_FILE"

  if [ -n "$LOOP_CHILD_PID" ]; then
    kill "$LOOP_CHILD_PID" >/dev/null 2>&1
  fi
}

runner_main() {
  cd "$PROJECT_DIR" || exit 1
  load_node

  if ! command -v npm >/dev/null 2>&1; then
    echo "npm missing" >&2
    exit 1
  fi

  mkdir -p "$RUNTIME_DIR"
  echo "$$" > "$PID_FILE"
  trap stop_runner TERM INT

  while [ ! -f "$STOP_FILE" ]; do
    date -Is
    run_loop_once
    LOOP_STATUS="$?"
    echo "chat_mode_loop_exit_status=$LOOP_STATUS"

    if [ "${FLOKI_CHAT_RUN_ONCE:-0}" = "1" ]; then
      break
    fi

    sleep "${FLOKI_CHAT_LOOP_RESTART_SECONDS:-1}"
  done

  CURRENT_PID=""
  if [ -f "$PID_FILE" ]; then
    CURRENT_PID="$(cat "$PID_FILE" 2>/dev/null)"
  fi

  if [ "$CURRENT_PID" = "$$" ]; then
    rm -f "$PID_FILE"
  fi

  exit 0
}

if [ "$1" = "--runner" ]; then
  runner_main
fi

if [ ! -d "$PROJECT_DIR" ]; then
  fail "Project directory not found: $PROJECT_DIR"
fi

cd "$PROJECT_DIR" || fail "Could not cd into $PROJECT_DIR"
load_node

if ! command -v node >/dev/null 2>&1; then
  fail "node was not found on PATH"
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm was not found on PATH"
fi

mkdir -p "$RUNTIME_DIR"

if [ "${FLOKI_CHAT_SCRIPT_DRY_RUN:-0}" = "1" ]; then
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_START_SCRIPT_PASS\",\"dry_run\":true,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true}"
  exit 0
fi

EXISTING_PID=""
if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null)"
fi

if runner_active "$EXISTING_PID"; then
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_START_SCRIPT_PASS\",\"already_active\":true,\"pid\":$EXISTING_PID,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true}"
  exit 0
fi

rm -f "$PID_FILE" "$STOP_FILE"

nohup bash "$SCRIPT_PATH" --runner >> "$LOG_FILE" 2>&1 &
STARTED_PID="$!"
echo "$STARTED_PID" > "$PID_FILE"
sleep 1

if ! runner_active "$STARTED_PID"; then
  fail "chat runner did not stay active"
fi

echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_START_SCRIPT_PASS\",\"started\":true,\"pid\":$STARTED_PID,\"pid_file\":\"$PID_FILE\",\"log_file\":\"$LOG_FILE\",\"chat_mode_only\":true}"
exit 0
