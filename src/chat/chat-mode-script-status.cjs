'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { statePath } = require('../util/fs-safe.cjs');
const {
  buildChatModeStatus
} = require('./chat-mode-status.cjs');
const {
  LATEST_REPORTS
} = require('./chat-mode-status.cjs');

const CHAT_RUNTIME_DIR = statePath('chat/runtime');
const CHAT_PID_FILE = path.join(CHAT_RUNTIME_DIR, 'chat-mode-loop.pid');
const CHAT_STOP_FILE = path.join(CHAT_RUNTIME_DIR, 'chat-mode-loop.stop');
const CHAT_LOG_FILE = path.join(CHAT_RUNTIME_DIR, 'chat-mode-loop.log');

function readPid(filePath = CHAT_PID_FILE) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (_error) {
    return null;
  }
}

function processArgs(pid) {
  if (!pid) {
    return null;
  }

  try {
    return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').trim();
  } catch (_error) {
    return null;
  }
}

function pidLooksLikeChatRunner(pid) {
  const args = processArgs(pid);

  return Boolean(args &&
    args.includes('floki-chat-start.sh') &&
    args.includes('--runner'));
}

function reportMarker(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed.marker || null;
  } catch (_error) {
    return null;
  }
}

function buildChatScriptStatus() {
  const base = buildChatModeStatus();
  const pid = readPid();
  const pidActive = pidLooksLikeChatRunner(pid);
  const lastProofMarker = reportMarker(LATEST_REPORTS.loop_report_file) ||
    reportMarker(LATEST_REPORTS.spoken_reply_report_file) ||
    reportMarker(LATEST_REPORTS.hearing_report_file);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_STATUS_SCRIPT_PASS',
    loop_active: pidActive,
    pid,
    pid_file: CHAT_PID_FILE,
    stop_file: CHAT_STOP_FILE,
    log_file: CHAT_LOG_FILE,
    lock_state: base.voice_output_lock_state,
    latest_reports: base.latest_reports,
    latest_hearing_report: base.latest_hearing_report,
    latest_spoken_reply_report: base.latest_spoken_reply_report,
    latest_loop_report: base.latest_loop_report,
    qwen_model: base.qwen_cognition.model,
    piper_voice: base.piper_voice.name,
    piper_voice_model: base.piper_voice.model_path,
    speaker_guard: base.speaker_playback_guard,
    last_proof_marker: lastProofMarker,
    wake_word_config: base.wake_word_config,
    always_listening_expected: base.microphone_readiness.always_listening_expected,
    transcribe_all_heard_audio_expected: base.microphone_readiness.transcribe_all_heard_audio_expected,
    reply_only_when_wake_gated: base.microphone_readiness.reply_only_when_wake_gated,
    mic_disabled_only_while_floki_speaks: base.microphone_readiness.mic_disabled_only_while_floki_speaks,
    chat_mode_only: true,
    game_mode_explicitly_out_of_scope: true,
    game_mode_started: false
  });
}

function printChatScriptStatus() {
  const status = buildChatScriptStatus();
  console.log(JSON.stringify(status, null, 2));
  return status;
}

if (require.main === module) {
  printChatScriptStatus();
}

module.exports = {
  CHAT_RUNTIME_DIR,
  CHAT_PID_FILE,
  CHAT_STOP_FILE,
  CHAT_LOG_FILE,
  readPid,
  processArgs,
  pidLooksLikeChatRunner,
  reportMarker,
  buildChatScriptStatus,
  printChatScriptStatus
};
