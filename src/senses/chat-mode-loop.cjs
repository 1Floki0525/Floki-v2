'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  runSpokenReplyOnce
} = require('./spoken-reply-once.cjs');

const {
  createVoiceOutputLock
} = require('../chat/voice-output-lock.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const CHAT_MODE_LOOP_OUTPUT_DIR = path.join(TOOLS_DIR, 'output', 'chat-mode-loop');
const DEFAULT_TURNS = 1;
const MAX_PROOF_TURNS = 10;

function chatModeLoopAllowed(env = process.env) {
  return env.FLOKI_ALLOW_CHAT_MODE_LOOP === '1';
}

function parseTurnCount(value) {
  const parsed = Number.parseInt(String(value || DEFAULT_TURNS), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TURNS;
  }

  return Math.min(parsed, MAX_PROOF_TURNS);
}

function chatModeLoopGuardStatus(env = process.env) {
  const allowed = chatModeLoopAllowed(env);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_MODE_LOOP_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_CHAT_MODE_LOOP=1',
    default_turns: DEFAULT_TURNS,
    max_proof_turns: MAX_PROOF_TURNS,
    chat_mode_loop_run_now: false,
    microphone_recorded_now: false,
    vad_audio_analysis_run_now: false,
    whisper_transcription_run_now: false,
    wake_gate_checked_now: false,
    wake_routed_to_cognition: false,
    qwen_cognition_run_now: false,
    broca_enabled_now: false,
    piper_speech_run_now: false,
    piper_wav_created_now: false,
    speaker_playback_run_now: false,
    voice_output_lock_started: false,
    ears_muted_during_playback: false,
    voice_output_lock_cleared_after_playback: false,
    ears_open_after_playback: false,
    minecraft_called: false,
    chat_mode_only: true,
    reason: allowed
      ? 'Continuous chat mode loop is explicitly allowed for this bounded proof run.'
      : 'Continuous chat mode loop is guarded. Use npm run proof:chat-mode-loop for a bounded spoken chat proof.'
  });
}

function writeChatModeLoopReport(status, options = {}) {
  if (options.write_report === false) {
    return null;
  }

  const outputDir = options.output_dir || CHAT_MODE_LOOP_OUTPUT_DIR;
  const reportFile = options.report_file || path.join(outputDir, 'latest-chat-mode-loop.json');

  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(status, null, 2) + '\n');

  return reportFile;
}

function boolAny(turns, field) {
  return turns.some((turn) => turn && turn[field] === true);
}

function firstTurnValue(turns, field) {
  const found = turns.find((turn) => turn && turn[field]);
  return found ? found[field] : null;
}

function turnPassesFullInvariant(turn) {
  return Boolean(
    turn &&
    turn.ok === true &&
    (turn.microphone_recorded_now === true || turn.microphone_capture_replay_used === true) &&
    turn.vad_audio_analysis_run_now === true &&
    turn.whisper_transcription_run_now === true &&
    turn.wake_gate_checked_now === true &&
    turn.wake_routed_to_cognition === true &&
    turn.qwen_cognition_run_now === true &&
    turn.schema_constrained_json === true &&
    turn.model_json_fallback_used === false &&
    turn.broca_enabled_now === true &&
    turn.piper_speech_run_now === true &&
    turn.piper_wav_created_now === true &&
    turn.speaker_playback_run_now === true &&
    turn.voice_output_lock_started === true &&
    turn.ears_muted_during_playback === true &&
    turn.voice_output_lock_cleared_after_playback === true &&
    turn.ears_open_after_playback === true &&
    turn.chat_mode_only === true
  );
}

function compactTurn(index, status) {
  return Object.freeze({
    turn_index: index,
    ok: status.ok === true,
    marker: status.marker || null,
    spoken_report_file: status.report_file || null,
    spoken_reply_report_file: status.spoken_reply_report_file || status.report_file || null,
    hearing_report_file: status.hearing_report_file || null,
    bridge_report_file: status.bridge_report_file || null,
    capture_file: status.capture_file || null,
    whisper_report_file: status.whisper_report_file || null,
    piper_wav_output_file: status.piper_wav_output_file || null,
    heard_text: status.heard_text || '',
    wake_gate_checked_now: status.wake_gate_checked_now === true,
    wake_routed_to_cognition: status.wake_routed_to_cognition === true,
    qwen_cognition_run_now: status.qwen_cognition_run_now === true,
    schema_constrained_json: status.schema_constrained_json === true,
    model_json_fallback_used: status.model_json_fallback_used === true,
    broca_enabled_now: status.broca_enabled_now === true,
    piper_speech_run_now: status.piper_speech_run_now === true,
    piper_wav_created_now: status.piper_wav_created_now === true,
    speaker_playback_run_now: status.speaker_playback_run_now === true,
    voice_output_lock_started: status.voice_output_lock_started === true,
    ears_muted_during_playback: status.ears_muted_during_playback === true,
    voice_output_lock_cleared_after_playback: status.voice_output_lock_cleared_after_playback === true,
    ears_open_after_playback: status.ears_open_after_playback === true,
    microphone_recorded_now: status.microphone_recorded_now === true,
    microphone_capture_replay_used: status.microphone_capture_replay_used === true,
    vad_audio_analysis_run_now: status.vad_audio_analysis_run_now === true,
    whisper_transcription_run_now: status.whisper_transcription_run_now === true,
    chat_mode_only: true
  });
}

