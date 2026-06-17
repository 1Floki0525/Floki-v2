'use strict';

const assert = require('node:assert/strict');

const {
  OUTPUT_DIR,
  VOICES,
  synthesizePiperSpeechToFile
} = require('../src/senses/piper-speech-smoke.cjs');

function run() {
  const status = synthesizePiperSpeechToFile({
    voice_size: 'small',
    text: 'I am Floki. This is a safe voice proof. I am not playing audio through speakers yet.'
  });

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_PIPER_SPEECH_SMOKE_PASS');

  assert.equal(status.voice_size, 'small');
  assert.equal(status.voice_name, 'en_US-amy-medium');
  assert.equal(status.model_path, VOICES.small.model);
  assert.equal(status.config_path, VOICES.small.config);
  assert.equal(status.output_file.startsWith(OUTPUT_DIR), true);
  assert.equal(status.output_ready, true);
  assert.equal(status.output_size_bytes > 44, true);
  assert.equal(status.riff_header, true);
  assert.equal(status.wave_header, true);
  assert.equal(status.piper_exit_status, 0);

  assert.equal(status.piper_speech_run_now, true);
  assert.equal(status.speaker_playback_run_now, false);
  assert.equal(status.webcam_opened_now, false);
  assert.equal(status.microphone_recorded_now, false);
  assert.equal(status.minecraft_called, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_PIPER_SPEECH_SMOKE_PASS',
    voice_size: status.voice_size,
    voice_name: status.voice_name,
    output_file: status.output_file,
    output_size_bytes: status.output_size_bytes,
    riff_header: status.riff_header,
    wave_header: status.wave_header,
    piper_speech_run_now: true,
    speaker_playback_run_now: false,
    webcam_opened_now: false,
    microphone_recorded_now: false,
    minecraft_called: false
  }, null, 2));
}

run();
