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

ROOT="/media/binary-god/1tb-ssd/Floki-v2"
TARGET="$ROOT/src/chat/sleep-cycle-scheduler.cjs"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$HOME/Floki-v2-backups"
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/sleep-cycle-scheduler.cjs.bak.$STAMP"

fail() {
  echo "FLOKI_SCHEDULER_STOP_WAIT_FIX_FAIL: $*" >&2
  exit 1
}

[ -d "$ROOT" ] || fail "project root not found: $ROOT"
[ -f "$TARGET" ] || fail "target file not found: $TARGET"

cd "$ROOT" || fail "could not enter project root"

NODE_VERSION="$(bash bin/floki-node24-run.sh node --version 2>/dev/null)" || \
  fail "Node 24 wrapper failed"

if ! floki_node_24_or_newer "$NODE_VERSION"; then
  fail "expected Node 24 or newer, got: $NODE_VERSION"
fi

cp "$TARGET" "$BACKUP" || fail "could not create backup"

python3 - "$TARGET" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

old = """function cleanupSchedulerProcess(pid, paths, timeoutMs) {
  if (!pid || !processIsAlive(pid)) {
    if (pid && fs.existsSync(paths.pid_file)) fs.unlinkSync(paths.pid_file);
    return { ok: true, marker: 'SCHEDULER_CLEANUP_NO_PROCESS', pid };
  }

  const deadline = Date.now() + Number(timeoutMs || 5000);
  process.kill(pid, 'SIGTERM');

  while (Date.now() < deadline && processIsAlive(pid)) {
    new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (processIsAlive(pid)) {
    process.kill(pid, 'SIGKILL');
    while (processIsAlive(pid)) {
      new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (fs.existsSync(paths.pid_file)) fs.unlinkSync(paths.pid_file);
  return { ok: true, marker: 'SCHEDULER_CLEANUP_DONE', pid };
}
"""

new = """const SCHEDULER_STOP_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
  const delayMs = Math.max(1, Math.floor(Number(milliseconds) || 1));
  Atomics.wait(SCHEDULER_STOP_SLEEP_BUFFER, 0, 0, delayMs);
}

function waitForProcessExitSync(pid, timeoutMs, pollMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const intervalMs = Math.max(1, Number(pollMs) || 50);

  while (processIsAlive(pid) && Date.now() < deadline) {
    sleepSync(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }

  return !processIsAlive(pid);
}

function cleanupSchedulerProcess(pid, paths, timeoutMs) {
  if (!pid || !processIsAlive(pid)) {
    if (pid && fs.existsSync(paths.pid_file)) fs.unlinkSync(paths.pid_file);
    return { ok: true, marker: 'SCHEDULER_CLEANUP_NO_PROCESS', pid };
  }

  const gracefulTimeoutMs = Math.max(1, Number(timeoutMs) || 5000);
  const forceTimeoutMs = Math.min(2000, gracefulTimeoutMs);

  process.kill(pid, 'SIGTERM');

  let exited = waitForProcessExitSync(pid, gracefulTimeoutMs, 100);
  let forced = false;

  if (!exited) {
    forced = true;
    process.kill(pid, 'SIGKILL');
    exited = waitForProcessExitSync(pid, forceTimeoutMs, 50);
  }

  if (!exited) {
    return {
      ok: false,
      marker: 'SCHEDULER_CLEANUP_PROCESS_STILL_ALIVE',
      pid,
      forced,
      pid_file_preserved: fs.existsSync(paths.pid_file)
    };
  }

  if (fs.existsSync(paths.pid_file)) fs.unlinkSync(paths.pid_file);

  return {
    ok: true,
    marker: forced
      ? 'SCHEDULER_CLEANUP_FORCED'
      : 'SCHEDULER_CLEANUP_DONE',
    pid,
    forced
  };
}
"""

if old not in text:
    raise SystemExit(
        "expected cleanupSchedulerProcess block was not found; "
        "the file differs from the audited origin/main version"
    )

text = text.replace(old, new, 1)
path.write_text(text)
PY

if [ "$?" -ne 0 ]; then
  cp "$BACKUP" "$TARGET"
  fail "patch failed; restored backup"
fi

bash bin/floki-node24-run.sh node --check "$TARGET" || {
  cp "$BACKUP" "$TARGET"
  fail "syntax check failed; restored backup"
}

NODE_OPTIONS="--trace-warnings" \
bash bin/floki-node24-run.sh node - <<'NODE'
const scheduler = require('./src/chat/sleep-cycle-scheduler.cjs');

if (typeof scheduler.stopScheduler !== 'function') {
  throw new Error('stopScheduler export is missing');
}

console.log('FLOKI_SCHEDULER_STOP_IMPORT_PASS');
NODE

if [ "$?" -ne 0 ]; then
  cp "$BACKUP" "$TARGET"
  fail "critical import check failed; restored backup"
fi

bash bin/floki-node24-run.sh node tests/active-source-preflight-test.cjs || {
  cp "$BACKUP" "$TARGET"
  fail "active-source preflight failed; restored backup"
}

bash bin/floki-node24-run.sh node tests/sleep-cycle-scheduler-contract-test.cjs || {
  cp "$BACKUP" "$TARGET"
  fail "scheduler contract failed; restored backup"
}

bash bin/floki-node24-run.sh node tests/chat-webcam-shutdown-contract-test.cjs || {
  cp "$BACKUP" "$TARGET"
  fail "shutdown contract failed; restored backup"
}

echo
echo "FLOKI_SCHEDULER_STOP_WAIT_FIX_PASS"
echo "Changed: $TARGET"
echo "Backup:  $BACKUP"
echo
echo "Review:"
git diff -- "$TARGET"
