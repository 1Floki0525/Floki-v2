#!/usr/bin/env bash

# Floki-v2 knowledge autoload script.
# Reads config from YAML via Node helper instead of hardcoding paths.

fail_json() {
  echo "{\"ok\":false,\"marker\":\"FLOKI_V2_KNOWLEDGE_AUTOLOAD_FAIL\",\"error\":\"$1\",\"chat_mode_only\":true,\"game_mode_started\":false}"
  exit 1
}

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null 2>&1
fi

NODE_VERSION="$(node -v 2>/dev/null | head -c 3)"
if [ "$NODE_VERSION" != "v24" ]; then
  fail_json "Node 24 required, got $NODE_VERSION"
fi

# Resolve paths from YAML config via Node helper
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR" || fail_json "could not cd into project"

YOUTUBE_TEXT_ROOT="$(node -e "const c=require('./src/config/floki-config.cjs');console.log(c.getPathConfig('chat').youtube_transcript_root)")"
RUNTIME_DIR="$(node -e "const c=require('./src/config/floki-config.cjs');console.log(c.getPathConfig('chat').chat_runtime_root)")"
LOG_FILE="$RUNTIME_DIR/knowledge-autoload.log"
STAMP_FILE="$RUNTIME_DIR/knowledge-autoload.last-run"
MIN_SECONDS="$(node -e "const c=require('./src/config/floki-config.cjs');console.log(c.getKnowledgeConfig('chat').autoload_min_seconds)")"

mkdir -p "$RUNTIME_DIR"

if [ ! -d "$YOUTUBE_TEXT_ROOT" ]; then
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_KNOWLEDGE_AUTOLOAD_NO_CORPUS\",\"youtube_text_root\":\"$YOUTUBE_TEXT_ROOT\",\"chat_mode_only\":true,\"game_mode_started\":false}"
  exit 0
fi

if [ "${FLOKI_KNOWLEDGE_AUTOLOAD_FORCE:-0}" != "1" ] && [ -f "$STAMP_FILE" ]; then
  LAST_RUN_EPOCH="$(cat "$STAMP_FILE" 2>/dev/null || echo 0)"
  NOW_EPOCH="$(date +%s)"
  AGE_SECONDS="$((NOW_EPOCH - LAST_RUN_EPOCH))"
  if [ "$AGE_SECONDS" -lt "$MIN_SECONDS" ]; then
    echo "{\"ok\":true,\"marker\":\"FLOKI_V2_KNOWLEDGE_AUTOLOAD_RECENTLY_RAN\",\"age_seconds\":$AGE_SECONDS,\"youtube_text_root\":\"$YOUTUBE_TEXT_ROOT\",\"chat_mode_only\":true,\"game_mode_started\":false}"
    exit 0
  fi
fi

date +%s > "$STAMP_FILE"

CHANNEL_COUNT=0
PASS_COUNT=0
FAIL_COUNT=0

for CHANNEL_DIR in "$YOUTUBE_TEXT_ROOT"/*; do
  if [ ! -d "$CHANNEL_DIR" ]; then
    continue
  fi
  CHANNEL_COUNT="$((CHANNEL_COUNT + 1))"
  echo "$(date -Is) ingesting $CHANNEL_DIR" >> "$LOG_FILE"
  FLOKI_ALLOW_KNOWLEDGE_INGESTION=1 FLOKI_KNOWLEDGE_INPUT_PATH="$CHANNEL_DIR" node -e "require('./src/chat/knowledge-ingestion.cjs').runKnowledgeIngestionOnce({ env: process.env, input_path: process.env.FLOKI_KNOWLEDGE_INPUT_PATH })" >> "$LOG_FILE" 2>&1
  STATUS="$?"
  if [ "$STATUS" -eq 0 ]; then
    PASS_COUNT="$((PASS_COUNT + 1))"
  else
    FAIL_COUNT="$((FAIL_COUNT + 1))"
  fi
done

echo "{\"ok\":true,\"marker\":\"FLOKI_V2_KNOWLEDGE_AUTOLOAD_PASS\",\"youtube_text_root\":\"$YOUTUBE_TEXT_ROOT\",\"channel_count\":$CHANNEL_COUNT,\"pass_count\":$PASS_COUNT,\"fail_count\":$FAIL_COUNT,\"log_file\":\"$LOG_FILE\",\"chat_mode_only\":true,\"game_mode_started\":false}"
exit 0
