'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { statePath } = require('../util/fs-safe.cjs');
const { CHAT_MODE_LIVING_CONTRACT } = require('./chat-mode-living-contract.cjs');
const { createVoiceOutputLock } = require('./voice-output-lock.cjs');
const { buildChatToolchainReadinessStatus } = require('../senses/chat-toolchain-readiness.cjs');
const { speakerPlaybackGuardStatus } = require('../senses/piper-speaker-playback.cjs');
const { VOICES } = require('../senses/piper-speech-smoke.cjs');
const { getCognitionConfig } = require('../config/model-config.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const CHAT_MODE_STATUS_VERSION = 'floki-v2-chat-mode-status-v1';

const LATEST_REPORTS = Object.freeze({
  hearing_report_file: path.join(ROOT, '.floki-tools', 'output', 'chat-hearing-loop', 'latest-chat-hearing-loop.json'),
  spoken_reply_report_file: path.join(ROOT, '.floki-tools', 'output', 'spoken-reply-once', 'latest-spoken-reply-once.json'),
  loop_report_file: path.join(ROOT, '.floki-tools', 'output', 'chat-mode-loop', 'latest-chat-mode-loop.json')
});

function fileSummary(filePath) {
  if (!fs.existsSync(filePath)) {
    return Object.freeze({
      exists: false,
      path: filePath,
      marker: null,
      ok: null,
      updated_at_ms: null
    });
  }

  const stat = fs.statSync(filePath);
  let parsed = null;

  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    parsed = null;
  }

  return Object.freeze({
    exists: true,
    path: filePath,
    marker: parsed && parsed.marker ? parsed.marker : null,
    ok: parsed && typeof parsed.ok === 'boolean' ? parsed.ok : null,
    updated_at_ms: stat.mtimeMs
  });
}

function jsonSummary(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) {
    return Object.freeze({
      exists: false,
      path: filePath,
      summary: fallback
    });
  }

  try {
    return Object.freeze({
      exists: true,
      path: filePath,
      summary: JSON.parse(fs.readFileSync(filePath, 'utf8'))
    });
  } catch (error) {
    return Object.freeze({
      exists: true,
      path: filePath,
      parse_error: error.message,
      summary: fallback
    });
  }
}

function countJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();

  if (!raw) {
    return 0;
  }

  return raw.split('\n').filter(Boolean).length;
}

function memoryStatus() {
  const base = statePath('chat/memory');
  const shortTerm = path.join(base, 'short-term.jsonl');
  const longTerm = path.join(base, 'long-term.jsonl');
  const emotionalScores = path.join(base, 'emotional-scores.json');
  const reinforcement = path.join(base, 'reinforcement-events.jsonl');
  const consolidation = path.join(base, 'consolidation-log.jsonl');
  const recallContext = path.join(base, 'latest-recall-context.json');

  return Object.freeze({
    base_dir: base,
    short_term_path: shortTerm,
    long_term_path: longTerm,
    emotional_scores_path: emotionalScores,
    reinforcement_path: reinforcement,
    consolidation_path: consolidation,
    recall_context_path: recallContext,
    short_term_count: countJsonl(shortTerm),
    long_term_count: countJsonl(longTerm),
    reinforcement_event_count: countJsonl(reinforcement),
    consolidation_event_count: countJsonl(consolidation)
  });
}

