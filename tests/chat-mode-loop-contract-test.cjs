'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');

const {
  runChatModeLoop,
  writeChatModeLoopReport
} = require('../src/senses/chat-mode-loop.cjs');

async function run() {
  const unique = newId('chat_mode_loop_contract').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/chat-mode-loop/' + unique);
  const loopReport = path.join(baseDir, 'loop-report.json');
  const turnReportsDir = path.join(baseDir, 'turns');
  const voiceLockFile = path.join(baseDir, 'voice-output-lock.json');
  const calledReports = [];

  function fakeSpokenReplyRunner(options) {
    calledReports.push({
      hearing_report_file: options.hearing_report_file,
      report_file: options.report_file,
      bridge_report_file: options.bridge_report_file,
      env: options.env
    });

    assert.equal(options.env.FLOKI_ALLOW_SPOKEN_REPLY_ONCE, '1');
    assert.equal(options.voice_lock_file, voiceLockFile);
    assert.equal(options.seconds, 6);
    assert.equal(options.voice_size, 'large');
    assert.equal(options.write_bridge_report, false);
    assert.equal(options.hearing_report_file.startsWith(turnReportsDir), true);
    assert.equal(options.report_file.startsWith(turnReportsDir), true);
    assert.equal(options.bridge_report_file.startsWith(turnReportsDir), true);
    assert.notEqual(options.hearing_report_file, options.bridge_report_file);

    fs.mkdirSync(path.dirname(options.report_file), { recursive: true });
    fs.writeFileSync(options.hearing_report_file, JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_CHAT_HEARING_LOOP_PASS',
      heard_text: 'Hey Floki, are you still listening?',
      chat_mode_only: true
    }, null, 2) + '\n');
    fs.writeFileSync(options.report_file, JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_SPOKEN_REPLY_ONCE_PASS',
      chat_mode_only: true
    }, null, 2) + '\n');

    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_SPOKEN_REPLY_ONCE_PASS',
      report_file: options.report_file,
      hearing_report_file: options.hearing_report_file,
      bridge_report_file: options.bridge_report_file,
      heard_text: 'Hey Floki, are you still listening?',
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
      microphone_recorded_now: true,
      vad_audio_analysis_run_now: true,
      whisper_transcription_run_now: true,
      chat_mode_only: true
    });
  }

  const status = await runChatModeLoop({
    env: {
      FLOKI_ALLOW_CHAT_MODE_LOOP: '1',
      FLOKI_CHAT_MODE_LOOP_TURNS: '2'
    },
    spoken_reply_runner: fakeSpokenReplyRunner,
    report_file: loopReport,
    turn_reports_dir: turnReportsDir,
    voice_lock_file: voiceLockFile,
    seconds: 6,
    voice_size: 'large',
    write_bridge_report: false
  });

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_CHAT_MODE_LOOP_PASS');
  assert.equal(status.turns_requested, 2);
  assert.equal(status.turns_attempted, 2);
  assert.equal(status.turns_completed, 2);
  assert.equal(calledReports.length, 2);
  assert.notEqual(calledReports[0].report_file, calledReports[1].report_file);
  assert.notEqual(status.turns[0].hearing_report_file, status.turns[1].hearing_report_file);
  assert.equal(status.microphone_recorded_now, true);
  assert.equal(status.vad_audio_analysis_run_now, true);
  assert.equal(status.whisper_transcription_run_now, true);
  assert.equal(status.wake_gate_checked_now, true);
  assert.equal(status.wake_routed_to_cognition, true);
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
  assert.equal(status.minecraft_called, false);
  assert.equal(status.chat_mode_only, true);
  assert.equal(status.report_file, loopReport);
  assert.equal(fs.existsSync(loopReport), true);

  const disabled = writeChatModeLoopReport({
    ok: true,
    marker: 'FLOKI_V2_CHAT_MODE_LOOP_DISABLED_REPORT_TEST',
    chat_mode_only: true
  }, {
    write_report: false
  });

  assert.equal(disabled, null);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_MODE_LOOP_CONTRACT_PASS',
    turns_requested: status.turns_requested,
    turns_completed: status.turns_completed,
    spoken_reply_runner_called: calledReports.length,
    loop_report_file: status.report_file,
    contract_report_isolated: true,
    per_turn_hearing_reports_isolated: true,
    microphone_recorded_now: status.microphone_recorded_now,
    wake_routed_to_cognition: status.wake_routed_to_cognition,
    qwen_cognition_run_now: status.qwen_cognition_run_now,
    speaker_playback_run_now: status.speaker_playback_run_now,
    chat_mode_only: true
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_MODE_LOOP_CONTRACT_FAIL',
    error: error.message
  }, null, 2));
  process.exit(1);
});
