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
LOCAL_VISION_SOCKET_MARKER="chat-vision-local.sock"
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

project_process_control() {
  local mode="${1:-verify}"
  python3 - "$ROOT" "$RUNTIME_ROOT" "$APP_PID_FILE" "$mode" <<'PYPROC'
import json
import os
import signal
import sys
import time
from pathlib import Path

root = Path(sys.argv[1]).resolve()
runtime_root = Path(sys.argv[2]).resolve()
app_pid_file = Path(sys.argv[3]).resolve()
mode = sys.argv[4]
app_dir = (root / "apps" / "floki-neural-interface").resolve()
own_pid = os.getpid()
own_pgid = os.getpgrp()

ALL_MARKERS = (
    "src/runtime/chat-local-runtime.cjs",
    "src/self-improvement/worker.cjs",
    "src/chat/sleep-cycle-scheduler.cjs",
    "src/vision/chat-webcam-vision-service.cjs",
    "yolo-worker.py",
    "grounding-dino-worker.py",
    "floki-chat-local-start.sh",
    "floki-app.sh",
    "floki-neural-interface",
)
APP_MARKERS = (
    "floki-chat-local-start.sh",
    "floki-app.sh",
    "floki-neural-interface",
)


def safe_resolve(value):
    try:
        return Path(value).resolve()
    except Exception:
        return None


def under(candidate, parent):
    if candidate is None:
        return False
    try:
        candidate.relative_to(parent)
        return True
    except Exception:
        return False


def read_record(pid):
    proc = Path('/proc') / str(pid)
    try:
        raw = (proc / 'stat').read_text(encoding='utf-8', errors='replace')
        close = raw.rfind(')')
        fields = raw[close + 2:].split()
        cmdline = (proc / 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf-8', 'replace').strip()
        comm = (proc / 'comm').read_text(encoding='utf-8', errors='replace').strip()
        try:
            cwd = safe_resolve(os.readlink(proc / 'cwd'))
        except Exception:
            cwd = None
        try:
            exe = safe_resolve(os.readlink(proc / 'exe'))
        except Exception:
            exe = None
        return {
            'pid': int(pid),
            'state': fields[0],
            'ppid': int(fields[1]),
            'pgid': int(fields[2]),
            'cmdline': cmdline,
            'comm': comm,
            'cwd': cwd,
            'exe': exe,
        }
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError, ValueError):
        return None


def snapshot():
    records = {}
    try:
        entries = list(Path('/proc').iterdir())
    except Exception:
        entries = []
    for entry in entries:
        if not entry.name.isdigit():
            continue
        record = read_record(int(entry.name))
        if record is not None:
            records[record['pid']] = record
    return records


def protected_pids(records):
    protected = {1, own_pid, os.getppid()}
    cursor = os.getppid()
    while cursor > 1:
        record = records.get(cursor) or read_record(cursor)
        if record is None:
            break
        cursor = record['ppid']
        protected.add(cursor)
    return protected


def pid_file_values():
    values = set()
    candidates = [app_pid_file]
    try:
        candidates.extend(runtime_root.rglob('*.pid'))
    except Exception:
        pass
    for path in candidates:
        try:
            value = int(''.join(ch for ch in path.read_text() if ch.isdigit()))
            if value > 1:
                values.add(value)
        except Exception:
            pass
    return values


def camera_devices(pid):
    devices = []
    try:
        entries = list((Path('/proc') / str(pid) / 'fd').iterdir())
    except Exception:
        return devices
    for fd in entries:
        try:
            target = os.readlink(fd)
        except Exception:
            continue
        if target.startswith('/dev/video'):
            devices.append(target)
    return sorted(set(devices))


def app_owned(record):
    lower = record['cmdline'].lower()
    exe = record['exe'].name.lower() if record['exe'] else ''
    if any(marker in lower for marker in APP_MARKERS):
        return True
    return under(record['cwd'], app_dir) and (
        exe == 'electron' or record['comm'].lower() == 'electron' or 'electron .' in lower
    )


def floki_owned(record, pids):
    lower = record['cmdline'].lower()
    root_text = str(root).lower()
    exe = record['exe'].name.lower() if record['exe'] else ''
    in_root = under(record['cwd'], root)

    if app_owned(record):
        return True
    if record['pid'] in pids and (in_root or root_text in lower):
        return True
    if any(marker in lower for marker in ALL_MARKERS):
        if in_root or root_text in lower:
            return True
    if in_root and record['comm'].lower() == 'mainthread':
        return True
    if in_root and exe == 'ffmpeg' and ('/dev/video' in lower or camera_devices(record['pid'])):
        return True
    if in_root and exe in {'python', 'python3'} and any(
        marker in lower for marker in ('multiprocessing', 'yolo', 'dino', 'vision')
    ):
        return True
    if camera_devices(record['pid']) and (in_root or root_text in lower):
        return True
    return False


def discover(records, app_only=False):
    known_pids = pid_file_values()
    targets = set()
    for pid, record in records.items():
        if record['state'] == 'Z':
            continue
        if app_only:
            if app_owned(record):
                targets.add(pid)
        elif floki_owned(record, known_pids):
            targets.add(pid)

    changed = True
    while changed:
        changed = False
        for pid, record in records.items():
            if record['state'] == 'Z' or pid in targets:
                continue
            if record['ppid'] in targets:
                targets.add(pid)
                changed = True
    return targets


def describe(records, pids):
    rows = []
    for pid in sorted(pids):
        record = records.get(pid) or read_record(pid)
        if record is None or record['state'] == 'Z':
            continue
        rows.append({
            'pid': pid,
            'ppid': record['ppid'],
            'pgid': record['pgid'],
            'comm': record['comm'],
            'cwd': str(record['cwd']) if record['cwd'] else None,
            'cmdline': record['cmdline'][:500],
            'camera_devices': camera_devices(pid),
        })
    return rows


def send_signal(records, targets, sig):
    protected = protected_pids(records)
    members_by_group = {}
    for pid, record in records.items():
        members_by_group.setdefault(record['pgid'], set()).add(pid)

    handled = set()
    groups = {records[pid]['pgid'] for pid in targets if pid in records}
    for pgid in sorted(groups):
        if pgid <= 1 or pgid == own_pgid:
            continue
        members = members_by_group.get(pgid, set())
        if members & protected:
            continue
        try:
            os.killpg(pgid, sig)
            handled.update(members & targets)
        except (ProcessLookupError, PermissionError):
            pass

    for pid in sorted(targets - handled):
        if pid <= 1 or pid in protected:
            continue
        try:
            os.kill(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass


def wait_remaining(app_only, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        records = snapshot()
        remaining = discover(records, app_only=app_only)
        if not remaining:
            return records, remaining
        time.sleep(0.25)
    records = snapshot()
    return records, discover(records, app_only=app_only)


def all_camera_holders(records):
    rows = []
    for pid, record in records.items():
        if record['state'] == 'Z':
            continue
        devices = camera_devices(pid)
        if devices:
            rows.append({
                'pid': pid,
                'comm': record['comm'],
                'cwd': str(record['cwd']) if record['cwd'] else None,
                'cmdline': record['cmdline'][:500],
                'devices': devices,
            })
    return rows


if mode not in {'app', 'all', 'verify'}:
    raise SystemExit('invalid process control mode: ' + mode)

records = snapshot()
app_only = mode == 'app'
targets = discover(records, app_only=app_only)

if mode in {'app', 'all'} and targets:
    send_signal(records, targets, signal.SIGTERM)
    records, remaining = wait_remaining(app_only, 10.0)
    if remaining:
        send_signal(records, remaining, signal.SIGKILL)
        records, remaining = wait_remaining(app_only, 5.0)
    if remaining:
        print(json.dumps({
            'ok': False,
            'marker': 'FLOKI_RUNTIME_PROCESS_STOP_FAIL',
            'mode': mode,
            'remaining': describe(records, remaining),
        }, indent=2))
        raise SystemExit(1)

if mode == 'app':
    try:
        app_pid_file.unlink()
    except FileNotFoundError:
        pass
    print(json.dumps({
        'ok': True,
        'marker': 'FLOKI_RUNTIME_APP_PROCESS_STOP_PASS',
        'stopped_count': len(targets),
    }))
    raise SystemExit(0)

records = snapshot()
remaining = discover(records, app_only=False)
camera_holders = all_camera_holders(records)
tunnel_sockets = []

if mode == 'all':
    print(json.dumps({
        'ok': not remaining,
        'marker': 'FLOKI_RUNTIME_PROJECT_PROCESS_STOP_PASS' if not remaining else 'FLOKI_RUNTIME_PROJECT_PROCESS_STOP_FAIL',
        'stopped_count': len(targets),
        'remaining': describe(records, remaining),
    }, indent=2))
    raise SystemExit(0 if not remaining else 1)

# verify mode: quiescence must hold across consecutive snapshots so a
# process that is mid-exec (empty cmdline, camera not yet opened) during a
# single snapshot cannot slip through and respawn after PASS prints.
def verify_snapshot():
    records = snapshot()
    remaining = discover(records, app_only=False)
    known_pids = pid_file_values()
    holders = [
        row for row in all_camera_holders(records)
        if row['pid'] in remaining or floki_owned(records[row['pid']], known_pids)
    ]
    local_vision_processes = []
    electron_procs = describe(records, {
        pid for pid in remaining if pid in records and app_owned(records[pid])
    })
    local_vision_sockets = []
    quiescent = not remaining and not holders
    return {
        'quiescent': quiescent,
        'records': records,
        'remaining': remaining,
        'camera_holders': holders,
        'local_vision_processes': local_vision_processes,
        'electron_processes': electron_procs,
        'local_vision_sockets': local_vision_sockets,
    }


deadline = time.monotonic() + 20.0
stable = 0
result = verify_snapshot()
while True:
    if result['quiescent']:
        stable += 1
        if stable >= 2:
            break
        time.sleep(0.75)
    else:
        stable = 0
        if time.monotonic() >= deadline:
            break
        time.sleep(0.75)
    result = verify_snapshot()

payload = {
    'ok': result['quiescent'] and stable >= 2,
    'marker': 'FLOKI_RUNTIME_SHUTDOWN_QUIESCENCE_PASS' if result['quiescent'] and stable >= 2 else 'FLOKI_RUNTIME_SHUTDOWN_QUIESCENCE_FAIL',
    'residual_process_count': len(result['remaining']),
    'remaining_floki_processes': describe(result['records'], result['remaining']),
    'camera_holders': result['camera_holders'],
    'local_vision_processes': result['local_vision_processes'],
    'electron_processes': result['electron_processes'],
    'local_vision_sockets': result['local_vision_sockets'],
}
print(json.dumps(payload, indent=2))
raise SystemExit(0 if payload['ok'] else 1)
PYPROC
}

stop_app() {
  project_process_control app
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
  project_process_control all
}

verify_shutdown_quiescence() {
  project_process_control verify
}

# Stop-path helper runner: failures are recorded, not fatal, because the
# post-stop quiescence verifier is the single authority on success. A helper
# that fails while quiescence still verifies must not abort the stop.
STOP_HELPER_FAILURES=()
run_stop_helper() {
  local helper="$1"
  shift
  if [ -x "$ROOT/bin/$helper" ]; then
    if ! bash "$ROOT/bin/$helper" "$@"; then
      STOP_HELPER_FAILURES+=("$helper")
    fi
  fi
}

post_stop_report() {
  local containers="none"
  if command -v "$SANDBOX_ENGINE" >/dev/null 2>&1; then
    containers="$("$SANDBOX_ENGINE" ps --format '{{.Names}}' 2>/dev/null | grep -E "^(${TRAINING_PREFIX}|${REM_PREFIX})-" | paste -sd, - || true)"
    [ -n "$containers" ] || containers="none"
  fi
  printf 'FLOKI_RUNTIME_POST_STOP_VERIFICATION runtime_containers=%s local_vision_only=true omen_web_only=true
' \
    "$containers"
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
    bash "$ROOT/bin/floki-hf-cognition-service.sh" start || fail "HF cognition service did not become warm"
    run_helper_if_present "floki-chat-vision-start.sh"
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
    stop_app || STOP_HELPER_FAILURES+=("stop_app")
    # The chat runtime must die before the vision stop: while alive, its
    # lifecycle reconciler respawns the detached vision daemon and re-opens
    # the SSH tunnel immediately after a vision-only stop.
    run_stop_helper "floki-chat-stop.sh"
    run_stop_helper "floki-self-improvement-stop.sh"
    run_stop_helper "floki-sleep-scheduler-stop.sh"
    bash "$ROOT/bin/floki-hf-cognition-service.sh" stop || true
    run_stop_helper "floki-chat-vision-stop.sh"
    stop_managed_units
    stop_project_processes || STOP_HELPER_FAILURES+=("stop_project_processes")
    rm -f \
      "$RUNTIME_ROOT/chat-local-supervisor-session.json" \
      "$RUNTIME_ROOT/chat-local-supervisor.lock"
    stop_configured_model_containers
    if ! unload_configured_models; then
      printf '%s\n' "FLOKI_RUNTIME_STOP_FAIL" "runtime_stopped=false" "reason=ollama_models_still_loaded"
      exit 1
    fi
    if ! release_gpu_owner; then
      printf '%s\n' "FLOKI_RUNTIME_STOP_FAIL" "runtime_stopped=false" "reason=gpu_owner_release_failed"
      exit 1
    fi
    if ! verify_shutdown_quiescence; then
      printf '%s\n' "FLOKI_RUNTIME_STOP_FAIL" "runtime_stopped=false" "reason=residual_floki_resources_detected"
      exit 1
    fi
    if runtime_ready; then
      printf '%s\n' "FLOKI_RUNTIME_STOP_FAIL" "runtime_stopped=false" "reason=runtime_http_still_reachable"
      exit 1
    fi
    if [ "${#STOP_HELPER_FAILURES[@]}" -gt 0 ]; then
      printf 'FLOKI_RUNTIME_STOP_HELPER_WARNINGS: %s\n' "${STOP_HELPER_FAILURES[*]}"
    fi
    post_stop_report
    printf '%s\n' "FLOKI_RUNTIME_STOP_PASS" "runtime_stopped=true" "hf_containers_stopped=true" "ollama_models_unloaded=true" "gpu_owner_released=true"
    ;;
  restart|reset)
    "$0" stop
    "$0" start
    if [ "$ACTION" = "reset" ]; then
      printf '%s\n' \
        "FLOKI_RUNTIME_RESET_PASS" \
        "runtime_reset=true" \
        "runtime_authority=bin/floki-runtime.sh" \
        "local_app_command=bin/floki-app.sh"
    else
      printf '%s\n' \
        "FLOKI_RUNTIME_RESTART_PASS" \
        "runtime_restarted=true" \
        "runtime_authority=bin/floki-runtime.sh"
    fi
    ;;
  status)
    print_status
    ;;
  *)
    fail "usage: floki-runtime.sh start|stop|reset|restart|status"
    ;;
esac
