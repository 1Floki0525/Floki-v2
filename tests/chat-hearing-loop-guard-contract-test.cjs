'use strict';

const assert = require('node:assert/strict');

const {
  chatHearingLoopAllowed,
  chatHearingLoopGuardStatus,
  runChatHearingLoopProof
} = require('../src/senses/chat-hearing-loop-smoke.cjs');

function run() {
  assert.equal(chatHearingLoopAllowed({}), false);
  assert.equal(chatHearingLoopAllowed({ FLOKI_ALLOW_CHAT_HEARING_LOOP: '0' }), false);
  assert.equal(chatHearingLoopAllowed({ FLOKI_ALLOW_CHAT_HEARING_LOOP: '1' }), true);

  const guard = chatHearingLoopGuardStatus({});
  assert.equal(guard.ok, true);
  assert.equal(guard.marker, 'FLOKI_V2_CHAT_HEARING_LOOP_GUARDED');
  assert.equal(guard.allowed_now, false);

  assert.equal(guard.chat_hearing_loop_run_now, false);
  assert.equal(guard.microphone_recorded_now, false);
  assert.equal(guard.vad_audio_analysis_run_now, false);
  assert.equal(guard.whisper_transcription_run_now, false);
  assert.equal(guard.qwen_called, false);
  assert.equal(guard.broca_called, false);
  assert.equal(guard.piper_speech_run_now, false);
  assert.equal(guard.speaker_playback_run_now, false);
  assert.equal(guard.webcam_opened_now, false);
  assert.equal(guard.yolo_inference_run_now, false);
  assert.equal(guard.minecraft_called, false);

  const blocked = runChatHearingLoopProof({
    env: {}
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.marker, 'FLOKI_V2_CHAT_HEARING_LOOP_BLOCKED');
  assert.equal(blocked.chat_hearing_loop_run_now, false);
  assert.equal(blocked.microphone_recorded_now, false);
  assert.equal(blocked.vad_audio_analysis_run_now, false);
  assert.equal(blocked.whisper_transcription_run_now, false);
  assert.equal(blocked.qwen_called, false);
  assert.equal(blocked.broca_called, false);
  assert.equal(blocked.piper_speech_run_now, false);
  assert.equal(blocked.speaker_playback_run_now, false);
  assert.equal(blocked.webcam_opened_now, false);
  assert.equal(blocked.yolo_inference_run_now, false);
  assert.equal(blocked.minecraft_called, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_HEARING_LOOP_GUARD_PASS',
    default_hearing_loop_allowed: false,
    explicit_hearing_env_required: 'FLOKI_ALLOW_CHAT_HEARING_LOOP=1',
    blocked_without_env: true,
    chat_hearing_loop_run_now: false,
    microphone_recorded_now: false,
    vad_audio_analysis_run_now: false,
    whisper_transcription_run_now: false,
    qwen_called: false,
    broca_called: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    webcam_opened_now: false,
    yolo_inference_run_now: false,
    minecraft_called: false
  }, null, 2));
}

run();
