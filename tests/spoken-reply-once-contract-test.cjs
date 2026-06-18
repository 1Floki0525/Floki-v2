'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');

const {
  ensurePiperWavReady,
  runSpokenReplyOnce
} = require('../src/senses/spoken-reply-once.cjs');

function makeFakeWav(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = Buffer.from('RIFF0000WAVEfmt ', 'ascii');
  fs.writeFileSync(filePath, Buffer.concat([header, Buffer.alloc(2048)]));
}

async function run() {
  const unique = newId('spoken_reply_contract').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/spoken-reply-once/' + unique);
  const hearingReport = path.join(baseDir, 'fake-hearing-report.json');
  const bridgeReport = path.join(baseDir, 'fake-bridge-report.json');
  const wavFile = path.join(baseDir, 'fake-broca-piper.wav');
  const spokenReport = path.join(baseDir, 'spoken-reply-report.json');

  makeFakeWav(wavFile);

  let hearingRan = false;
  let bridgeRan = false;
  let playbackRan = false;
  let playbackReceivedWav = null;

  function fakeHearingRunner(options) {
    hearingRan = true;

    assert.equal(options.env.FLOKI_ALLOW_CHAT_HEARING_LOOP, '1');
    assert.equal(options.report_file, hearingReport);

    fs.mkdirSync(path.dirname(hearingReport), { recursive: true });
    fs.writeFileSync(hearingReport, JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_CHAT_HEARING_LOOP_PASS',
      heard_text: 'Hey Floki, what do you remember about trust and hope?',
      report_file: hearingReport,
      microphone_recorded_now: true,
      vad_audio_analysis_run_now: true,
      whisper_transcription_run_now: true
    }, null, 2) + '\n');

    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_CHAT_HEARING_LOOP_PASS',
      heard_text: 'Hey Floki, what do you remember about trust and hope?',
      report_file: hearingReport,
      microphone_recorded_now: true,
      vad_audio_analysis_run_now: true,
      whisper_transcription_run_now: true
    });
  }

  function fakeBridgeRunner(options) {
    bridgeRan = true;

    assert.equal(options.env.FLOKI_ALLOW_HEARING_TO_COGNITION, '1');
    assert.equal(options.hearing_report_file, hearingReport);

    const bridge = Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_WAKE_GATED_MEMORY_AWARE_HEARING_TO_PIPER_WAV_PASS',
      report_file: bridgeReport,
      original_heard_text: 'Hey Floki, what do you remember about trust and hope?',
      wake_request_text: 'what do you remember about trust and hope?',
      wake_gate_marker: 'FLOKI_V2_WAKE_WORD_GATE_ROUTED',
      wake_gate_open: true,
      wake_routed_to_cognition: true,
      cognition_model: 'qwen3.5:9b',
      cognition_type: 'model_response_summary',
      schema_constrained_json: true,
      model_json_fallback_used: false,
      safe_thought_summary: 'Trust and hope connect to memory continuity.',
      broca_text_response: 'Trust and hope help me stay continuous, careful, and connected in this conversation.',
      piper_wav_output_file: wavFile,
      piper_wav_output_ready: true,
      piper_wav_output_size_bytes: fs.statSync(wavFile).size,
      piper_voice_size: 'large',
      piper_voice_name: 'en_US-ryan-high',
      qwen_cognition_run_now: true,
      broca_enabled_now: true,
      broca_text_response_created_now: true,
      piper_speech_run_now: true,
      piper_wav_created_now: true,
      speaker_playback_run_now: false
    });

    fs.writeFileSync(bridgeReport, JSON.stringify(bridge, null, 2) + '\n');

    return bridge;
  }

  function fakeLockedPlaybackRunner(filePath, metadata, options) {
    playbackRan = true;
    playbackReceivedWav = filePath;

    assert.equal(filePath, wavFile);
    assert.equal(typeof metadata.output_id, 'string');
    assert.equal(typeof metadata.text_hash, 'string');
    assert.equal(typeof options.voice_lock_file === 'string' || options.voice_lock_file === undefined, true);

    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_SPEAKER_PLAYBACK_WITH_VOICE_LOCK_PASS',
      file_path: filePath,
      playback: {
        ok: true,
        command: 'fake-aplay',
        exit_status: 0
      },
      voice_output_lock_started: true,
      ears_muted_during_playback: true,
      voice_output_lock_cleared_after_playback: true,
      ears_open_after_playback: true,
      speaker_playback_run_now: true,
      chat_mode_only: true
    });
  }

  const bridgePass = fakeBridgeRunner({
    env: {
      FLOKI_ALLOW_HEARING_TO_COGNITION: '1'
    },
    hearing_report_file: hearingReport
  });

  assert.equal(ensurePiperWavReady(bridgePass), wavFile);

  const status = await runSpokenReplyOnce({
    env: {
      FLOKI_ALLOW_SPOKEN_REPLY_ONCE: '1'
    },
    hearing_runner: fakeHearingRunner,
    bridge_runner: fakeBridgeRunner,
    locked_playback_runner: fakeLockedPlaybackRunner,
    hearing_report_file: hearingReport,
    report_file: spokenReport,
    voice_lock_file: path.join(baseDir, 'voice-output-lock.json'),
    write_bridge_report: false
  });

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_SPOKEN_REPLY_ONCE_PASS');
  assert.equal(hearingRan, true);
  assert.equal(bridgeRan, true);
  assert.equal(playbackRan, true);
  assert.equal(playbackReceivedWav, wavFile);

  assert.equal(status.microphone_recorded_now, true);
  assert.equal(status.vad_audio_analysis_run_now, true);
  assert.equal(status.whisper_transcription_run_now, true);
  assert.equal(status.wake_gate_checked_now, true);
  assert.equal(status.qwen_cognition_run_now, true);
  assert.equal(status.schema_constrained_json, true);
  assert.equal(status.model_json_fallback_used, false);
  assert.equal(status.broca_enabled_now, true);
  assert.equal(status.piper_speech_run_now, true);
  assert.equal(status.piper_wav_created_now, true);
  assert.equal(status.speaker_playback_run_now, true);
  assert.equal(status.voice_output_lock_started, true);
  assert.equal(status.ears_muted_during_playback, true);
  assert.equal(status.voice_output_lock_cleared_after_playback, true);
  assert.equal(status.ears_open_after_playback, true);
  assert.equal(status.report_file, spokenReport);
  assert.equal(fs.existsSync(spokenReport), true);

  assert.throws(() => {
    ensurePiperWavReady({
      ...bridgePass,
      model_json_fallback_used: true
    });
  }, /fallback is not allowed/);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SPOKEN_REPLY_ONCE_CONTRACT_PASS',
    hearing_ran: hearingRan,
    bridge_ran: bridgeRan,
    playback_ran: playbackRan,
    schema_constrained_json: status.schema_constrained_json,
    model_json_fallback_used: status.model_json_fallback_used,
    piper_wav_output_file: status.piper_wav_output_file,
    speaker_playback_run_now: status.speaker_playback_run_now,
    voice_output_lock_started: status.voice_output_lock_started,
    ears_muted_during_playback: status.ears_muted_during_playback,
    voice_output_lock_cleared_after_playback: status.voice_output_lock_cleared_after_playback,
    ears_open_after_playback: status.ears_open_after_playback,
    fallback_rejected: true,
    chat_mode_only: true
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_SPOKEN_REPLY_ONCE_CONTRACT_FAIL',
    error: error.message
  }, null, 2));
  process.exit(1);
});
