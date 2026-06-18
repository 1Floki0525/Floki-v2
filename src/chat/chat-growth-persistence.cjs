'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { statePath, ensureParentDirSync } = require('../util/fs-safe.cjs');
const { newId } = require('../util/ids.cjs');
const { runWhisperTranscriptionProof } = require('../senses/whisper-transcription-smoke.cjs');
const { runHearingToCognitionBridgeProof } = require('../senses/hearing-to-cognition-bridge.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const CHAT_GROWTH_OUTPUT_DIR = path.join(TOOLS_DIR, 'output', 'chat-growth-persistence');
const KNOWN_WAKE_AUDIO_FIXTURE = path.join(
  TOOLS_DIR,
  'input',
  'microphone-smoke',
  'microphone_smoke_20260617204048.wav'
);

function chatGrowthPersistenceAllowed(env = process.env) {
  return env.FLOKI_ALLOW_CHAT_GROWTH_PERSISTENCE === '1';
}

function chatGrowthPersistenceGuardStatus(env = process.env) {
  const allowed = chatGrowthPersistenceAllowed(env);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_CHAT_GROWTH_PERSISTENCE=1',
    chat_growth_persistence_run_now: false,
    whisper_transcription_run_now: false,
    wake_gate_checked_now: false,
    qwen_cognition_run_now: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    persistent_memory_used: false,
    short_term_memory_written: false,
    long_term_memory_recalled: false,
    emotional_reinforcement_used: false,
    personality_identity_persisted: false,
    chat_mode_only: true,
    reason: allowed
      ? 'Chat growth persistence proof is explicitly allowed for this one proof run.'
      : 'Chat growth persistence is guarded. Run npm run proof:chat-growth-persistence to prove persistent chat growth once.'
  });
}

function fileHash(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function countJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  return raw ? raw.split('\n').filter(Boolean).length : 0;
}

function fileSummary(filePath) {
  if (!fs.existsSync(filePath)) {
    return Object.freeze({
      exists: false,
      path: filePath,
      size_bytes: 0,
      hash: null
    });
  }

  const stat = fs.statSync(filePath);

  return Object.freeze({
    exists: true,
    path: filePath,
    size_bytes: stat.size,
    mtime_ms: stat.mtimeMs,
    hash: fileHash(filePath)
  });
}

function growthStatePaths(options = {}) {
  const memoryBase = options.memory_base_dir || statePath('chat/memory');
  const brainBase = options.brain_state_base_dir || null;

  return Object.freeze({
    memory_base_dir: memoryBase,
    short_term_path: path.join(memoryBase, 'short-term.jsonl'),
    long_term_path: path.join(memoryBase, 'long-term.jsonl'),
    reinforcement_path: path.join(memoryBase, 'reinforcement-events.jsonl'),
    consolidation_path: path.join(memoryBase, 'consolidation-log.jsonl'),
    recall_context_path: path.join(memoryBase, 'latest-recall-context.json'),
    affect_path: options.affect_path || (brainBase ? path.join(brainBase, 'affect.json') : statePath('affect.json')),
    personality_path: options.personality_path || (brainBase ? path.join(brainBase, 'personality.json') : statePath('personality.json')),
    identity_path: options.identity_path || (brainBase ? path.join(brainBase, 'identity.json') : statePath('identity.json')),
    diagnostics_path: options.diagnostics_path || (brainBase ? path.join(brainBase, 'diagnostics.jsonl') : statePath('diagnostics.jsonl')),
    state_scope: brainBase ? 'isolated_contract_state' : 'persistent_chat_state'
  });
}

function snapshotGrowthState(options = {}) {
  const paths = growthStatePaths(options);

  return Object.freeze({
    paths,
    short_term_count: countJsonl(paths.short_term_path),
    long_term_count: countJsonl(paths.long_term_path),
    reinforcement_event_count: countJsonl(paths.reinforcement_path),
    consolidation_event_count: countJsonl(paths.consolidation_path),
    recall_context_file: fileSummary(paths.recall_context_path),
    affect_file: fileSummary(paths.affect_path),
    personality_file: fileSummary(paths.personality_path),
    identity_file: fileSummary(paths.identity_path)
  });
}

