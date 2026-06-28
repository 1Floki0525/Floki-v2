#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR=""
PID_FILE=""
COMPAT_PID_FILE=""
STATUS_FILE=""
LOG_FILE=""

fail() {
  echo "{\"ok\":false,\"marker\":\"FLOKI_V2_CHAT_START_SCRIPT_FAIL\",\"error\":\"$1\",\"chat_mode_only\":true}" >&2
  exit 1
}

load_node() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    . "$HOME/.nvm/nvm.sh"
    if ! command -v node >/dev/null 2>&1 || ! node -v 2>/dev/null | grep -Eq '^v24\.'; then
      nvm use 24 >/dev/null 2>&1
    fi
  fi
}

resolve_runtime_paths() {
  RUNTIME_DIR="$(node - <<'NODE'
'use strict';
const path = require('node:path');
const { PROJECT_ROOT, getPathConfig } = require('./src/config/floki-config.cjs');
process.stdout.write(path.resolve(PROJECT_ROOT, getPathConfig('chat').chat_runtime_root));
NODE
)" || fail "could not resolve chat runtime path from YAML"
  PID_FILE="$RUNTIME_DIR/chat-local-runtime.pid"
  COMPAT_PID_FILE="$RUNTIME_DIR/chat-mode-loop.pid"
  STATUS_FILE="$RUNTIME_DIR/chat-local-runtime.status.json"
  LOG_FILE="$RUNTIME_DIR/chat-local-runtime.log"
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


runtime_pids_for_project() {
  python3 - "$PROJECT_DIR" <<'INNER_PY'
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()

for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue

    try:
        cmdline = (
            (entry / 'cmdline')
            .read_bytes()
            .replace(b'\0', b' ')
            .decode('utf-8', 'replace')
            .strip()
        )
        cwd = (entry / 'cwd').resolve()
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        continue

    if 'src/runtime/chat-local-runtime.cjs' not in cmdline:
        continue

    if cwd == root or str(root / 'src/runtime/chat-local-runtime.cjs') in cmdline:
        print(entry.name)
INNER_PY
}

stop_runtime_pid() {
  TARGET_PID="$1"
  [ -n "$TARGET_PID" ] || return 0

  kill "$TARGET_PID" >/dev/null 2>&1 || true

  WAIT_COUNT=0
  while kill -0 "$TARGET_PID" >/dev/null 2>&1 && [ "$WAIT_COUNT" -lt 50 ]; do
    sleep 0.1
    WAIT_COUNT=$((WAIT_COUNT + 1))
  done

  if kill -0 "$TARGET_PID" >/dev/null 2>&1; then
    kill -9 "$TARGET_PID" >/dev/null 2>&1 || true
  fi
}

port_in_use() {
  local check_host="$1"
  local check_port="$2"
  node - "$check_host" "$check_port" <<'NODE'
const net = require('net');
const host = process.argv[2];
const port = Number(process.argv[3]);
const client = net.connect({ host, port }, () => {
  console.log('in-use');
  client.destroy();
  process.exit(0);
});
client.on('error', (error) => {
  process.exit(error.code === 'ECONNREFUSED' ? 1 : 2);
});
NODE
}

cd "$PROJECT_DIR" || fail "could not enter project directory"
load_node
case "$(node -v 2>/dev/null)" in v24.*) ;; *) fail "Node 24.x is required" ;; esac
resolve_runtime_paths
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
  runtime_host: live.runtime_host,
  runtime_port: live.runtime_port,
  audio_config_loaded: true
}));
NODE
)" || fail "could not load production audio/live chat settings from YAML"

