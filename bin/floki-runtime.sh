#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_RUN="$ROOT/bin/floki-node24-run.sh"
ACTION="${1:-status}"
shift || true

fail() {
  printf 'FLOKI_RUNTIME_COMMAND_ERROR: %s\n' "$1" >&2
  exit 1
}

[ -x "$NODE_RUN" ] || fail "Node 24 runner is missing: $NODE_RUN"
cd "$ROOT"

mapfile -t CONFIG_VALUES < <(
  bash "$NODE_RUN" node <<'NODE'
'use strict';
const path = require('node:path');
const {
  PROJECT_ROOT,
  getLiveChatConfig,
  getPathConfig
} = require('./src/config/floki-config.cjs');
const {
  loadSelfImprovementConfig
} = require('./src/self-improvement/config.cjs');
const live = getLiveChatConfig('chat');
const paths = getPathConfig('chat');
const self = loadSelfImprovementConfig();
const required = {
  runtime_host: live.runtime_host,
  runtime_port: live.runtime_port,
  runtime_start_timeout_ms: live.runtime_start_timeout_ms,
  runtime_start_poll_ms: live.runtime_start_poll_ms,
  chat_runtime_root: paths.chat_runtime_root,
  sandbox_engine: self.sandbox_engine,
  training_container_name_prefix: self.training_container_name_prefix,
  hf_rem_container_name_prefix: self.hf_rem_container_name_prefix,
  nightly_training_container_stop_timeout_seconds:
    self.nightly_training_container_stop_timeout_seconds
};
for (const [key, value] of Object.entries(required)) {
  if (value === undefined || value === null || value === '') {
    throw new Error('missing required YAML setting: ' + key);
  }
}
process.stdout.write([
  path.resolve(PROJECT_ROOT, paths.chat_runtime_root),
  'http://' + live.runtime_host + ':' + String(live.runtime_port) + '/status',
  String(live.runtime_start_timeout_ms),
  String(live.runtime_start_poll_ms),
  String(self.sandbox_engine),
  String(self.training_container_name_prefix),
  String(self.hf_rem_container_name_prefix),
  String(self.nightly_training_container_stop_timeout_seconds)
].join('\n'));
NODE
) || fail "could not resolve runtime settings from YAML"

[ "${#CONFIG_VALUES[@]}" -eq 8 ] || fail "runtime settings were incomplete"
RUNTIME_ROOT="${CONFIG_VALUES[0]}"
STATUS_URL="${CONFIG_VALUES[1]}"
START_TIMEOUT_MS="${CONFIG_VALUES[2]}"
START_POLL_MS="${CONFIG_VALUES[3]}"
SANDBOX_ENGINE="${CONFIG_VALUES[4]}"
TRAINING_PREFIX="${CONFIG_VALUES[5]}"
REM_PREFIX="${CONFIG_VALUES[6]}"
CONTAINER_STOP_SECONDS="${CONFIG_VALUES[7]}"
APP_PID_FILE="$RUNTIME_ROOT/floki-app.pid"
mkdir -p "$RUNTIME_ROOT"

runtime_ready() {
  bash "$NODE_RUN" node - "$STATUS_URL" <<'NODE' >/dev/null 2>&1
'use strict';
fetch(process.argv[2], { signal: AbortSignal.timeout(5000) })
  .then((response) => {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  })
  .then((status) => {
    if (status.api_ready !== true || status.brain_loaded !== true) {
      throw new Error('runtime not ready');
    }
  })
  .catch(() => process.exit(1));
NODE
}

wait_for_runtime() {
  local elapsed=0
  local poll_seconds
  poll_seconds="$(
    bash "$NODE_RUN" node -e \
      'process.stdout.write(String(Number(process.argv[1]) / 1000))' \
      "$START_POLL_MS"
  )"
  while [ "$elapsed" -lt "$START_TIMEOUT_MS" ]; do
    if runtime_ready; then return 0; fi
    sleep "$poll_seconds"
    elapsed=$((elapsed + START_POLL_MS))
  done
  return 1
}

