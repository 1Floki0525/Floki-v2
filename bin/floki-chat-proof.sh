#!/usr/bin/env bash

PROJECT_DIR="/media/binary-god/1tb-ssd/Floki-v2"
KNOWN_AUDIO="$PROJECT_DIR/.floki-tools/input/microphone-smoke/microphone_smoke_20260617204048.wav"

fail() {
  echo "{\"ok\":false,\"marker\":\"FLOKI_V2_CHAT_PROOF_SCRIPT_FAIL\",\"error\":\"$1\",\"chat_mode_only\":true}" >&2
  exit 1
}

if [ ! -d "$PROJECT_DIR" ]; then
  fail "Project directory not found: $PROJECT_DIR"
fi

cd "$PROJECT_DIR" || fail "Could not cd into $PROJECT_DIR"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null 2>&1
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm was not found on PATH"
fi

if [ "${FLOKI_CHAT_SCRIPT_DRY_RUN:-0}" = "1" ]; then
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_PROOF_SCRIPT_PASS\",\"dry_run\":true,\"bounded\":true,\"chat_mode_only\":true}"
  exit 0
fi

export FLOKI_CHAT_MODE_LOOP_TURNS="${FLOKI_CHAT_MODE_LOOP_TURNS:-1}"
export FLOKI_HEARING_CAPTURE_SECONDS="${FLOKI_HEARING_CAPTURE_SECONDS:-6}"

if [ "${FLOKI_CHAT_PROOF_USE_KNOWN_AUDIO:-1}" = "1" ] && [ -f "$KNOWN_AUDIO" ] && [ -z "$FLOKI_HEARING_INPUT_WAV" ]; then
  export FLOKI_HEARING_INPUT_WAV="$KNOWN_AUDIO"
fi

npm run proof:chat-mode-status || fail "chat mode status proof failed"
npm run proof:chat-mode-loop || fail "bounded chat mode loop proof failed"
npm run proof:self-echo-regression || fail "self echo regression proof failed"

echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_PROOF_SCRIPT_PASS\",\"bounded\":true,\"turns\":\"$FLOKI_CHAT_MODE_LOOP_TURNS\",\"capture_file\":\"${FLOKI_HEARING_INPUT_WAV:-}\",\"chat_mode_only\":true}"
exit 0
