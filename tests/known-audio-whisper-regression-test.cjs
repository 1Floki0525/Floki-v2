'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath } = require('../src/util/fs-safe.cjs');
const { PROJECT_ROOT, getPathConfig } = require('../src/config/floki-config.cjs');
const { newId } = require('../src/util/ids.cjs');

const {
  runWhisperTranscriptionProof
} = require('../src/senses/whisper-transcription-smoke.cjs');

const KNOWN_CAPTURE = path.resolve(
  PROJECT_ROOT,
  getPathConfig('chat').tool_input_root,
  'microphone-smoke',
  'microphone_smoke_20260617204048.wav'
);

function textHasWakeTrustHope(text) {
  const lower = String(text || '').toLowerCase();

  return lower.includes('hey') &&
    lower.includes('floki') &&
    lower.includes('trust') &&
    lower.includes('hope');
}

function run() {
  const unique = newId('known_audio_whisper').replace(/[^a-z0-9_]/g, '_');
  const reportFile = statePath('test/known-audio-whisper/' + unique + '/whisper-report.json');

  if (!fs.existsSync(KNOWN_CAPTURE)) {
    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_KNOWN_AUDIO_WHISPER_REGRESSION_SKIPPED',
      skipped: true,
      reason: 'fixture_missing',
      fixture_file: KNOWN_CAPTURE,
      whisper_transcription_run_now: false,
      chat_mode_only: true
    }, null, 2));
    return;
  }

  const stat = fs.statSync(KNOWN_CAPTURE);
  const status = runWhisperTranscriptionProof({
    env: {
      FLOKI_ALLOW_WHISPER_TRANSCRIPTION: '1'
    },
    input_file: KNOWN_CAPTURE,
    report_file: reportFile
  });

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_WHISPER_TRANSCRIPTION_PASS');
  assert.equal(status.input_file, KNOWN_CAPTURE);
  assert.equal(status.report_file, reportFile);
  assert.equal(status.whisper_transcription_run_now, true);
  assert.equal(textHasWakeTrustHope(status.transcription_text), true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_KNOWN_AUDIO_WHISPER_REGRESSION_PASS',
    fixture_file: KNOWN_CAPTURE,
    fixture_size_bytes: stat.size,
    whisper_report_file: status.report_file,
    transcription_text: status.transcription_text,
    transcript_contains_wake_trust_hope: true,
    whisper_transcription_run_now: true,
    microphone_recorded_now: false,
    chat_mode_only: true
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_KNOWN_AUDIO_WHISPER_REGRESSION_FAIL',
    error: error.message,
    fixture_file: KNOWN_CAPTURE,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
}