managed_user_units() {
  command -v systemctl >/dev/null 2>&1 || return 0
  while read -r unit _rest; do
    [ -n "$unit" ] || continue
    case "$unit" in *.service) ;; *) continue ;; esac
    body="$(systemctl --user cat "$unit" 2>/dev/null || true)"
    [ -n "$body" ] || continue
    printf '%s\n' "$body" | grep -Fq "$ROOT" || continue
    if printf '%s\n' "$body" | grep -Eq \
      'src/runtime/chat-local-runtime\.cjs|src/self-improvement/worker\.cjs|src/chat/sleep-cycle-scheduler\.cjs'
    then
      printf '%s\n' "$unit"
    fi
  done < <(
    systemctl --user list-unit-files --type=service --no-legend 2>/dev/null || true
  )
}

runtime_user_units() {
  while read -r unit; do
    [ -n "$unit" ] || continue
    body="$(systemctl --user cat "$unit" 2>/dev/null || true)"
    if printf '%s\n' "$body" | grep -q 'src/runtime/chat-local-runtime\.cjs'; then
      printf '%s\n' "$unit"
    fi
  done < <(managed_user_units)
}

run_helper_if_present() {
  local helper="$1"
  shift
  if [ -x "$ROOT/bin/$helper" ]; then
    bash "$ROOT/bin/$helper" "$@"
  fi
}

start_runtime_owner() {
  mapfile -t units < <(runtime_user_units)
  if [ "${#units[@]}" -gt 1 ]; then
    fail "multiple services own the runtime: ${units[*]}"
  fi
  if [ "${#units[@]}" -eq 1 ]; then
    systemctl --user start "${units[0]}" || fail "could not start runtime service ${units[0]}"
    return 0
  fi
  run_helper_if_present "floki-chat-start.sh"
}

stop_app() {
  [ -f "$APP_PID_FILE" ] || return 0
  local pid
  pid="$(tr -cd '0-9' < "$APP_PID_FILE")"
  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    kill -TERM -- "-$pid" >/dev/null 2>&1 || kill -TERM "$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do
      kill -0 "$pid" >/dev/null 2>&1 || break
      sleep 0.25
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -KILL -- "-$pid" >/dev/null 2>&1 || kill -KILL "$pid" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$APP_PID_FILE"
}

stop_managed_units() {
  command -v systemctl >/dev/null 2>&1 || return 0
  mapfile -t units < <(managed_user_units)
  for unit in "${units[@]}"; do systemctl --user stop "$unit" || true; done
}

stop_configured_model_containers() {
  command -v "$SANDBOX_ENGINE" >/dev/null 2>&1 || return 0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    case "$name" in
      "$TRAINING_PREFIX"-*|"$REM_PREFIX"-*)
        "$SANDBOX_ENGINE" stop --time "$CONTAINER_STOP_SECONDS" "$name" >/dev/null 2>&1 || true
        "$SANDBOX_ENGINE" rm -f "$name" >/dev/null 2>&1 || true
        ;;
    esac
  done < <("$SANDBOX_ENGINE" ps -a --format '{{.Names}}' 2>/dev/null || true)
}

unload_configured_models() {
  bash "$NODE_RUN" node <<'NODE'
'use strict';
const { loadSelfImprovementConfig } = require('./src/self-improvement/config.cjs');
const {
  unloadAllLoaded,
  waitForNoLoadedModels
} = require('./src/self-improvement/training/ollama-control.cjs');
(async () => {
  const config = loadSelfImprovementConfig();
  const unload = await unloadAllLoaded({}, config);
  if (!unload || unload.ok !== true) {
    throw new Error('configured Ollama unload failed: ' + JSON.stringify(unload));
  }
  const settled = await waitForNoLoadedModels({}, config);
  if (!settled.ok) {
    throw new Error(
      'configured Ollama models remain loaded after settlement deadline: ' +
      JSON.stringify(settled.remaining)
    );
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    marker: 'FLOKI_RUNTIME_MODELS_UNLOADED',
    remaining: [],
    verification_attempts: settled.attempts
  }) + '\n');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
NODE
}