function buildChatModeStatus(options = {}) {
  const toolchain = buildChatToolchainReadinessStatus();
  const cognition = getCognitionConfig();
  const voice = VOICES.large;
  const voiceLock = createVoiceOutputLock({
    lock_file: options.voice_lock_file
  }).isEarsMuted();
  const speakerGuard = speakerPlaybackGuardStatus({});
  const memory = memoryStatus();
  const affectState = jsonSummary(statePath('affect.json'));
  const personalityState = jsonSummary(statePath('personality.json'));
  const identityState = jsonSummary(statePath('identity.json'));
  const latestHearing = fileSummary(LATEST_REPORTS.hearing_report_file);
  const latestSpokenReply = fileSummary(LATEST_REPORTS.spoken_reply_report_file);
  const latestLoop = fileSummary(LATEST_REPORTS.loop_report_file);
  const loopRuntimePid = statePath('chat/runtime/chat-mode-loop.pid');
  const chatModeActive = fs.existsSync(loopRuntimePid);

  const ok = toolchain.ok === true &&
    toolchain.whisper.cli_ready === true &&
    toolchain.vad.package_import_ready === true &&
    toolchain.piper.cli_ready === true &&
    fs.existsSync(voice.model) &&
    fs.existsSync(voice.config);

  return Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_CHAT_MODE_STATUS_PASS' : 'FLOKI_V2_CHAT_MODE_STATUS_FAIL',
    status_version: CHAT_MODE_STATUS_VERSION,
    microphone_readiness: {
      configured_source: CHAT_MODE_LIVING_CONTRACT.senses.ears.source,
      always_listening_expected: true,
      transcribe_all_heard_audio_expected: true,
      reply_only_when_wake_gated: true,
      mic_disabled_only_while_floki_speaks: true,
      mute_while_voice_is_speaking: true,
      toolchain_ready: toolchain.ok === true,
      microphone_recorded_now: false
    },
    vad_readiness: {
      package_import_ready: toolchain.vad.package_import_ready === true,
      vad_audio_analysis_run_now: false
    },
    whisper_readiness: {
      cli_ready: toolchain.whisper.cli_ready === true,
      tiny_en_model_ready: toolchain.whisper.tiny_en_model_ready === true,
      small_en_model_ready: toolchain.whisper.small_en_model_ready === true,
      whisper_transcription_run_now: false
    },
    qwen_cognition: {
      provider: cognition.provider,
      model: cognition.model,
      endpoint: cognition.endpoint,
      schema_constrained_json_required: true,
      qwen_cognition_run_now: false
    },
    broca_ready: {
      required_for_speech: CHAT_MODE_LIVING_CONTRACT.cognition.broca_required_for_user_facing_speech,
      broca_enabled_now: false
    },
    piper_voice: {
      ready: fs.existsSync(voice.model) && fs.existsSync(voice.config),
      size: voice.size,
      name: voice.name,
      model_path: voice.model,
      config_path: voice.config,
      piper_speech_run_now: false
    },
    speaker_playback_guard: {
      ...speakerGuard,
      speaker_playback_run_now: false
    },
    voice_output_lock_state: voiceLock,
    wake_word_config: CHAT_MODE_LIVING_CONTRACT.wake_gate,
    memory_substrate_paths: memory,
    emotion_reinforcement_state_summary: {
      affect_path: affectState.path,
      affect_exists: affectState.exists,
      chat_emotional_scores_path: memory.emotional_scores_path,
      reinforcement_path: memory.reinforcement_path,
      reinforcement_event_count: memory.reinforcement_event_count
    },
    personality_identity_state_summary: {
      personality_path: personalityState.path,
      personality_exists: personalityState.exists,
      identity_path: identityState.path,
      identity_exists: identityState.exists
    },
    latest_reports: {
      hearing: latestHearing,
      spoken_reply: latestSpokenReply,
      loop: latestLoop
    },
    latest_hearing_report: latestHearing.path,
    latest_spoken_reply_report: latestSpokenReply.path,
    latest_loop_report: latestLoop.path,
    chat_mode_active: chatModeActive,
    chat_mode_runtime_pid_file: loopRuntimePid,
    game_mode_explicitly_out_of_scope: true,
    game_mode_started: false,
    minecraft_called: false,
    body_movement_enabled_now: false,
    webcam_opened_now: false,
    chat_mode_only: true
  });
}

function printChatModeStatus() {
  const status = buildChatModeStatus();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printChatModeStatus();
}

module.exports = {
  ROOT,
  CHAT_MODE_STATUS_VERSION,
  LATEST_REPORTS,
  fileSummary,
  memoryStatus,
  buildChatModeStatus,
  printChatModeStatus
};