function writeJsonReport(filePath, value) {
  ensureParentDirSync(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
  return filePath;
}

function makeHearingReportFromWhisper(whisper, options = {}) {
  const heardText = String(whisper.transcription_text || '').trim();
  const hearingReportFile = options.generated_hearing_report_file ||
    path.join(CHAT_GROWTH_OUTPUT_DIR, 'latest-chat-growth-hearing.json');

  const status = Object.freeze({
    ok: whisper.ok === true && heardText.length > 0,
    marker: whisper.ok === true && heardText.length > 0
      ? 'FLOKI_V2_CHAT_GROWTH_HEARING_FROM_REAL_WHISPER_PASS'
      : 'FLOKI_V2_CHAT_GROWTH_HEARING_FROM_REAL_WHISPER_FAIL',
    heard_text: heardText,
    heard_text_length: heardText.length,
    heard_word_count: heardText ? heardText.split(/\s+/).filter(Boolean).length : 0,
    capture: {
      output_file: whisper.input_file,
      output_ready: fs.existsSync(whisper.input_file || ''),
      output_size_bytes: Number(whisper.input_size_bytes || 0),
      microphone_recorded_now: false,
      microphone_capture_replay_used: true,
      real_microphone_capture_file: true
    },
    whisper: {
      marker: whisper.marker,
      report_file: whisper.report_file,
      input_file: whisper.input_file,
      model_size: whisper.model_size,
      model_file: whisper.model_file,
      transcription_text: heardText,
      whisper_transcription_run_now: whisper.whisper_transcription_run_now === true
    },
    real_whisper_transcription_used: whisper.whisper_transcription_run_now === true,
    microphone_recorded_now: false,
    chat_mode_only: true
  });

  return Object.freeze({
    ...status,
    report_file: writeJsonReport(hearingReportFile, status)
  });
}

function resolveHearingReport(options = {}) {
  const explicitReport = options.hearing_report_file ||
    process.env.FLOKI_CHAT_GROWTH_HEARING_REPORT ||
    null;

  if (explicitReport) {
    return Object.freeze({
      ok: fs.existsSync(explicitReport),
      marker: fs.existsSync(explicitReport)
        ? 'FLOKI_V2_CHAT_GROWTH_EXISTING_HEARING_REPORT_READY'
        : 'FLOKI_V2_CHAT_GROWTH_EXISTING_HEARING_REPORT_MISSING',
      hearing_report_file: explicitReport,
      whisper_report_file: null,
      capture_file: null,
      whisper_transcription_run_now: false,
      real_whisper_transcription_used: false,
      reason: fs.existsSync(explicitReport) ? null : 'explicit hearing report missing'
    });
  }

  const fixture = options.audio_fixture ||
    process.env.FLOKI_CHAT_GROWTH_AUDIO_FIXTURE ||
    KNOWN_WAKE_AUDIO_FIXTURE;

  if (!fs.existsSync(fixture)) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_CHAT_GROWTH_AUDIO_FIXTURE_MISSING',
      reason: 'known wake-gated audio fixture is missing',
      fixture_file: fixture,
      whisper_transcription_run_now: false,
      real_whisper_transcription_used: false
    });
  }

  const whisper = runWhisperTranscriptionProof({
    env: {
      ...process.env,
      FLOKI_ALLOW_WHISPER_TRANSCRIPTION: '1'
    },
    input_file: fixture,
    report_file: options.whisper_report_file || path.join(CHAT_GROWTH_OUTPUT_DIR, 'latest-chat-growth-whisper.json')
  });

  if (!whisper.ok) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_CHAT_GROWTH_WHISPER_FAIL',
      reason: 'real Whisper transcription failed for growth audio fixture',
      fixture_file: fixture,
      whisper,
      whisper_transcription_run_now: whisper.whisper_transcription_run_now === true,
      real_whisper_transcription_used: whisper.whisper_transcription_run_now === true
    });
  }

  const hearing = makeHearingReportFromWhisper(whisper, options);

  return Object.freeze({
    ok: hearing.ok,
    marker: hearing.marker,
    hearing_report_file: hearing.report_file,
    whisper_report_file: whisper.report_file,
    capture_file: fixture,
    heard_text: hearing.heard_text,
    whisper_transcription_run_now: whisper.whisper_transcription_run_now === true,
    real_whisper_transcription_used: true,
    reason: hearing.ok ? null : 'hearing report from Whisper was not usable'
  });
}

