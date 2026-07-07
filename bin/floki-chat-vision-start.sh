#!/usr/bin/env bash


# FLOKI_RUNTIME_RESERVE_GPU_FOR_HF_COGNITION_V1
# Local vision helpers default to CPU so RTX VRAM stays reserved for warmed HF cognition.
# local HF the YAML-selected HF cognition/vision model remains reached through the existing vision tunnel.
export FLOKI_CHAT_VISION_DEVICE="${FLOKI_CHAT_VISION_DEVICE:-cpu}"
export FLOKI_YOLO_DEVICE="${FLOKI_YOLO_DEVICE:-cpu}"
export FLOKI_GROUNDING_DINO_DEVICE="${FLOKI_GROUNDING_DINO_DEVICE:-cpu}"
export FLOKI_PERSON_VERIFIER_DEVICE="${FLOKI_PERSON_VERIFIER_DEVICE:-cpu}"
export CUDA_VISIBLE_DEVICES="${FLOKI_CHAT_VISION_CUDA_VISIBLE_DEVICES:-}"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_RUN="$PROJECT_DIR/bin/floki-node24-run.sh"
SERVICE="$PROJECT_DIR/src/vision/chat-webcam-vision-service.cjs"
VISION_STOP="$PROJECT_DIR/bin/floki-chat-vision-stop.sh"

fail() {
  echo "FLOKI_V2_CHAT_WEBCAM_SERVICE_FAIL: $1" >&2
  exit 1
}

handle_interrupt() {
  trap - INT TERM HUP
  timeout 25s bash "$VISION_STOP" >/dev/null 2>&1 || true
  echo "FLOKI_V2_CHAT_WEBCAM_SERVICE_INTERRUPTED" >&2
  exit 130
}

cd "$PROJECT_DIR" || fail "could not enter project directory"
[ -x "$NODE_RUN" ] || fail "Node 24 runner missing: $NODE_RUN"
[ -x "$VISION_STOP" ] || fail "chat webcam stop helper missing: $VISION_STOP"
[ -f "$SERVICE" ] || fail "webcam service missing: $SERVICE"

# FLOKI_VISION_STARTUP_TIMEOUT_FROM_YAML_V1
VISION_READY_TIMEOUT_SECONDS="$(
  bash "$NODE_RUN" node - <<'NODE'
'use strict';
const path = require('node:path');
const { loadYamlFile } = require('./src/config/yaml-lite.cjs');

function pickNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

const raw = loadYamlFile(path.join(process.cwd(), 'config/chat.config.yaml'));
const models = raw.models || {};
const vision = models.vision || {};
const timeoutMs = pickNumber(
  vision.startup_ready_timeout_ms,
  vision.ready_timeout_ms,
  vision.startup_timeout_ms,
  300000
);
process.stdout.write(String(Math.max(1, Math.ceil(timeoutMs / 1000))));
NODE
)"
case "$VISION_READY_TIMEOUT_SECONDS" in
  ''|*[!0-9]*) fail "invalid models.vision.startup_ready_timeout_ms resolved from YAML: $VISION_READY_TIMEOUT_SECONDS" ;;
esac


trap handle_interrupt INT TERM HUP

FLOKI_ALLOW_WEBCAM_CAPTURE=1 \
FLOKI_ALLOW_CHAT_VISION=1 \
timeout --signal=TERM --kill-after=5s "${VISION_READY_TIMEOUT_SECONDS}s" \
  bash "$NODE_RUN" node "$SERVICE" --start
STATUS="$?"

trap - INT TERM HUP

if [ "$STATUS" -ne 0 ]; then
  timeout 25s bash "$VISION_STOP" >/dev/null 2>&1 || true
  fail "webcam service start failed or exceeded ${VISION_READY_TIMEOUT_SECONDS} seconds (status $STATUS)"
fi

exit 0