function mutedTurn(index, ears) {
  return Object.freeze({
    turn_index: index,
    ok: false,
    marker: 'FLOKI_V2_CHAT_MODE_LOOP_TURN_BLOCKED_BY_VOICE_LOCK',
    reason: 'voice_output_lock_active_before_turn',
    ears,
    chat_mode_loop_turn_run_now: false,
    microphone_recorded_now: false,
    vad_audio_analysis_run_now: false,
    whisper_transcription_run_now: false,
    wake_gate_checked_now: false,
    wake_routed_to_cognition: false,
    qwen_cognition_run_now: false,
    broca_enabled_now: false,
    piper_speech_run_now: false,
    piper_wav_created_now: false,
    speaker_playback_run_now: false,
    voice_output_lock_started: false,
    ears_muted_during_playback: false,
    voice_output_lock_cleared_after_playback: false,
    ears_open_after_playback: false,
    chat_mode_only: true
  });
}

async function runChatModeLoop(options = {}) {
  const env = options.env || process.env;
  const guard = chatModeLoopGuardStatus(env);

  if (!guard.allowed_now) {
    const status = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_CHAT_MODE_LOOP_BLOCKED',
      guard,
      chat_mode_loop_run_now: false,
      turns_requested: 0,
      turns_completed: 0,
      microphone_recorded_now: false,
      vad_audio_analysis_run_now: false,
      whisper_transcription_run_now: false,
      wake_gate_checked_now: false,
      wake_routed_to_cognition: false,
      qwen_cognition_run_now: false,
      broca_enabled_now: false,
      piper_speech_run_now: false,
      piper_wav_created_now: false,
      speaker_playback_run_now: false,
      voice_output_lock_started: false,
      ears_muted_during_playback: false,
      voice_output_lock_cleared_after_playback: false,
      ears_open_after_playback: false,
      minecraft_called: false,
      chat_mode_only: true
    });

    return Object.freeze({
      ...status,
      report_file: writeChatModeLoopReport(status, options)
    });
  }

  const turnsRequested = parseTurnCount(options.turns || env.FLOKI_CHAT_MODE_LOOP_TURNS);
  const spokenRunner = options.spoken_reply_runner || runSpokenReplyOnce;
  const lock = createVoiceOutputLock({
    lock_file: options.voice_lock_file
  });
  const turnReportsDir = options.turn_reports_dir || path.join(CHAT_MODE_LOOP_OUTPUT_DIR, 'turns');
  const turns = [];

  for (let index = 1; index <= turnsRequested; index += 1) {
    const local = {};

    if (typeof options.voice_lock_now_ms === 'number') {
      local.now_ms = options.voice_lock_now_ms;
    }

    const ears = lock.isEarsMuted(local);

    if (ears.ears_muted_now === true) {
      turns.push(mutedTurn(index, ears));
      break;
    }

    const padded = String(index).padStart(2, '0');
    const hearingReportFile = path.join(turnReportsDir, 'turn-' + padded + '-hearing.json');
    const spokenReportFile = path.join(turnReportsDir, 'turn-' + padded + '-spoken-reply.json');
    const bridgeReportFile = path.join(turnReportsDir, 'turn-' + padded + '-hearing-to-cognition.json');

    try {
      const turn = await spokenRunner({
        ...options.spoken_reply_options,
        env: {
          ...process.env,
          ...env,
          FLOKI_ALLOW_SPOKEN_REPLY_ONCE: '1'
        },
        seconds: options.seconds,
        input_file: options.input_file,
        device: options.device,
        rate: options.rate,
        channels: options.channels,
        whisper_model_size: options.whisper_model_size,
        voice_lock_file: options.voice_lock_file,
        voice_lock_now_ms: options.voice_lock_now_ms,
        voice_lock_start_now_ms: options.voice_lock_start_now_ms,
        voice_lock_end_now_ms: options.voice_lock_end_now_ms,
        voice_lock_ttl_ms: options.voice_lock_ttl_ms,
        piper_output_dir: options.piper_output_dir,
        voice_size: options.voice_size || 'large',
        hearing_report_file: hearingReportFile,
        report_file: spokenReportFile,
        bridge_report_file: bridgeReportFile,
        write_bridge_report: options.write_bridge_report
      });

      turns.push(compactTurn(index, turn));
    } catch (error) {
      turns.push(Object.freeze({
        turn_index: index,
        ok: false,
        marker: 'FLOKI_V2_CHAT_MODE_LOOP_TURN_FAIL',
        error: error && error.message ? error.message : String(error),
        microphone_recorded_now: false,
        vad_audio_analysis_run_now: false,
        whisper_transcription_run_now: false,
        wake_gate_checked_now: false,
        wake_routed_to_cognition: false,
        qwen_cognition_run_now: false,
        broca_enabled_now: false,
        piper_speech_run_now: false,
        piper_wav_created_now: false,
        speaker_playback_run_now: false,
        voice_output_lock_started: false,
        ears_muted_during_playback: false,
        voice_output_lock_cleared_after_playback: false,
        ears_open_after_playback: false,
        chat_mode_only: true
      }));
      break;
    }
  }

  const turnsCompleted = turns.filter((turn) => turn.ok === true).length;
  const ok = turns.length === turnsRequested &&
    turnsCompleted === turnsRequested &&
    turns.every(turnPassesFullInvariant);

  const status = Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_CHAT_MODE_LOOP_PASS' : 'FLOKI_V2_CHAT_MODE_LOOP_FAIL',
    guard,
    turns_requested: turnsRequested,
    turns_attempted: turns.length,
    turns_completed: turnsCompleted,
    capture_file: firstTurnValue(turns, 'capture_file'),
    whisper_report_file: firstTurnValue(turns, 'whisper_report_file'),
    hearing_report_file: firstTurnValue(turns, 'hearing_report_file'),
    piper_wav_output_file: firstTurnValue(turns, 'piper_wav_output_file'),
    spoken_reply_report_file: firstTurnValue(turns, 'spoken_reply_report_file'),
    turns,
    chat_mode_loop_run_now: true,
    microphone_recorded_now: boolAny(turns, 'microphone_recorded_now'),
    microphone_capture_replay_used: boolAny(turns, 'microphone_capture_replay_used'),
    vad_audio_analysis_run_now: boolAny(turns, 'vad_audio_analysis_run_now'),
    whisper_transcription_run_now: boolAny(turns, 'whisper_transcription_run_now'),
    wake_gate_checked_now: boolAny(turns, 'wake_gate_checked_now'),
    wake_routed_to_cognition: boolAny(turns, 'wake_routed_to_cognition'),
    qwen_cognition_run_now: boolAny(turns, 'qwen_cognition_run_now'),
    schema_constrained_json: turns.length > 0 && turns.every((turn) => turn.schema_constrained_json === true),
    model_json_fallback_used: boolAny(turns, 'model_json_fallback_used'),
    broca_enabled_now: boolAny(turns, 'broca_enabled_now'),
    piper_speech_run_now: boolAny(turns, 'piper_speech_run_now'),
    piper_wav_created_now: boolAny(turns, 'piper_wav_created_now'),
    speaker_playback_run_now: boolAny(turns, 'speaker_playback_run_now'),
    voice_output_lock_started: boolAny(turns, 'voice_output_lock_started'),
    ears_muted_during_playback: boolAny(turns, 'ears_muted_during_playback'),
    voice_output_lock_cleared_after_playback: boolAny(turns, 'voice_output_lock_cleared_after_playback'),
    ears_open_after_playback: boolAny(turns, 'ears_open_after_playback'),
    webcam_opened_now: false,
    yolo_inference_run_now: false,
    minecraft_called: false,
    chat_mode_only: true
  });

  return Object.freeze({
    ...status,
    report_file: writeChatModeLoopReport(status, options)
  });
}

async function printChatModeLoop() {
  const status = await runChatModeLoop();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printChatModeLoop().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_CHAT_MODE_LOOP_FAIL',
      error: error.message,
      chat_mode_loop_run_now: true,
      microphone_recorded_now: false,
      vad_audio_analysis_run_now: false,
      whisper_transcription_run_now: false,
      wake_gate_checked_now: false,
      wake_routed_to_cognition: false,
      qwen_cognition_run_now: false,
      broca_enabled_now: false,
      piper_speech_run_now: false,
      piper_wav_created_now: false,
      speaker_playback_run_now: false,
      voice_output_lock_started: false,
      ears_muted_during_playback: false,
      voice_output_lock_cleared_after_playback: false,
      ears_open_after_playback: false,
      chat_mode_only: true
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  ROOT,
  TOOLS_DIR,
  CHAT_MODE_LOOP_OUTPUT_DIR,
  DEFAULT_TURNS,
  MAX_PROOF_TURNS,
  chatModeLoopAllowed,
  parseTurnCount,
  chatModeLoopGuardStatus,
  writeChatModeLoopReport,
  runChatModeLoop,
  printChatModeLoop
};