release_gpu_owner() {
  bash "$NODE_RUN" node <<'NODE'
'use strict';
const { loadSelfImprovementConfig } = require('./src/self-improvement/config.cjs');
const gpu = require('./src/self-improvement/training/gpu-ownership.cjs');
const config = loadSelfImprovementConfig();
const owner = gpu.currentOwner(config);
if (owner !== null) gpu.release(owner, config);
process.stdout.write(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RUNTIME_GPU_OWNER_RELEASED',
  previous_owner: owner
}) + '\n');
NODE
}

stop_project_processes() {
  python3 - "$ROOT" <<'PY'
import os
import signal
import sys
import time
from pathlib import Path
root = Path(sys.argv[1]).resolve()
markers = (
    "src/runtime/chat-local-runtime.cjs",
    "src/self-improvement/worker.cjs",
    "src/chat/sleep-cycle-scheduler.cjs",
)
targets = []
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit():
        continue
    try:
        cmdline = ((proc / 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf-8', 'replace'))
        cwd = (proc / 'cwd').resolve()
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        continue
    if not any(marker in cmdline for marker in markers):
        continue
    if cwd != root and str(root) not in cmdline:
        continue
    pid = int(proc.name)
    if pid in {os.getpid(), os.getppid()}:
        continue
    targets.append(pid)
for pid in targets:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    alive = []
    for pid in targets:
        try:
            os.kill(pid, 0)
            alive.append(pid)
        except ProcessLookupError:
            pass
    if not alive:
        break
    time.sleep(0.25)
for pid in targets:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        continue
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
PY
}

print_status() {
  bash "$NODE_RUN" node - "$STATUS_URL" <<'NODE'
'use strict';
fetch(process.argv[2], { signal: AbortSignal.timeout(3000) })
  .then(async (response) => {
    const payload = await response.json();
    process.stdout.write(JSON.stringify({
      ok: response.ok,
      runtime_reachable: true,
      pid: payload.pid || null,
      api_ready: payload.api_ready === true,
      brain_loaded: payload.brain_loaded === true,
      websocket_clients: payload.websocket_clients || 0,
      state: payload.state || null
    }, null, 2) + '\n');
  })
  .catch(() => {
    process.stdout.write(JSON.stringify({
      ok: true,
      runtime_reachable: false,
      api_ready: false,
      brain_loaded: false
    }, null, 2) + '\n');
  });
NODE
}

case "$ACTION" in
  start)
    if [ "${FLOKI_COMMANDS_DRY_RUN:-0}" = "1" ]; then
      printf '%s\n' "FLOKI_RUNTIME_START_DRY_RUN" "status_url=$STATUS_URL" "settings_source=config/chat.config.yaml"
      exit 0
    fi
    if ! runtime_ready; then
      start_runtime_owner
      wait_for_runtime || fail "runtime did not become ready within the configured timeout"
    fi
    run_helper_if_present "floki-sleep-scheduler-start.sh"
    run_helper_if_present "floki-self-improvement-start.sh"
    runtime_ready || fail "runtime is not ready after startup"
    printf '%s\n' "FLOKI_RUNTIME_START_PASS" "background_runtime=true" "shared_clients=electron|website|mobile" "settings_source=config/chat.config.yaml"
    ;;
  stop)
    if [ "${FLOKI_COMMANDS_DRY_RUN:-0}" = "1" ]; then
      printf '%s\n' "FLOKI_RUNTIME_STOP_DRY_RUN" "models_included=true" "settings_source=config/chat.config.yaml"
      exit 0
    fi
    stop_app
    run_helper_if_present "floki-self-improvement-stop.sh"
    run_helper_if_present "floki-sleep-scheduler-stop.sh"
    run_helper_if_present "floki-chat-vision-stop.sh"
    stop_managed_units
    run_helper_if_present "floki-chat-stop.sh"
    stop_project_processes
    stop_configured_model_containers
    unload_configured_models
    release_gpu_owner
    if runtime_ready; then fail "runtime remained reachable after full shutdown"; fi
    printf '%s\n' "FLOKI_RUNTIME_STOP_PASS" "runtime_stopped=true" "hf_containers_stopped=true" "ollama_models_unloaded=true" "gpu_owner_released=true"
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    print_status
    ;;
  *)
    fail "usage: floki-runtime.sh start|stop|restart|status"
    ;;
esac
