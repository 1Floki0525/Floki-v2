'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const { statePath } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  chatGrowthPersistenceAllowed,
  chatGrowthPersistenceGuardStatus,
  runChatGrowthPersistenceProof
} = require('../src/chat/chat-growth-persistence.cjs');

async function run() {
  assert.equal(chatGrowthPersistenceAllowed({}), false);
  assert.equal(chatGrowthPersistenceAllowed({ FLOKI_ALLOW_CHAT_GROWTH_PERSISTENCE: '0' }), false);
  assert.equal(chatGrowthPersistenceAllowed({ FLOKI_ALLOW_CHAT_GROWTH_PERSISTENCE: '1' }), true);

  const guard = chatGrowthPersistenceGuardStatus({});

  assert.equal(guard.ok, true);
  assert.equal(guard.marker, 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_GUARDED');
  assert.equal(guard.allowed_now, false);
  assert.equal(guard.chat_growth_persistence_run_now, false);
  assert.equal(guard.whisper_transcription_run_now, false);
  assert.equal(guard.qwen_cognition_run_now, false);
  assert.equal(guard.piper_speech_run_now, false);
  assert.equal(guard.speaker_playback_run_now, false);
  assert.equal(guard.persistent_memory_used, false);
  assert.equal(guard.personality_identity_persisted, false);

  const unique = newId('chat_growth_guard').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/chat-growth-persistence-guard/' + unique);

  const blocked = await runChatGrowthPersistenceProof({
    env: {},
    write_report: false,
    hearing_report_file: '/tmp/floki-chat-growth-should-not-read.json',
    memory_base_dir: baseDir + '/chat-memory',
    brain_state_base_dir: baseDir + '/brain-state'
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.marker, 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_BLOCKED');
  assert.equal(blocked.chat_growth_persistence_run_now, false);
  assert.equal(blocked.whisper_transcription_run_now, false);
  assert.equal(blocked.wake_gate_checked_now, false);
  assert.equal(blocked.qwen_cognition_run_now, false);
  assert.equal(blocked.piper_speech_run_now, false);
  assert.equal(blocked.speaker_playback_run_now, false);
  assert.equal(blocked.persistent_memory_used, false);
  assert.equal(blocked.short_term_memory_written, false);
  assert.equal(blocked.emotional_reinforcement_used, false);
  assert.equal(blocked.personality_identity_persisted, false);
  assert.equal(fs.existsSync(baseDir), false);
  assert.equal(blocked.chat_mode_only, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_GUARD_PASS',
    requires_explicit_env: true,
    blocked_without_env: true,
    chat_growth_persistence_run_now: false,
    whisper_transcription_run_now: false,
    wake_gate_checked_now: false,
    qwen_cognition_run_now: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    persistent_memory_used: false,
    short_term_memory_written: false,
    emotional_reinforcement_used: false,
    personality_identity_persisted: false,
    chat_mode_only: true
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_GUARD_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
});
