#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_RUN="$ROOT/bin/floki-node24-run.sh"
RUNTIME_SERVICE="floki-chat-local-runtime.service"
TUNNEL_SERVICE="floki-omen-reverse-tunnel.service"
STATUS_URL=""
START_TIMEOUT_MS=""
START_POLL_MS=""

fail() {
  echo "FLOKI_RUNTIME_BACKGROUND_START_FAIL: $1" >&2
  exit 1
}

load_node_24() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1090
    . "$HOME/.nvm/nvm.sh"
    if ! command -v node >/dev/null 2>&1 ||
       ! node -v 2>/dev/null | grep -Eq '^v24\.'; then
      nvm use 24 >/dev/null 2>&1
    fi
  fi

  command -v node >/dev/null 2>&1 ||
    fail "Node was not found on PATH"

  case "$(node -v 2>/dev/null)" in
    v24.*) ;;
    *) fail "Node 24.x is required" ;;
  esac
}

resolve_runtime_settings() {
  mapfile -t VALUES < <(
    bash "$NODE_RUN" node - <<'NODE'
'use strict';
const {
  getLiveChatConfig
} = require('./src/config/floki-config.cjs');

const live = getLiveChatConfig('chat');

process.stdout.write([
  'http://' + live.runtime_host + ':' +
    String(live.runtime_port) + '/status',
  String(live.runtime_start_timeout_ms),
  String(live.runtime_start_poll_ms)
].join('\n'));
NODE
  ) || fail "could not resolve runtime settings from chat YAML"

  [ "${#VALUES[@]}" -eq 3 ] ||
    fail "runtime settings were incomplete"

  STATUS_URL="${VALUES[0]}"
  START_TIMEOUT_MS="${VALUES[1]}"
  START_POLL_MS="${VALUES[2]}"
}

runtime_ready() {
  bash "$NODE_RUN" node - "$STATUS_URL" <<'NODE'
'use strict';
const url = process.argv[2];

fetch(url, {
  signal: AbortSignal.timeout(3000)
}).then((response) => {
  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }
  return response.json();
}).then((status) => {
  const ready =
    status.api_ready === true &&
    status.brain_loaded === true &&
    status.websocket_ready === true;
  process.exit(ready ? 0 : 1);
}).catch(() => process.exit(1));
NODE
}

wait_for_runtime() {
  local max_polls
  local poll_seconds

  max_polls="$(
    bash "$NODE_RUN" node -e '
      const timeout = Number(process.argv[1]);
      const poll = Number(process.argv[2]);
      if (!Number.isFinite(timeout) ||
          !Number.isFinite(poll) ||
          timeout <= 0 ||
          poll <= 0) {
        process.exit(1);
      }
      process.stdout.write(
        String(Math.ceil(timeout / poll))
      );
    ' "$START_TIMEOUT_MS" "$START_POLL_MS"
  )" || fail "invalid YAML runtime startup timing"

  poll_seconds="$(
    bash "$NODE_RUN" node -e '
      const poll = Number(process.argv[1]);
      process.stdout.write(String(poll / 1000));
    ' "$START_POLL_MS"
  )" || fail "invalid YAML runtime poll interval"

  for _ in $(seq 1 "$max_polls"); do
    runtime_ready && return 0

    if systemctl --user is-failed --quiet \
      "$RUNTIME_SERVICE"
    then
      return 1
    fi

    sleep "$poll_seconds"
  done

  return 1
}

unit_exists() {
  systemctl --user list-unit-files \
    --type=service --no-legend "$1" 2>/dev/null |
    awk '{print $1}' |
    grep -Fxq "$1"
}

project_runtime_count() {
  python3 - "$ROOT" <<'PY'
import os
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
count = 0

for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    try:
        cwd = Path(os.readlink(entry / 'cwd')).resolve()
        cmd = (
            (entry / 'cmdline')
            .read_bytes()
            .replace(b'\0', b' ')
            .decode('utf-8', 'replace')
        )
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        continue

    if cwd == root and \
       'src/runtime/chat-local-runtime.cjs' in cmd:
        count += 1

print(count)
PY
}

cd "$ROOT" || fail "could not enter Floki-v2"
load_node_24
resolve_runtime_settings

RUNTIME_WAS_READY=false

if runtime_ready; then
  RUNTIME_WAS_READY=true
else
  unit_exists "$RUNTIME_SERVICE" ||
    fail "$RUNTIME_SERVICE is not installed"

  systemctl --user start "$RUNTIME_SERVICE" ||
    fail "systemd could not start the shared runtime service"

  if ! wait_for_runtime; then
    systemctl --user --no-pager --full status \
      "$RUNTIME_SERVICE" >&2 || true
    journalctl --user -u "$RUNTIME_SERVICE" \
      -n 120 --no-pager >&2 || true
    fail "the shared runtime did not become ready"
  fi
fi

RUNTIME_COUNT="$(project_runtime_count)"
[ "$RUNTIME_COUNT" -eq 1 ] ||
  fail "expected exactly one project runtime, found $RUNTIME_COUNT"

bash "$ROOT/bin/floki-sleep-scheduler-start.sh" ||
  fail "sleep scheduler did not start"

bash "$ROOT/bin/floki-self-improvement-start.sh" ||
  fail "self-improvement worker did not start"

TUNNEL_STARTED=false
if unit_exists "$TUNNEL_SERVICE"; then
  systemctl --user start "$TUNNEL_SERVICE" ||
    fail "Omen reverse tunnel service did not start"
  TUNNEL_STARTED=true
fi

runtime_ready ||
  fail "runtime lost readiness after module startup"

echo "FLOKI_RUNTIME_BACKGROUND_START_PASS"
echo "runtime_service=$RUNTIME_SERVICE"
echo "runtime_reused=$RUNTIME_WAS_READY"
echo "runtime_process_count=$RUNTIME_COUNT"
echo "sleep_scheduler_started=true"
echo "self_improvement_worker_started=true"
echo "omen_tunnel_service_present=$TUNNEL_STARTED"
echo "electron_started=false"
echo "duplicate_runtime_started=false"
