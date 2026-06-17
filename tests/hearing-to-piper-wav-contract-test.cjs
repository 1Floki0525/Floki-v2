'use strict';

const assert = require('node:assert/strict');

const { makeSpeechOutput, validateBrainOutput } = require('../src/brain/brain-output-schema.cjs');
const {
  runPiperWavFromBroca
} = require('../src/senses/hearing-to-cognition-bridge.cjs');

function fakeGoodSynthesizer(options) {
  assert.equal(options.voice_size, 'large');
  assert.equal(typeof options.text, 'string');
  assert.equal(options.text.includes('Trust'), true);
  assert.equal(typeof options.output_dir, 'string');

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_FAKE_PIPER_WAV_TEST_PASS',
    voice_size: options.voice_size,
    voice_name: 'en_US-ryan-high',
    output_file: options.output_dir + '/fake-broca.wav',
    output_ready: true,
    output_size_bytes: 4096,
    riff_header: true,
    wave_header: true,
    piper_exit_status: 0,
    piper_speech_run_now: true,
    speaker_playback_run_now: false,
    webcam_opened_now: false,
    microphone_recorded_now: false,
    chat_mode_only: true
  });
}

function fakeSpeakerPlayingSynthesizer(options) {
  return Object.freeze({
    ok: true,
    marker: 'BAD_SYNTH_PLAYED_SPEAKER',
    voice_size: options.voice_size,
    voice_name: 'en_US-ryan-high',
    output_file: options.output_dir + '/bad.wav',
    output_ready: true,
    output_size_bytes: 4096,
    piper_speech_run_now: true,
    speaker_playback_run_now: true
  });
}

function run() {
  const broca = makeSpeechOutput(
    'Trust and hope help me stay continuous, careful, and connected in this conversation.',
    {
      parent_event_ids: [],
      parent_output_ids: [],
      tone: 'plain',
      audience: 'user',
      diagnostics: {
        module: 'broca',
        status: 'speech_created',
        chat_mode_only: true
      }
    }
  );

  validateBrainOutput(broca);

  const wav = runPiperWavFromBroca(broca, {
    piper_synthesizer: fakeGoodSynthesizer,
    voice_size: 'large',
    piper_output_dir: '/tmp/floki-v2-hearing-to-piper-wav-contract'
  });

  assert.equal(wav.ok, true);
  assert.equal(wav.piper_speech_run_now, true);
  assert.equal(wav.speaker_playback_run_now, false);
  assert.equal(wav.output_ready, true);
  assert.equal(wav.output_size_bytes > 44, true);
  assert.equal(wav.voice_name, 'en_US-ryan-high');

  assert.throws(() => {
    runPiperWavFromBroca(broca, {
      piper_synthesizer: fakeSpeakerPlayingSynthesizer,
      voice_size: 'large',
      piper_output_dir: '/tmp/floki-v2-bad-piper-contract'
    });
  }, /must not play speaker audio/);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_HEARING_TO_PIPER_WAV_CONTRACT_PASS',
    broca_output_type: broca.type,
    broca_output_source: broca.source,
    piper_wav_created_now: true,
    piper_speech_run_now: true,
    speaker_playback_run_now: false,
    speaker_playback_rejected_if_attempted: true,
    chat_mode_only: true
  }, null, 2));
}

run();