START_TIMEOUT_MS="$(printf '%s' "$CONFIG_JSON" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(s).runtime_start_timeout_ms)))")" || fail "could not read YAML runtime_start_timeout_ms"
START_POLL_MS="$(printf '%s' "$CONFIG_JSON" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(s).runtime_start_poll_ms)))")" || fail "could not read YAML runtime_start_poll_ms"
RUNTIME_HOST="$(printf '%s' "$CONFIG_JSON" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(s).runtime_host)));")" || fail "could not read YAML runtime_host"
RUNTIME_PORT="$(printf '%s' "$CONFIG_JSON" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(s).runtime_port)));")" || fail "could not read YAML runtime_port"
MAX_POLLS="$(node -e "const timeout=Number(process.argv[1]);const poll=Number(process.argv[2]);if(!Number.isFinite(timeout)||timeout<=0||!Number.isFinite(poll)||poll<=0)process.exit(1);process.stdout.write(String(Math.ceil(timeout/poll)))" "$START_TIMEOUT_MS" "$START_POLL_MS")" || fail "invalid YAML runtime startup timing"
POLL_SECONDS="$(node -e "const poll=Number(process.argv[1]);if(!Number.isFinite(poll)||poll<=0)process.exit(1);process.stdout.write(String(poll/1000))" "$START_POLL_MS")" || fail "invalid YAML runtime startup poll interval"

if [ "${FLOKI_CHAT_SCRIPT_DRY_RUN:-0}" = "1" ]; then
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_START_SCRIPT_PASS\",\"dry_run\":true,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true}"
  exit 0
fi

EXISTING_PID=""
[ -f "$PID_FILE" ] && EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null)"

if runtime_active "$EXISTING_PID"; then
  if [ -f "$STATUS_FILE" ] && node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync(process.argv[1]));process.exit(s.pid===Number(process.argv[2])&&s.api_ready===true&&s.brain_loaded===true?0:1)" "$STATUS_FILE" "$EXISTING_PID" >/dev/null 2>&1; then
    echo "$EXISTING_PID" > "$COMPAT_PID_FILE"
    echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_START_SCRIPT_PASS\",\"already_active\":true,\"pid\":$EXISTING_PID,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true}"
    exit 0
  fi

  stop_runtime_pid "$EXISTING_PID"
fi

for ORPHAN_PID in $(runtime_pids_for_project); do
  if [ "$ORPHAN_PID" != "$$" ]; then
    stop_runtime_pid "$ORPHAN_PID"
  fi
done

if port_in_use "$RUNTIME_HOST" "$RUNTIME_PORT"; then
  fail "runtime port $RUNTIME_HOST:$RUNTIME_PORT is already in use by a process that is not the reusable backend"
fi

STARTUP_LOG_FILE="$RUNTIME_DIR/chat-local-runtime.startup.log"

rm -f \
  "$PID_FILE" \
  "$COMPAT_PID_FILE" \
  "$STATUS_FILE" \
  "$STARTUP_LOG_FILE"

setsid nohup node src/runtime/chat-local-runtime.cjs \
  </dev/null \
  >>"$STARTUP_LOG_FILE" 2>&1 &

STARTED_PID="$!"
disown "$STARTED_PID" >/dev/null 2>&1 || true

echo "$STARTED_PID" > "$PID_FILE"
echo "$STARTED_PID" > "$COMPAT_PID_FILE"

COUNT=0
while [ "$COUNT" -lt "$MAX_POLLS" ]; do
  if ! runtime_active "$STARTED_PID"; then
    tail -n 120 "$STARTUP_LOG_FILE" >&2 || true
    tail -n 80 "$LOG_FILE" >&2 || true
    fail "production chat runtime exited during startup"
  fi
  if [ -f "$STATUS_FILE" ] && node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync(process.argv[1]));process.exit(s.pid===Number(process.argv[2])&&s.api_ready===true&&s.brain_loaded===true?0:1)" "$STATUS_FILE" "$STARTED_PID" >/dev/null 2>&1; then
    echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_START_SCRIPT_PASS\",\"started\":true,\"pid\":$STARTED_PID,\"pid_file\":\"$PID_FILE\",\"status_file\":\"$STATUS_FILE\",\"log_file\":\"$LOG_FILE\",\"chat_mode_only\":true}"
    exit 0
  fi
  sleep "$POLL_SECONDS"
  COUNT=$((COUNT + 1))
done

tail -n 120 "$STARTUP_LOG_FILE" >&2 || true
tail -n 80 "$LOG_FILE" >&2 || true
kill "$STARTED_PID" >/dev/null 2>&1 || true
fail "production chat runtime did not become ready within YAML live_chat.runtime_start_timeout_ms=$START_TIMEOUT_MS"
