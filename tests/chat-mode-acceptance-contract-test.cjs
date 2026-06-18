'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  runChatModeAcceptanceProof
} = require('../src/chat/chat-mode-acceptance.cjs');

function status() {
  return {
    ok: true,
    marker: 'FLOKI_V2_CHAT_STATUS_SCRIPT_PASS'
  };
}

async function run() {
  const unique = newId('chat_acceptance_contract').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/chat-mode-acceptance/' + unique);
  ensureDirSync(baseDir);

  const wavFile = path.join(baseDir, 'piper.wav');
  fs.writeFileSync(wavFile, Buffer.concat([
    Buffer.from('RIFF0000WAVE', 'ascii'),
    Buffer.alloc(64)
  ]));

  const spokenReport = path.join(baseDir, 'spoken-report.json');

  const spoken = {
    ok: true,
    marker: 'FLOKI_V2_SPOKEN_REPLY_ONCE_PASS',
    report_file: spokenReport,
    bridge_report_file: null,
    hearing_report_file: path.join(baseDir, 'hearing.json'),
    capture_file: '/tmp/known-good.wav',
    whisper_report_file: path.join(baseDir, 'whisper.json'),
    piper_wav_output_file: wavFile,
    microphone_recorded_now: false,
    microphone_capture_replay_used: true,
    vad_audio_analysis_run_now: true,
    whisper_transcription_run_now: true,
    wake_gate_checked_now: true,
    wake_routed_to_cognition: true,
    qwen_cognition_run_now: true,
    schema_constrained_json: true,
    model_json_fallback_used: false,
    broca_enabled_now: true,
    piper_speech_run_now: true,
    piper_wav_created_now: true,
    speaker_playback_run_now: true,
    voice_output_lock_started: true,
    ears_muted_during_playback: true,
    voice_output_lock_cleared_after_playback: true,
    ears_open_after_playback: true,
    chat_mode_only: true
  };

  fs.writeFileSync(spokenReport, JSON.stringify(spoken, null, 2) + '\n');

  const proof = await runChatModeAcceptanceProof({
    env: {
      FLOKI_ALLOW_CHAT_MODE_ACCEPTANCE: '1'
    },
    write_report: false,
    status_runner: status,
    microphone_runner: function() {
      return {
        ok: true,
        marker: 'FLOKI_V2_MICROPHONE_CAPTURE_PASS',
        output_file: path.join(baseDir, 'live-mic.wav'),
        microphone_recorded_now: true
      };
    },
    vad_runner: function() {
      return {
        ok: true,
        marker: 'FLOKI_V2_VAD_SPEECH_DETECTION_PASS',
        vad_audio_analysis_run_now: true
      };
    },
    spoken_reply_runner: async function() {
      return spoken;
    },
    loop_runner: async function() {
      return {
        ...spoken,
        marker: 'FLOKI_V2_CHAT_MODE_LOOP_PASS',
        report_file: path.join(baseDir, 'loop-report.json'),
        turns: [
          {
            marker: 'FLOKI_V2_SPOKEN_REPLY_ONCE_PASS'
          }
        ]
      };
    },
    command_runner: function(command, args) {
      return {
        ok: true,
        command: [command].concat(args).join(' '),
        exit_status: 0,
        signal: null,
        stdout_tail: '{"ok":true}',
        stderr_tail: ''
      };
    }
  });

  assert.equal(proof.ok, true);
  assert.equal(proof.marker, 'FLOKI_V2_CHAT_MODE_ACCEPTANCE_PASS');
  assert.equal(proof.microphone_recorded_now, true);
  assert.equal(proof.vad_audio_analysis_run_now, true);
  assert.equal(proof.whisper_transcription_run_now, true);
  assert.equal(proof.wake_gate_checked_now, true);
  assert.equal(proof.wake_routed_to_cognition, true);
  assert.equal(proof.qwen_cognition_run_now, true);
  assert.equal(proof.schema_constrained_json, true);
  assert.equal(proof.model_json_fallback_used, false);
  assert.equal(proof.persistent_memory_used, true);
  assert.equal(proof.emotional_reinforcement_used, true);
  assert.equal(proof.broca_enabled_now, true);
  assert.equal(proof.piper_speech_run_now, true);
  assert.equal(proof.piper_wav_created_now, true);
  assert.equal(proof.speaker_playback_run_now, true);
  assert.equal(proof.voice_output_lock_started, true);
  assert.equal(proof.ears_muted_during_playback, true);
  assert.equal(proof.voice_output_lock_cleared_after_playback, true);
  assert.equal(proof.ears_open_after_playback, true);
  assert.equal(proof.self_echo_blocked, true);
  assert.equal(proof.background_speech_ignored, true);
  assert.equal(proof.chat_mode_only, true);
  assert.equal(proof.game_mode_started, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_MODE_ACCEPTANCE_CONTRACT_PASS',
    final_marker: proof.marker,
    microphone_recorded_now: proof.microphone_recorded_now,
    wake_routed_to_cognition: proof.wake_routed_to_cognition,
    qwen_cognition_run_now: proof.qwen_cognition_run_now,
    piper_wav_created_now: proof.piper_wav_created_now,
    speaker_playback_run_now: proof.speaker_playback_run_now,
    self_echo_blocked: proof.self_echo_blocked,
    background_speech_ignored: proof.background_speech_ignored,
    chat_mode_only: true
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_MODE_ACCEPTANCE_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
});
