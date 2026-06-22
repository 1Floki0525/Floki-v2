#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$PROJECT_DIR/state/floki/chat/runtime"
PID_FILE="$RUNTIME_DIR/chat-local-runtime.pid"
COMPAT_PID_FILE="$RUNTIME_DIR/chat-mode-loop.pid"
STATUS_FILE="$RUNTIME_DIR/chat-local-runtime.status.json"
LOG_FILE="$RUNTIME_DIR/chat-local-runtime.log"

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

runtime_active() {
  CHECK_PID="$1"
  [ -n "$CHECK_PID" ] || return 1
  kill -0 "$CHECK_PID" >/dev/null 2>&1 || return 1
  if [ -r "/proc/$CHECK_PID/cmdline" ]; then
    CMDLINE="$(tr '\000' ' ' < "/proc/$CHECK_PID/cmdline")"
    case "$CMDLINE" in
      *src/runtime/chat-local-runtime.cjs*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  return 1
}

cd "$PROJECT_DIR" || fail "could not enter project directory"
load_node
case "$(node -v 2>/dev/null)" in v24.*) ;; *) fail "Node 24 is required" ;; esac
mkdir -p "$RUNTIME_DIR"

# YAML is the only authority for production chat/audio settings.
CONFIG_JSON="$(node - <<'NODE'
'use strict';
const { getAudioConfig, getLiveChatConfig } = require('./src/config/floki-config.cjs');
const audio = getAudioConfig('chat');
const live = getLiveChatConfig('chat');

const requiredAudioKeys = [
  'mic_device',
  'mic_rate',
  'mic_channels',
  'mic_format',
  'vad_frame_samples',
  'whisper_model_size',
  'piper_voice_name',
  'piper_voice_size'
];
for (const key of requiredAudioKeys) {
  if (audio[key] === undefined || audio[key] === null || audio[key] === '') {
    throw new Error('missing required YAML audio setting: audio.' + key);
  }
}
if (!Number.isFinite(live.runtime_start_timeout_ms) || live.runtime_start_timeout_ms <= 0) {
  throw new Error('live_chat.runtime_start_timeout_ms must be a positive YAML number');
}
if (!Number.isFinite(live.runtime_start_poll_ms) || live.runtime_start_poll_ms <= 0) {
  throw new Error('live_chat.runtime_start_poll_ms must be a positive YAML number');
}
process.stdout.write(JSON.stringify({
  runtime_start_timeout_ms: live.runtime_start_timeout_ms,
  runtime_start_poll_ms: live.runtime_start_poll_ms,
  audio_config_loaded: true
}));
NODE
)" || fail "could not load production audio/live chat settings from YAML"

START_TIMEOUT_MS="$(printf '%s' "$CONFIG_JSON" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(s).runtime_start_timeout_ms)))")" || fail "could not read YAML runtime_start_timeout_ms"
START_POLL_MS="$(printf '%s' "$CONFIG_JSON" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(s).runtime_start_poll_ms)))")" || fail "could not read YAML runtime_start_poll_ms"
MAX_POLLS="$(node -e "const timeout=Number(process.argv[1]);const poll=Number(process.argv[2]);if(!Number.isFinite(timeout)||timeout<=0||!Number.isFinite(poll)||poll<=0)process.exit(1);process.stdout.write(String(Math.ceil(timeout/poll)))" "$START_TIMEOUT_MS" "$START_POLL_MS")" || fail "invalid YAML runtime startup timing"
POLL_SECONDS="$(node -e "const poll=Number(process.argv[1]);if(!Number.isFinite(poll)||poll<=0)process.exit(1);process.stdout.write(String(poll/1000))" "$START_POLL_MS")" || fail "invalid YAML runtime startup poll interval"

if [ "${FLOKI_CHAT_SCRIPT_DRY_RUN:-0}" = "1" ]; then
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_START_SCRIPT_PASS\",\"dry_run\":true,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true}"
  exit 0
fi

EXISTING_PID=""
[ -f "$PID_FILE" ] && EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null)"
if runtime_active "$EXISTING_PID"; then
  echo "$EXISTING_PID" > "$COMPAT_PID_FILE"
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_START_SCRIPT_PASS\",\"already_active\":true,\"pid\":$EXISTING_PID,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true}"
  exit 0
fi

rm -f "$PID_FILE" "$COMPAT_PID_FILE" "$STATUS_FILE"
nohup node src/runtime/chat-local-runtime.cjs >> "$LOG_FILE" 2>&1 &
STARTED_PID="$!"
echo "$STARTED_PID" > "$PID_FILE"
echo "$STARTED_PID" > "$COMPAT_PID_FILE"

COUNT=0
while [ "$COUNT" -lt "$MAX_POLLS" ]; do
  if ! runtime_active "$STARTED_PID"; then
    tail -n 120 "$LOG_FILE" >&2 || true
    fail "production chat runtime exited during startup"
  fi
  if [ -f "$STATUS_FILE" ] && node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync(process.argv[1]));process.exit(s.api_ready===true&&s.brain_loaded===true?0:1)" "$STATUS_FILE" >/dev/null 2>&1; then
    echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_START_SCRIPT_PASS\",\"started\":true,\"pid\":$STARTED_PID,\"pid_file\":\"$PID_FILE\",\"status_file\":\"$STATUS_FILE\",\"log_file\":\"$LOG_FILE\",\"chat_mode_only\":true}"
    exit 0
  fi
  sleep "$POLL_SECONDS"
  COUNT=$((COUNT + 1))
done

tail -n 120 "$LOG_FILE" >&2 || true
kill "$STARTED_PID" >/dev/null 2>&1 || true
fail "production chat runtime did not become ready within YAML live_chat.runtime_start_timeout_ms=$START_TIMEOUT_MS"
