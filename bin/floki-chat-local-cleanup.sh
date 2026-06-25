#!/usr/bin/env bash

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT" || exit 1
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$HOME/.nvm/nvm.sh"
  nvm use 24.17.0 >/dev/null 2>&1 || nvm use 24 >/dev/null 2>&1
fi
CHAT_RUNTIME_DIR="$(node - <<'NODE'
'use strict';
const path = require('node:path');
const { PROJECT_ROOT, getPathConfig } = require('./src/config/floki-config.cjs');
process.stdout.write(path.resolve(PROJECT_ROOT, getPathConfig('chat').chat_runtime_root));
NODE
)" || exit 1
timeout 20s bash bin/floki-self-improvement-stop.sh >/dev/null 2>&1 || true


timeout 20s bash bin/floki-chat-stop.sh >/dev/null 2>&1 || true

timeout 20s bash bin/floki-chat-vision-stop.sh >/dev/null 2>&1 || true
timeout 20s bash bin/floki-sleep-scheduler-stop.sh >/dev/null 2>&1 || true

python3 - "$ROOT" <<'PY'
import os
import signal
import sys
import time
from pathlib import Path

root = str(Path(sys.argv[1]).resolve())
needles = (
    f"{root}/src/vision/chat-webcam-vision-service.cjs --service",
    f"{root}/.floki-tools/yolo-config/yolo-worker.py",
    f"{root}/.floki-tools/grounding-dino/grounding-dino-worker.py",
    f"{root}/src/chat/sleep-cycle-scheduler.cjs --service",
    f"{root}/src/runtime/chat-local-runtime.cjs",
    f"{root}/src/senses/chat-mode-loop.cjs",
    f"{root}/src/senses/silero-vad-worker.py",
    f"{root}/.floki-tools/repos/whisper.cpp/build/bin/whisper-cli",
    f"{root}/.floki-tools/repos/whisper.cpp/build/bin/whisper-server",
    f"{root}/.floki-tools/venv-chat-embodiment/bin/piper",
    f"{root}/apps/floki-neural-interface/node_modules/.bin/electron",
    "arecord -q",
    "aplay ",
)

processes = {}
for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    pid = int(entry.name)
    try:
        cmdline = (entry / 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf-8', 'replace').strip()
        status = (entry / 'status').read_text(encoding='utf-8', errors='replace')
        ppid = 0
        for line in status.splitlines():
            if line.startswith('PPid:'):
                ppid = int(line.split()[1])
                break
        processes[pid] = {'ppid': ppid, 'cmdline': cmdline}
    except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
        pass

targets = {
    pid for pid, info in processes.items()
    if any(needle in info['cmdline'] for needle in needles)
}

changed = True
while changed:
    changed = False
    for pid, info in processes.items():
        if info['ppid'] in targets and pid not in targets:
            targets.add(pid)
            changed = True

for pid in sorted(targets, reverse=True):
    try:
        os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass

deadline = time.time() + 6
while time.time() < deadline:
    alive = []
    for pid in targets:
        try:
            os.kill(pid, 0)
            alive.append(pid)
        except ProcessLookupError:
            pass
        except PermissionError:
            alive.append(pid)
    if not alive:
        break
    time.sleep(0.2)

for pid in targets:
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass

print(f"FLOKI_CHAT_LOCAL_EXACT_CLEANUP_PASS count={len(targets)}")
PY

STATUS="$?"

rm -f \
  "$CHAT_RUNTIME_DIR/chat-webcam-vision.pid" \
  "$CHAT_RUNTIME_DIR/sleep-cycle-scheduler.pid" \
  "$CHAT_RUNTIME_DIR/chat-local-runtime.pid" \
  "$CHAT_RUNTIME_DIR/chat-mode-loop.pid" \
  "$CHAT_RUNTIME_DIR/chat-mode-loop.stop" \
  "$CHAT_RUNTIME_DIR/chat-webcam-vision.refresh-request.json" \
  "$CHAT_RUNTIME_DIR/chat-vision-ssh-tunnel.sock"

exit "$STATUS"
