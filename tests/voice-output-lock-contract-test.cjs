'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');

const {
  createVoiceOutputLock,
  normalizeLockRecord
} = require('../src/chat/voice-output-lock.cjs');

const {
  runChatHearingLoopProof
} = require('../src/senses/chat-hearing-loop-smoke.cjs');

const {
  applyWakeGateToHeardText
} = require('../src/senses/hearing-to-cognition-bridge.cjs');

function run() {
  const unique = newId('voice_lock_contract').replace(/[^a-z0-9_]/g, '_');
  const lockFile = statePath('test/voice-output-lock/' + unique + '/voice-output-lock.json');

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  const lock = createVoiceOutputLock({
    lock_file: lockFile
  });

  const baseMs = 1000000;

  const initial = lock.isEarsMuted({
    now_ms: baseMs
  });

  assert.equal(initial.ok, true);
  assert.equal(initial.ears_muted_now, false);
  assert.equal(initial.voice_output_lock_active, false);

  const started = lock.beginSpeaking({
    source: 'piper',
    output_id: 'speech_output_contract',
    text_hash: 'trust_hope_contract',
    now_ms: baseMs,
    ttl_ms: 60000
  });

  assert.equal(started.speaking_now, true);
  assert.equal(started.ears_muted_now, true);
  assert.equal(started.reason, 'voice_output_active');

  const muted = lock.isEarsMuted({
    now_ms: baseMs + 2000
  });

  assert.equal(muted.ears_muted_now, true);
  assert.equal(muted.voice_output_lock_active, true);

  const hearing = runChatHearingLoopProof({
    env: {
      FLOKI_ALLOW_CHAT_HEARING_LOOP: '1'
    },
    voice_lock_file: lockFile,
    voice_lock_now_ms: baseMs + 3000
  });

  assert.equal(hearing.ok, true);
  assert.equal(hearing.marker, 'FLOKI_V2_CHAT_HEARING_LOOP_EARS_MUTED_WHILE_SPEAKING');
  assert.equal(hearing.microphone_recorded_now, false);
  assert.equal(hearing.vad_audio_analysis_run_now, false);
  assert.equal(hearing.whisper_transcription_run_now, false);
  assert.equal(hearing.qwen_called, false);
  assert.equal(hearing.broca_called, false);
  assert.equal(hearing.piper_speech_run_now, false);
  assert.equal(hearing.speaker_playback_run_now, false);

  const gated = applyWakeGateToHeardText({
    heard_text: 'Hey Floki, this is your own speaker output'
  }, {
    voice_lock_file: lockFile,
    voice_lock_now_ms: baseMs + 4000,
    modality: 'spoken',
    source: 'user'
  });

  assert.equal(gated.gate_open, false);
  assert.equal(gated.routed_to_cognition, false);
  assert.equal(gated.ears_must_be_muted, true);
  assert.equal(gated.reason, 'voice_speaking_ears_muted');

  const ended = lock.endSpeaking({
    now_ms: baseMs + 5000,
    reason: 'completed'
  });

  assert.equal(ended.speaking_now, false);
  assert.equal(ended.ears_muted_now, false);

  const expired = normalizeLockRecord({
    lock_version: 'floki-v2-voice-output-lock-v1',
    active: true,
    lock_id: 'expired_lock',
    source: 'piper',
    output_id: 'expired_output',
    started_at_ms: baseMs,
    expires_at_ms: baseMs + 1000
  }, {
    now_ms: baseMs + 3000
  });

  assert.equal(expired.expired, true);
  assert.equal(expired.speaking_now, false);
  assert.equal(expired.ears_muted_now, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_VOICE_OUTPUT_LOCK_CONTRACT_PASS',
    lock_file: lockFile,
    deterministic_clock_used: true,
    begin_speaking_mutes_ears: true,
    chat_hearing_loop_blocks_microphone_while_speaking: true,
    wake_gate_blocks_self_echo_while_speaking: true,
    end_speaking_opens_ears: true,
    expired_lock_opens_ears: true,
    microphone_recorded_now: false,
    vad_audio_analysis_run_now: false,
    whisper_transcription_run_now: false,
    qwen_called: false,
    broca_called: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    chat_mode_only: true
  }, null, 2));
}

run();
