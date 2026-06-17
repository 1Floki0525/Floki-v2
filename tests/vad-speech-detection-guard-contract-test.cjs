'use strict';

const assert = require('node:assert/strict');

const {
  vadAnalysisAllowed,
  vadGuardStatus,
  runVadSpeechDetectionProof
} = require('../src/senses/vad-speech-detection.cjs');

function run() {
  assert.equal(vadAnalysisAllowed({}), false);
  assert.equal(vadAnalysisAllowed({ FLOKI_ALLOW_VAD_ANALYSIS: '0' }), false);
  assert.equal(vadAnalysisAllowed({ FLOKI_ALLOW_VAD_ANALYSIS: '1' }), true);

  const guard = vadGuardStatus({});
  assert.equal(guard.ok, true);
  assert.equal(guard.marker, 'FLOKI_V2_VAD_SPEECH_DETECTION_GUARDED');
  assert.equal(guard.allowed_now, false);
  assert.equal(guard.vad_audio_analysis_run_now, false);

  const blocked = runVadSpeechDetectionProof({
    env: {},
    input_file: '/tmp/floki-vad-should-not-analyze.wav'
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.marker, 'FLOKI_V2_VAD_SPEECH_DETECTION_BLOCKED');
  assert.equal(blocked.vad_audio_analysis_run_now, false);
  assert.equal(blocked.microphone_recorded_now, false);
  assert.equal(blocked.whisper_transcription_run_now, false);
  assert.equal(blocked.yolo_inference_run_now, false);
  assert.equal(blocked.piper_speech_run_now, false);
  assert.equal(blocked.speaker_playback_run_now, false);
  assert.equal(blocked.minecraft_called, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_VAD_SPEECH_DETECTION_GUARD_PASS',
    default_vad_analysis_allowed: false,
    explicit_vad_env_required: 'FLOKI_ALLOW_VAD_ANALYSIS=1',
    blocked_without_env: true,
    vad_audio_analysis_run_now: false,
    microphone_recorded_now: false,
    whisper_transcription_run_now: false,
    yolo_inference_run_now: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    minecraft_called: false
  }, null, 2));
}

run();
