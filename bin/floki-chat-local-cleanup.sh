#!/usr/bin/env bash
set -u


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

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$HOME/.nvm/nvm.sh"
  if ! command -v node >/dev/null 2>&1 || ! floki_node_24_or_newer; then
    nvm use 24 >/dev/null 2>&1
  fi
fi

mapfile -t CLEANUP_CONFIG < <(node - <<'NODE'
'use strict';
const path = require('node:path');
const {
  PROJECT_ROOT,
  getPathConfig,
  getVisionConfig,
  getSelfImprovementConfig
} = require('./src/config/floki-config.cjs');
const paths = getPathConfig('chat');
const vision = getVisionConfig('chat');
const rsi = getSelfImprovementConfig('chat');
const resolveProject = (value) => path.isAbsolute(value)
  ? value
  : path.resolve(PROJECT_ROOT, value);
const chatRuntimeRoot = path.resolve(PROJECT_ROOT, paths.chat_runtime_root);
for (const value of [
  chatRuntimeRoot,
  resolveProject(rsi.runtime_root),
  rsi.sandbox_engine,
  rsi.container_name_prefix,
  rsi.persistent_container_name,
  rsi.service_stop_attempts,
  rsi.service_stop_poll_seconds,
  rsi.service_stop_command_timeout_seconds,
  rsi.worker_pid_file_name,
  rsi.run_request_file_name,
  rsi.current_container_file_name,
  resolveProject(rsi.model_proxy_root),
  rsi.model_proxy_socket_name,
  vision.vlm_ssh_tunnel_enabled,
  path.join(chatRuntimeRoot, vision.vlm_ssh_tunnel_socket_name),
  vision.vlm_ssh_tunnel_target,
  Math.ceil(Number(vision.vlm_ssh_tunnel_check_timeout_ms) / 1000)
]) {
  process.stdout.write(String(value) + '\n');
}
NODE
) || exit 1

CHAT_RUNTIME_DIR="${CLEANUP_CONFIG[0]}"
RSI_RUNTIME_DIR="${CLEANUP_CONFIG[1]}"
RSI_SANDBOX_ENGINE="${CLEANUP_CONFIG[2]}"
RSI_CONTAINER_PREFIX="${CLEANUP_CONFIG[3]}"
RSI_PERSISTENT_CONTAINER_NAME="${CLEANUP_CONFIG[4]}"
RSI_STOP_ATTEMPTS="${CLEANUP_CONFIG[5]}"
RSI_STOP_POLL_SECONDS="${CLEANUP_CONFIG[6]}"
RSI_STOP_COMMAND_TIMEOUT_SECONDS="${CLEANUP_CONFIG[7]}"
RSI_WORKER_PID_NAME="${CLEANUP_CONFIG[8]}"
RSI_RUN_REQUEST_NAME="${CLEANUP_CONFIG[9]}"
RSI_CURRENT_CONTAINER_NAME="${CLEANUP_CONFIG[10]}"
RSI_MODEL_PROXY_ROOT="${CLEANUP_CONFIG[11]}"
RSI_MODEL_PROXY_SOCKET_NAME="${CLEANUP_CONFIG[12]}"
VISION_SSH_TUNNEL_ENABLED="${CLEANUP_CONFIG[13]}"
VISION_SSH_TUNNEL_SOCKET="${CLEANUP_CONFIG[14]}"
VISION_SSH_TUNNEL_TARGET="${CLEANUP_CONFIG[15]}"
VISION_SSH_TUNNEL_TIMEOUT_SECONDS="${CLEANUP_CONFIG[16]}"

# FLOKI_CHAT_LOCAL_CLEANUP_OWNERSHIP_GATE_BEGIN
CHAT_LOCAL_SUPERVISOR_SESSION_FILE="${FLOKI_CHAT_LOCAL_SESSION_FILE:-$CHAT_RUNTIME_DIR/chat-local-supervisor-session.json}"
CHAT_LOCAL_REQUESTED_SESSION_ID="${FLOKI_CHAT_LOCAL_SESSION_ID:-}"

CLEANUP_AUTH_OUTPUT="$(
  node src/runtime/chat-local-supervisor-lease.cjs     authorize-cleanup     "$CHAT_LOCAL_SUPERVISOR_SESSION_FILE"     "$CHAT_LOCAL_REQUESTED_SESSION_ID"     2>&1
)"
CLEANUP_AUTH_STATUS="$?"

if [ "$CLEANUP_AUTH_STATUS" -eq 3 ]; then
  printf '%s
' "$CLEANUP_AUTH_OUTPUT"
  echo "FLOKI_V2_CHAT_LOCAL_CLEANUP_SKIPPED ownership_guard=true"
  exit 0
fi

if [ "$CLEANUP_AUTH_STATUS" -ne 0 ]; then
  printf '%s
' "$CLEANUP_AUTH_OUTPUT" >&2
  echo "FLOKI_V2_CHAT_LOCAL_CLEANUP_FAIL: cleanup ownership authorization failed" >&2
  exit "$CLEANUP_AUTH_STATUS"
fi
# FLOKI_CHAT_LOCAL_CLEANUP_OWNERSHIP_GATE_END

