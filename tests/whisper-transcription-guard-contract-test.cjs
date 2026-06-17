'use strict';

const assert = require('node:assert/strict');

const {
  whisperTranscriptionAllowed,
  whisperGuardStatus,
  whisperModelPath,
  cleanTranscriptionText,
  textLooksLikeSpeech,
  runWhisperTranscriptionProof
} = require('../src/senses/whisper-transcription-smoke.cjs');

function run() {
  assert.equal(whisperTranscriptionAllowed({}), false);
  assert.equal(whisperTranscriptionAllowed({ FLOKI_ALLOW_WHISPER_TRANSCRIPTION: '0' }), false);
  assert.equal(whisperTranscriptionAllowed({ FLOKI_ALLOW_WHISPER_TRANSCRIPTION: '1' }), true);

  const guard = whisperGuardStatus({});
  assert.equal(guard.ok, true);
  assert.equal(guard.marker, 'FLOKI_V2_WHISPER_TRANSCRIPTION_GUARDED');
  assert.equal(guard.allowed_now, false);
  assert.equal(guard.whisper_transcription_run_now, false);

  const blocked = runWhisperTranscriptionProof({
    env: {},
    input_file: '/tmp/floki-whisper-should-not-transcribe.wav'
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.marker, 'FLOKI_V2_WHISPER_TRANSCRIPTION_BLOCKED');
  assert.equal(blocked.whisper_transcription_run_now, false);
  assert.equal(blocked.microphone_recorded_now, false);
  assert.equal(blocked.vad_audio_analysis_run_now, false);
  assert.equal(blocked.yolo_inference_run_now, false);
  assert.equal(blocked.piper_speech_run_now, false);
  assert.equal(blocked.speaker_playback_run_now, false);
  assert.equal(blocked.minecraft_called, false);

  assert.equal(whisperModelPath('tiny').endsWith('ggml-tiny.en.bin'), true);
  assert.equal(whisperModelPath('small').endsWith('ggml-small.en.bin'), true);

  assert.equal(cleanTranscriptionText('  hello   world  '), 'hello world');
  assert.equal(cleanTranscriptionText('[BLANK_AUDIO] hello world'), 'hello world');
  assert.equal(textLooksLikeSpeech('hello'), true);
  assert.equal(textLooksLikeSpeech('12345'), false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_WHISPER_TRANSCRIPTION_GUARD_PASS',
    default_transcription_allowed: false,
    explicit_transcription_env_required: 'FLOKI_ALLOW_WHISPER_TRANSCRIPTION=1',
    blocked_without_env: true,
    whisper_transcription_run_now: false,
    microphone_recorded_now: false,
    vad_audio_analysis_run_now: false,
    yolo_inference_run_now: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    minecraft_called: false
  }, null, 2));
}

run();