async function runChatGrowthPersistenceProof(options = {}) {
  const guard = chatGrowthPersistenceGuardStatus(options.env || process.env);

  if (!guard.allowed_now) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_BLOCKED',
      guard,
      chat_growth_persistence_run_now: false,
      whisper_transcription_run_now: false,
      wake_gate_checked_now: false,
      qwen_cognition_run_now: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      persistent_memory_used: false,
      short_term_memory_written: false,
      long_term_memory_recalled: false,
      emotional_reinforcement_used: false,
      personality_identity_persisted: false,
      chat_mode_only: true
    });
  }

  const before = snapshotGrowthState(options);
  const hearing = resolveHearingReport(options);

  if (!hearing.ok) {
    const status = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_FAIL',
      reason: hearing.reason,
      hearing,
      before,
      chat_growth_persistence_run_now: true,
      whisper_transcription_run_now: hearing.whisper_transcription_run_now === true,
      wake_gate_checked_now: false,
      qwen_cognition_run_now: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      persistent_memory_used: false,
      short_term_memory_written: false,
      long_term_memory_recalled: false,
      emotional_reinforcement_used: false,
      personality_identity_persisted: false,
      chat_mode_only: true
    });

    return Object.freeze({
      ...status,
      report_file: options.write_report === false
        ? null
        : writeJsonReport(options.report_file || path.join(CHAT_GROWTH_OUTPUT_DIR, 'latest-chat-growth-persistence.json'), status)
    });
  }

  const bridge = await runHearingToCognitionBridgeProof({
    env: {
      ...process.env,
      FLOKI_ALLOW_HEARING_TO_COGNITION: '1'
    },
    hearing_report_file: hearing.hearing_report_file,
    bridge_report_file: options.bridge_report_file || path.join(CHAT_GROWTH_OUTPUT_DIR, 'latest-chat-growth-bridge.json'),
    memory_base_dir: before.paths.memory_base_dir,
    brain_state_base_dir: options.brain_state_base_dir,
    affect_path: before.paths.affect_path,
    personality_path: before.paths.personality_path,
    identity_path: before.paths.identity_path,
    diagnostics_path: before.paths.diagnostics_path,
    piper_output_dir: options.piper_output_dir || path.join(CHAT_GROWTH_OUTPUT_DIR, 'piper-wav'),
    write_report: options.write_bridge_report !== false,
    modality: options.modality || 'spoken',
    source: options.source || 'user'
  });

  const after = snapshotGrowthState(options);
  const persistentState = before.paths.state_scope === 'persistent_chat_state';
  const shortTermWritten = after.short_term_count > before.short_term_count;
  const reinforcementWritten = after.reinforcement_event_count > before.reinforcement_event_count;
  const consolidationWritten = after.consolidation_event_count > before.consolidation_event_count;
  const longTermAvailable = bridge.long_term_memory_recalled === true && after.long_term_count >= before.long_term_count;
  const affectPersisted = after.affect_file.exists === true && after.affect_file.hash !== before.affect_file.hash;
  const personalityPersisted = after.personality_file.exists === true && after.personality_file.hash !== before.personality_file.hash;
  const identityPersisted = after.identity_file.exists === true && after.identity_file.hash !== before.identity_file.hash;
  const personalityIdentityPersisted = personalityPersisted && identityPersisted;

  const ok = bridge.ok === true &&
    bridge.wake_routed_to_cognition === true &&
    bridge.qwen_cognition_run_now === true &&
    bridge.schema_constrained_json === true &&
    bridge.model_json_fallback_used === false &&
    bridge.persistent_memory_used === true &&
    shortTermWritten &&
    longTermAvailable &&
    reinforcementWritten &&
    consolidationWritten &&
    affectPersisted &&
    personalityIdentityPersisted &&
    bridge.broca_enabled_now === true &&
    bridge.piper_wav_created_now === true &&
    bridge.speaker_playback_run_now === false;

  const status = Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_PASS' : 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_FAIL',
    contract_marker: ok ? 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_CONTRACT_PASS' : 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_CONTRACT_FAIL',
    hearing,
    bridge_report_file: bridge.report_file,
    capture_file: hearing.capture_file || bridge.capture_file || null,
    whisper_report_file: hearing.whisper_report_file || bridge.whisper_report_file || null,
    hearing_report_file: hearing.hearing_report_file,
    piper_wav_output_file: bridge.piper_wav_output_file || null,
    spoken_reply_report_file: null,
    before,
    after,
    persistent_chat_memory_path: before.paths.memory_base_dir,
    persistent_affect_path: before.paths.affect_path,
    persistent_personality_path: before.paths.personality_path,
    persistent_identity_path: before.paths.identity_path,
    persistent_paths_used: persistentState,
    state_scope: before.paths.state_scope,
    original_heard_text: bridge.original_heard_text || '',
    wake_request_text: bridge.wake_request_text || '',
    wake_gate_checked_now: true,
    wake_routed_to_cognition: bridge.wake_routed_to_cognition === true,
    qwen_cognition_run_now: bridge.qwen_cognition_run_now === true,
    schema_constrained_json: bridge.schema_constrained_json === true,
    model_json_fallback_used: bridge.model_json_fallback_used === true,
    persistent_memory_used: bridge.persistent_memory_used === true,
    short_term_memory_written: shortTermWritten,
    long_term_memory_recalled: longTermAvailable,
    emotional_reinforcement_used: bridge.emotional_reinforcement_used === true && reinforcementWritten,
    consolidation_promoted_memory: consolidationWritten,
    persistent_consolidation_promoted_count: bridge.persistent_consolidation_promoted_count,
    persistent_short_recall_count: bridge.persistent_short_recall_count,
    persistent_long_recall_count: bridge.persistent_long_recall_count,
    emotional_reinforcement_target: bridge.persistent_reinforcement_target,
    emotional_reinforcement_score: bridge.persistent_reinforcement_score,
    affect_state_persisted: affectPersisted,
    personality_state_persisted: personalityPersisted,
    identity_state_persisted: identityPersisted,
    personality_identity_persisted: personalityIdentityPersisted,
    broca_enabled_now: bridge.broca_enabled_now === true,
    piper_speech_run_now: bridge.piper_speech_run_now === true,
    piper_wav_created_now: bridge.piper_wav_created_now === true,
    speaker_playback_run_now: false,
    whisper_transcription_run_now: hearing.whisper_transcription_run_now === true,
    real_whisper_transcription_used: hearing.real_whisper_transcription_used === true,
    microphone_recorded_now: false,
    chat_growth_persistence_run_now: true,
    chat_mode_only: true,
    game_mode_started: false
  });

  return Object.freeze({
    ...status,
    report_file: options.write_report === false
      ? null
      : writeJsonReport(options.report_file || path.join(CHAT_GROWTH_OUTPUT_DIR, 'latest-chat-growth-persistence.json'), status)
  });
}

async function printChatGrowthPersistenceProof() {
  const status = await runChatGrowthPersistenceProof();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printChatGrowthPersistenceProof().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_FAIL',
      error: error.message,
      chat_growth_persistence_run_now: true,
      qwen_cognition_run_now: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      chat_mode_only: true
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  ROOT,
  TOOLS_DIR,
  CHAT_GROWTH_OUTPUT_DIR,
  KNOWN_WAKE_AUDIO_FIXTURE,
  chatGrowthPersistenceAllowed,
  chatGrowthPersistenceGuardStatus,
  countJsonl,
  fileSummary,
  growthStatePaths,
  snapshotGrowthState,
  makeHearingReportFromWhisper,
  resolveHearingReport,
  runChatGrowthPersistenceProof,
  printChatGrowthPersistenceProof
};