timeout "${RSI_STOP_COMMAND_TIMEOUT_SECONDS}s" bash bin/floki-self-improvement-stop.sh >/dev/null 2>&1 || true
timeout "${RSI_STOP_COMMAND_TIMEOUT_SECONDS}s" bash bin/floki-chat-stop.sh >/dev/null 2>&1 || true
timeout "${RSI_STOP_COMMAND_TIMEOUT_SECONDS}s" bash bin/floki-chat-vision-stop.sh >/dev/null 2>&1 || true
timeout "${RSI_STOP_COMMAND_TIMEOUT_SECONDS}s" bash bin/floki-sleep-scheduler-stop.sh >/dev/null 2>&1 || true

if [ "$VISION_SSH_TUNNEL_ENABLED" = "true" ] &&
   [ -S "$VISION_SSH_TUNNEL_SOCKET" ] &&
   command -v ssh >/dev/null 2>&1; then
  timeout "${VISION_SSH_TUNNEL_TIMEOUT_SECONDS}s" \
    ssh -S "$VISION_SSH_TUNNEL_SOCKET" -O exit "$VISION_SSH_TUNNEL_TARGET" \
    >/dev/null 2>&1 || true
fi

if command -v "$RSI_SANDBOX_ENGINE" >/dev/null 2>&1; then
  mapfile -t RSI_CONTAINERS < <(
    "$RSI_SANDBOX_ENGINE" ps -a --format '{{.Names}}' 2>/dev/null |
      awk -v prefix="$RSI_CONTAINER_PREFIX" 'index($0, prefix) == 1'
  )
  if [ "${#RSI_CONTAINERS[@]}" -gt 0 ]; then
    for RSI_CONTAINER in "${RSI_CONTAINERS[@]}"; do
      if [ "$RSI_CONTAINER" = "$RSI_PERSISTENT_CONTAINER_NAME" ]; then
        "$RSI_SANDBOX_ENGINE" stop \
          -t "$RSI_STOP_COMMAND_TIMEOUT_SECONDS" \
          "$RSI_CONTAINER" >/dev/null 2>&1 || true
      else
        # Remove only legacy per-run containers. The named Ubuntu sandbox is
        # stopped above and its writable root filesystem is preserved.
        "$RSI_SANDBOX_ENGINE" rm -f "$RSI_CONTAINER" \
          >/dev/null 2>&1 || true
      fi
    done
  fi
fi

node src/runtime/chat-local-cleanup-ownership.cjs \
  "$ROOT" \
  "$RSI_STOP_ATTEMPTS" \
  "$RSI_STOP_POLL_SECONDS" \
  "$VISION_SSH_TUNNEL_SOCKET" \
  "$VISION_SSH_TUNNEL_TARGET"

STATUS="$?"

node - \
  "$CHAT_RUNTIME_DIR/chat-webcam-vision.pid" \
  "$CHAT_RUNTIME_DIR/sleep-cycle-scheduler.pid" \
  "$CHAT_RUNTIME_DIR/chat-local-runtime.pid" \
  "$CHAT_RUNTIME_DIR/chat-mode-loop.pid" \
  "$CHAT_RUNTIME_DIR/chat-mode-loop.stop" \
  "$CHAT_RUNTIME_DIR/chat-webcam-vision.refresh-request.json" \
  "$CHAT_RUNTIME_DIR/chat-vision-ssh-tunnel.sock" \
  "$RSI_RUNTIME_DIR/$RSI_WORKER_PID_NAME" \
  "$RSI_RUNTIME_DIR/$RSI_RUN_REQUEST_NAME" \
  "$RSI_RUNTIME_DIR/$RSI_CURRENT_CONTAINER_NAME" \
  "$RSI_RUNTIME_DIR/$RSI_CURRENT_CONTAINER_NAME.stop.lock" \
  "$RSI_MODEL_PROXY_ROOT/$RSI_MODEL_PROXY_SOCKET_NAME" <<'NODE'
'use strict';
const {
  removeStaleRuntimeFiles
} = require('./src/runtime/chat-local-cleanup-ownership.cjs');

removeStaleRuntimeFiles(process.argv.slice(2));
NODE

if [ "$STATUS" -ne 0 ]; then
  echo "FLOKI_V2_CHAT_LOCAL_CLEANUP_FAIL: surviving Floki processes remain" >&2
  exit "$STATUS"
fi

RELEASE_OUTPUT="$(
  node src/runtime/chat-local-supervisor-lease.cjs     release     "$CHAT_LOCAL_SUPERVISOR_SESSION_FILE"     "$CHAT_LOCAL_REQUESTED_SESSION_ID"     2>&1
)"
RELEASE_STATUS="$?"
if [ "$RELEASE_STATUS" -ne 0 ]; then
  printf '%s
' "$RELEASE_OUTPUT" >&2
  echo "FLOKI_V2_CHAT_LOCAL_CLEANUP_FAIL: supervisor session release failed" >&2
  exit "$RELEASE_STATUS"
fi

echo "FLOKI_V2_CHAT_LOCAL_CLEANUP_PASS ollama_preserved=true"
