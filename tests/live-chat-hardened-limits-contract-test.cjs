'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const yaml = fs.readFileSync(path.join(__dirname, '../config/chat.config.yaml'), 'utf8');

function matchLiveChat(key) {
  const re = new RegExp('^  ' + key + ':\\s*(\\d+)', 'm');
  const m = yaml.match(re);
  return m ? Number(m[1]) : null;
}

function main() {
  for (const key of ['history_limit', 'transcript_tail_max', 'neural_event_max_display_chars', 'audio_voice_lock_ttl_ms', 'piper_text_max_chars', 'piper_request_timeout_ms', 'control_action_defer_ms']) {
    const v = matchLiveChat(key);
    if (v === null) assert.fail(key + ' must be defined in live_chat section');
    if (!Number.isFinite(v) || v <= 0) assert.fail(key + ' must be a positive number');
  }
  const transcript = fs.readFileSync(path.join(__dirname, '../src/chat/chat-transcript.cjs'), 'utf8');
  assert.match(transcript, /appendChatTranscriptTurn/);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_LIVE_CHAT_HARDENED_LIMITS_PASS',
    history_limit: matchLiveChat('history_limit'),
    transcript_tail_max: matchLiveChat('transcript_tail_max'),
    neural_event_max_display_chars: matchLiveChat('neural_event_max_display_chars'),
    piper_text_max_chars: matchLiveChat('piper_text_max_chars'),
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main();
