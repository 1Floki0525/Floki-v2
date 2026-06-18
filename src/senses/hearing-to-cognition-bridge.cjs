'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { makeUserTextEvent } = require('../brain/brain-event-schema.cjs');
const { validateBrainOutput } = require('../brain/brain-output-schema.cjs');
const { createTemporal } = require('../../brain/temporal/index.cjs');
const { createAmygdala } = require('../../brain/amygdala/index.cjs');
const { createEmotionsBase } = require('../../brain/emotions_base/index.cjs');
const { createHippocampus } = require('../../brain/hippocampus/index.cjs');
const { createPersonality } = require('../../brain/personality/index.cjs');
const { createPineal } = require('../../brain/pineal/index.cjs');
const { createFrontal } = require('../../brain/frontal/index.cjs');
const { createBroca } = require('../../brain/broca/index.cjs');
const { summarizeAffectForMemory } = require('../brain/affect-state-schema.cjs');
const { statePath } = require('../util/fs-safe.cjs');
const { newId } = require('../util/ids.cjs');
const { createChatMemorySubstrate } = require('../chat/chat-memory-substrate.cjs');
const { synthesizePiperSpeechToFile } = require('./piper-speech-smoke.cjs');
const { buildWakeGatedUserText } = require('../chat/wake-word-gate.cjs');
const { createVoiceOutputLock } = require('../chat/voice-output-lock.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const HEARING_LOOP_REPORT = path.join(TOOLS_DIR, 'output', 'chat-hearing-loop', 'latest-chat-hearing-loop.json');
const BRIDGE_OUTPUT_DIR = path.join(TOOLS_DIR, 'output', 'hearing-to-cognition');

function voiceOutputSpeakingNow(options = {}) {
  const lock = createVoiceOutputLock({
    lock_file: options.voice_lock_file
  });

  const local = {};

  if (typeof options.voice_lock_now_ms === 'number') {
    local.now_ms = options.voice_lock_now_ms;
  }

  const ears = lock.isEarsMuted(local);

  return ears.ears_muted_now === true;
}

function hearingToCognitionAllowed(env = process.env) {
  return env.FLOKI_ALLOW_HEARING_TO_COGNITION === '1';
}

function hearingToCognitionGuardStatus(env = process.env) {
  const allowed = hearingToCognitionAllowed(env);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_HEARING_TO_COGNITION_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_HEARING_TO_COGNITION=1',
    hearing_to_cognition_run_now: false,
    qwen_cognition_run_now: false,
    persistent_memory_used: false,
    short_term_memory_written: false,
    long_term_memory_recalled: false,
    emotional_reinforcement_used: false,
    broca_enabled_now: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    webcam_opened_now: false,
    yolo_inference_run_now: false,
    chat_mode_only: true,
    reason: allowed
      ? 'Hearing-to-cognition bridge is explicitly allowed for this one proof run.'
      : 'Hearing-to-cognition is guarded. Run npm run proof:hearing-to-cognition to pass latest heard_text into memory-aware cognition once.'
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function latestHeardText(options = {}) {
  const reportFile = options.hearing_report_file ||
    process.env.FLOKI_HEARING_REPORT ||
    HEARING_LOOP_REPORT;

  if (!fs.existsSync(reportFile)) {
    return Object.freeze({
      ok: false,
      report_file: reportFile,
      reason: 'hearing loop report missing. Run npm run proof:chat-hearing-loop first.'
    });
  }

  let report;

  try {
    report = readJson(reportFile);
  } catch (error) {
    return Object.freeze({
      ok: false,
      report_file: reportFile,
      reason: 'hearing loop report is not valid JSON: ' + error.message
    });
  }

  const heardText = String(report.heard_text || '').trim();

  if (!heardText) {
    return Object.freeze({
      ok: false,
      report_file: reportFile,
      reason: 'hearing loop report has empty heard_text'
    });
  }

  return Object.freeze({
    ok: true,
    report_file: reportFile,
    heard_text: heardText,
    heard_text_length: heardText.length,
    heard_word_count: heardText.split(/\s+/).filter(Boolean).length,
    hearing_loop_marker: report.marker || null,
    capture_file: report.capture && report.capture.output_file ? report.capture.output_file : null,
    whisper_report_file: report.whisper && report.whisper.report_file ? report.whisper.report_file : null
  });
}

function applyWakeGateToHeardText(heard, options = {}) {
  const voiceSpeaking = options.voice_speaking === true ||
    process.env.FLOKI_VOICE_SPEAKING === '1' ||
    voiceOutputSpeakingNow(options);

  const gated = buildWakeGatedUserText({
    text: heard.heard_text,
    modality: options.modality || process.env.FLOKI_WAKE_INPUT_MODALITY || 'spoken',
    source: options.source || process.env.FLOKI_WAKE_INPUT_SOURCE || 'user',
    voice_speaking: voiceSpeaking
  });

  return Object.freeze({
    ok: true,
    marker: gated.marker,
    classification: gated.classification,
    gate_open: gated.classification ? gated.classification.gate_open === true : false,
    direct_request: gated.classification ? gated.classification.direct_request === true : false,
    should_reply: gated.classification ? gated.classification.should_reply === true : false,
    routed_to_cognition: gated.routed_to_cognition === true,
    original_heard_text: heard.heard_text,
    user_text_for_cognition: gated.user_text_for_cognition || '',
    reason: gated.classification ? gated.classification.reason : 'unknown',
    ears_must_be_muted: gated.classification ? gated.classification.ears_must_be_muted === true : false,
    chat_mode_only: true
  });
}

function routedHeardText(heard, gate) {
  const text = String(gate.user_text_for_cognition || '').trim();

  return Object.freeze({
    ...heard,
    original_heard_text: heard.heard_text,
    heard_text: text,
    heard_text_length: text.length,
    heard_word_count: text ? text.split(/\s+/).filter(Boolean).length : 0,
    wake_gate_marker: gate.marker
  });
}

function writeBridgeReport(status, options = {}) {
  if (options.write_report === false) {
    return null;
  }

  const outputDir = options.output_dir || BRIDGE_OUTPUT_DIR;
  const reportFile = options.bridge_report_file ||
    options.report_file ||
    path.join(outputDir, 'latest-hearing-to-cognition.json');

  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(status, null, 2) + '\n');

  return reportFile;
}

function emotionFromAffectSummary(affectSummary) {
  return Object.freeze({
    valence: Number(affectSummary.valence || 0),
    arousal: Number(affectSummary.arousal || 0),
    trust: Number(affectSummary.trust || 0),
    fear: Number(affectSummary.fear || 0),
    curiosity: Number(affectSummary.curiosity || 0),
    hope: Number(affectSummary.hope || 0),
    confidence: Number(affectSummary.confidence || 0),
    frustration: Number(affectSummary.frustration || 0),
    attachment: Number(affectSummary.attachment || 0),
    uncertainty: Number(affectSummary.uncertainty || 0)
  });
}

function summarizePersistentMemoryForCognition(recallContext) {
  const shortTerm = Array.isArray(recallContext.short_term_matches)
    ? recallContext.short_term_matches
    : [];

  const longTerm = Array.isArray(recallContext.long_term_matches)
    ? recallContext.long_term_matches
    : [];

  function compact(match) {
    const memory = match.memory || match;

    return {
      memory_id: memory.id,
      stream: memory.stream,
      category: memory.category,
      summary: memory.summary || memory.text || '',
      tags: Array.isArray(memory.tags) ? memory.tags : [],
      emotion: memory.emotion || {},
      reinforcement_score: Number(memory.reinforcement_score || 0),
      score: Number(match.score || 0)
    };
  }

  return Object.freeze({
    substrate_version: recallContext.substrate_version,
    short_term: shortTerm.map(compact).slice(0, 6),
    long_term: longTerm.map(compact).slice(0, 6),
    emotional_state: recallContext.emotional_state || {},
    recall_ready_for_cognition: recallContext.recall_ready_for_cognition === true
  });
}

function buildPersistentMemoryContext(heard, affectSummary, options = {}) {
  const substrate = createChatMemorySubstrate({
    base_dir: options.memory_base_dir
  });

  substrate.ensureReady();

  const emotion = emotionFromAffectSummary(affectSummary);

  const shortMemory = substrate.rememberShortTerm({
    text: heard.heard_text,
    summary: 'User addressed Floki in chat: ' + heard.heard_text,
    tags: ['chat', 'hearing', 'whisper_transcript', 'hearing_to_cognition', 'user_utterance'],
    importance: Number(options.importance || 0.78),
    emotion,
    category: 'relationship_history',
    source: 'chat_hearing_loop'
  });

  const reinforcement = substrate.reinforce({
    target_type: 'conversation_habit',
    target_key: 'respond_when_addressed_by_wake_phrase',
    signal: Number(options.reinforcement_signal || 0.2),
    reason: 'A heard chat utterance should reinforce careful response when Floki is addressed.',
    emotion
  });

  const consolidation = substrate.consolidate({
    min_importance: Number(options.min_consolidation_importance || 0.7)
  });

  const recallContext = substrate.recallContext({
    text: heard.heard_text,
    limit: Number(options.recall_limit || 8)
  });

  return Object.freeze({
    substrate,
    short_memory: shortMemory,
    reinforcement: reinforcement.event,
    reinforcement_state: reinforcement.emotional_state,
    consolidation,
    recall_context: recallContext,
    cognition_memory_context: summarizePersistentMemoryForCognition(recallContext)
  });
}

async function runCognitionFromHeardText(heard, options = {}) {
  const unique = newId('hear_cog').replace(/[^a-z0-9_]/g, '_');
  const diagnosticsPath = statePath('test/hearing-to-cognition/' + unique + '/diagnostics.jsonl');

  const event = makeUserTextEvent(heard.heard_text, {
    trace_id: unique,
    notes: 'Chat-mode microphone transcript from guarded chat hearing loop.'
  });

  const temporal = createTemporal({ diagnostics_path: diagnosticsPath });
  const amygdala = createAmygdala({ diagnostics_path: diagnosticsPath });
  const emotions = createEmotionsBase({
    affect_path: statePath('test/hearing-to-cognition/' + unique + '/affect.json'),
    diagnostics_path: diagnosticsPath
  });
  const hippocampus = createHippocampus({
    memory_paths: {
      short_term: statePath('test/hearing-to-cognition/' + unique + '/short-term.jsonl'),
      episodic: statePath('test/hearing-to-cognition/' + unique + '/episodic.jsonl'),
      semantic: statePath('test/hearing-to-cognition/' + unique + '/semantic.jsonl'),
      autobiographical: statePath('test/hearing-to-cognition/' + unique + '/autobiographical.jsonl')
    },
    diagnostics_path: diagnosticsPath
  });
  const personality = createPersonality({
    personality_path: statePath('test/hearing-to-cognition/' + unique + '/personality.json'),
    diagnostics_path: diagnosticsPath
  });
  const pineal = createPineal({
    identity_path: statePath('test/hearing-to-cognition/' + unique + '/identity.json'),
    diagnostics_path: diagnosticsPath
  });
  const frontal = createFrontal({ diagnostics_path: diagnosticsPath });

  const understanding = temporal.understandEvent(event);
  const salience = amygdala.computeSalience(event);
  const affectDelta = emotions.affectDeltaFromSalience(salience);
  const affect = emotions.applyAffectDelta(affectDelta);
  const affectSummary = summarizeAffectForMemory(affect.payload.state);

  const persistentMemory = buildPersistentMemoryContext(heard, affectSummary, options);

  const memory = hippocampus.rememberEvent(event, {
    stream: 'short_term',
    type: 'experience',
    tags: ['chat', 'hearing', 'microphone', 'whisper_transcript', 'hearing_to_cognition'],
    importance: salience.payload.salience.memory_importance_hint,
    affect: {
      valence: affectSummary.valence,
      arousal: affectSummary.arousal
    }
  });

  const personalityOut = personality.updateFromMemory(memory.payload.record);
  const identityOut = pineal.updateFromMemory(memory.payload.record, personalityOut.payload.current);

  const cognitionMemories = persistentMemory.cognition_memory_context.short_term
    .concat(persistentMemory.cognition_memory_context.long_term)
    .slice(0, 10)
    .map((memoryRecord) => ({
      memory_id: memoryRecord.memory_id,
      stream: memoryRecord.stream,
      category: memoryRecord.category,
      summary: memoryRecord.summary,
      tags: memoryRecord.tags,
      affect: memoryRecord.emotion,
      reinforcement_score: memoryRecord.reinforcement_score
    }));

  const cognition = await frontal.runCognition({
    event,
    understanding: understanding.payload,
    salience: salience.payload,
    affect: affectSummary,
    memories: cognitionMemories,
    persistent_chat_memory: persistentMemory.cognition_memory_context,
    emotional_reinforcement: {
      event: persistentMemory.reinforcement,
      state: persistentMemory.reinforcement_state
    },
    personality: personalityOut.payload.current,
    identity: identityOut.payload.current
  });

  validateBrainOutput(cognition);

  return Object.freeze({
    event,
    cognition,
    diagnostics_path: diagnosticsPath,
    memory_id: memory.payload.record.id,
    persistent_short_memory_id: persistentMemory.short_memory.id,
    persistent_reinforcement_target: persistentMemory.reinforcement.target_id,
    persistent_reinforcement_score: persistentMemory.reinforcement.resulting_score,
    persistent_consolidation_promoted_count: persistentMemory.consolidation.promoted_count,
    persistent_short_recall_count: persistentMemory.cognition_memory_context.short_term.length,
    persistent_long_recall_count: persistentMemory.cognition_memory_context.long_term.length,
    persistent_memory_context: persistentMemory.cognition_memory_context,
    trace_id: unique
  });
}

function runBrocaFromCognition(cognition, bridge, options = {}) {
  const diagnosticsPath = bridge && bridge.diagnostics_path ? bridge.diagnostics_path : undefined;
  const broca = createBroca({
    diagnostics_path: diagnosticsPath,
    persist_diagnostics: options.persist_broca_diagnostics !== false
  });

  const speech = broca.speakFromCognition(cognition, {
    parent_event_ids: bridge && bridge.event && bridge.event.id ? [bridge.event.id] : [],
    include_chat_truth: options.include_chat_truth === true,
    include_stage_truth: false,
    tone: 'plain',
    audience: 'user'
  });

  validateBrainOutput(speech);

  return speech;
}

function runPiperWavFromBroca(brocaOutput, options = {}) {
  if (!brocaOutput || brocaOutput.type !== 'speech' || brocaOutput.source !== 'broca') {
    throw new Error('Piper WAV synthesis requires a Broca speech output');
  }

  const text = brocaOutput.payload && typeof brocaOutput.payload.text === 'string'
    ? brocaOutput.payload.text.trim()
    : '';

  if (!text) {
    throw new Error('Piper WAV synthesis requires non-empty Broca text');
  }

  const synthesizer = options.piper_synthesizer || synthesizePiperSpeechToFile;
  const piperOutputDir = options.piper_output_dir || path.join(TOOLS_DIR, 'output', 'hearing-to-piper-wav');

  const speech = synthesizer({
    voice_size: options.voice_size || 'large',
    text,
    output_dir: piperOutputDir
  });

  if (!speech || speech.ok !== true) {
    throw new Error('Piper WAV synthesis failed');
  }

  if (speech.speaker_playback_run_now === true) {
    throw new Error('Piper WAV stage must not play speaker audio');
  }

  if (speech.piper_speech_run_now !== true) {
    throw new Error('Piper WAV stage did not run Piper synthesis');
  }

  return Object.freeze(speech);
}

async function runHearingToCognitionBridgeProof(options = {}) {
  const guard = hearingToCognitionGuardStatus(options.env || process.env);

  if (!guard.allowed_now) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_HEARING_TO_COGNITION_BLOCKED',
      guard,
      hearing_to_cognition_run_now: false,
      qwen_cognition_run_now: false,
      persistent_memory_used: false,
      short_term_memory_written: false,
      long_term_memory_recalled: false,
      emotional_reinforcement_used: false,
      broca_enabled_now: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      webcam_opened_now: false,
      yolo_inference_run_now: false,
      chat_mode_only: true
    });
  }

  const heard = latestHeardText(options);

  if (!heard.ok) {
    const status = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_HEARING_TO_COGNITION_FAIL',
      reason: heard.reason,
      heard,
      hearing_to_cognition_run_now: true,
      qwen_cognition_run_now: false,
      persistent_memory_used: false,
      short_term_memory_written: false,
      long_term_memory_recalled: false,
      emotional_reinforcement_used: false,
      broca_enabled_now: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      webcam_opened_now: false,
      yolo_inference_run_now: false,
      chat_mode_only: true
    });

    return Object.freeze({
      ...status,
      report_file: writeBridgeReport(status, options)
    });
  }

  const wakeGate = applyWakeGateToHeardText(heard, options);

  if (!wakeGate.routed_to_cognition) {
    const status = Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_WAKE_GATED_HEARING_TO_COGNITION_IGNORED',
      heard_text: heard.heard_text,
      heard_text_length: heard.heard_text_length,
      heard_word_count: heard.heard_word_count,
      source_report_file: heard.report_file,
      capture_file: heard.capture_file,
      whisper_report_file: heard.whisper_report_file,
      wake_gate_marker: wakeGate.marker,
      wake_gate_open: wakeGate.gate_open,
      wake_direct_request: wakeGate.direct_request,
      wake_should_reply: wakeGate.should_reply,
      wake_reason: wakeGate.reason,
      ears_must_be_muted: wakeGate.ears_must_be_muted,
      hearing_to_cognition_run_now: true,
      qwen_cognition_run_now: false,
      persistent_memory_used: false,
      short_term_memory_written: false,
      long_term_memory_recalled: false,
      emotional_reinforcement_used: false,
      broca_enabled_now: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      webcam_opened_now: false,
      yolo_inference_run_now: false,
      chat_mode_only: true
    });

    return Object.freeze({
      ...status,
      report_file: writeBridgeReport(status, options)
    });
  }

  const heardForCognition = routedHeardText(heard, wakeGate);
  const bridge = await runCognitionFromHeardText(heardForCognition, options);
  const cognition = bridge.cognition;
  const cognitionPayload = cognition.payload || {};
  const cognitionInner = cognitionPayload.cognition || {};
  const cognitionFailure = cognition.failure || {};

  const cognitionOk = cognition.type === 'model_response_summary' &&
    cognition.source === 'frontal' &&
    cognitionPayload.raw_private_reasoning_stored === false &&
    cognitionPayload.normalized_model_json === true &&
    cognitionPayload.schema_constrained_json === true &&
    cognitionPayload.model_json_fallback_used !== true &&
    typeof cognitionInner.safe_thought_summary === 'string' &&
    cognitionInner.safe_thought_summary.length > 0 &&
    bridge.persistent_short_recall_count >= 1 &&
    bridge.persistent_long_recall_count >= 1 &&
    bridge.persistent_reinforcement_target.length > 0;

  let brocaOutput = null;

  if (cognitionOk) {
    brocaOutput = runBrocaFromCognition(cognition, bridge, options);
  }

  const brocaPayload = brocaOutput && brocaOutput.payload ? brocaOutput.payload : {};
  const brocaFailure = brocaOutput && brocaOutput.failure ? brocaOutput.failure : {};

  const brocaOk = brocaOutput &&
    brocaOutput.type === 'speech' &&
    brocaOutput.source === 'broca' &&
    typeof brocaPayload.text === 'string' &&
    brocaPayload.text.trim().length > 0;

  let piperWav = null;

  if (brocaOk) {
    piperWav = runPiperWavFromBroca(brocaOutput, options);
  }

  const piperWavOk = piperWav &&
    piperWav.ok === true &&
    piperWav.piper_speech_run_now === true &&
    piperWav.speaker_playback_run_now === false &&
    typeof piperWav.output_file === 'string' &&
    piperWav.output_file.length > 0 &&
    Number(piperWav.output_size_bytes || 0) > 44;

  const ok = cognitionOk && brocaOk && piperWavOk;

  const status = Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_WAKE_GATED_MEMORY_AWARE_HEARING_TO_PIPER_WAV_PASS' : 'FLOKI_V2_WAKE_GATED_MEMORY_AWARE_HEARING_TO_PIPER_WAV_FAIL',
    original_heard_text: heard.heard_text,
    heard_text: heardForCognition.heard_text,
    wake_gate_marker: wakeGate.marker,
    wake_gate_open: wakeGate.gate_open,
    wake_routed_to_cognition: wakeGate.routed_to_cognition,
    wake_request_text: wakeGate.user_text_for_cognition,
    heard_text_length: heardForCognition.heard_text_length,
    heard_word_count: heardForCognition.heard_word_count,
    source_report_file: heard.report_file,
    capture_file: heard.capture_file,
    whisper_report_file: heard.whisper_report_file,
    user_event_id: bridge.event.id,
    trace_id: bridge.trace_id,
    diagnostics_path: bridge.diagnostics_path,
    memory_id: bridge.memory_id,
    persistent_short_memory_id: bridge.persistent_short_memory_id,
    persistent_reinforcement_target: bridge.persistent_reinforcement_target,
    persistent_reinforcement_score: bridge.persistent_reinforcement_score,
    persistent_consolidation_promoted_count: bridge.persistent_consolidation_promoted_count,
    persistent_short_recall_count: bridge.persistent_short_recall_count,
    persistent_long_recall_count: bridge.persistent_long_recall_count,
    cognition_output_id: cognition.id,
    cognition_model: cognitionPayload.model || null,
    cognition_type: cognition.type,
    cognition_source: cognition.source,
    cognition_failure_code: cognitionFailure.code || null,
    cognition_failure_message: cognitionFailure.message || null,
    cognition_failure_recoverable: typeof cognitionFailure.recoverable === 'boolean' ? cognitionFailure.recoverable : null,
    safe_thought_summary: cognitionInner.safe_thought_summary || '',
    felt_interpretation: cognitionInner.felt_interpretation || '',
    response_intent_for_broca: cognitionInner.response_intent_for_broca || '',
    broca_output_id: brocaOutput && brocaOutput.id ? brocaOutput.id : null,
    broca_output_type: brocaOutput && brocaOutput.type ? brocaOutput.type : null,
    broca_output_source: brocaOutput && brocaOutput.source ? brocaOutput.source : null,
    broca_text_response: brocaPayload.text || '',
    piper_wav_output_file: piperWav && piperWav.output_file ? piperWav.output_file : null,
    piper_wav_output_ready: piperWav ? piperWav.output_ready === true : false,
    piper_wav_output_size_bytes: piperWav ? Number(piperWav.output_size_bytes || 0) : 0,
    piper_voice_size: piperWav && piperWav.voice_size ? piperWav.voice_size : null,
    piper_voice_name: piperWav && piperWav.voice_name ? piperWav.voice_name : null,
    broca_failure_code: brocaFailure.code || null,
    broca_failure_message: brocaFailure.message || null,
    normalized_model_json: cognitionPayload.normalized_model_json === true,
    schema_constrained_json: cognitionPayload.schema_constrained_json === true,
    json_retry_used: cognitionPayload.json_retry_used === true,
    json_retry_first_error: cognitionPayload.json_retry_first_error || null,
    model_json_fallback_used: false,
    model_json_fallback_reason: null,
    raw_private_reasoning_stored: cognitionPayload.raw_private_reasoning_stored === true,
    hearing_to_cognition_run_now: true,
    qwen_cognition_run_now: true,
    frontal_failure_exposed: cognition.type === 'failure',
    persistent_memory_used: true,
    short_term_memory_written: true,
    long_term_memory_recalled: bridge.persistent_long_recall_count >= 1,
    emotional_reinforcement_used: true,
    broca_enabled_now: brocaOk === true,
    broca_text_response_created_now: brocaOk === true,
    piper_speech_run_now: piperWav !== null,
    piper_wav_created_now: piperWavOk === true,
    speaker_playback_run_now: false,
    webcam_opened_now: false,
    yolo_inference_run_now: false,
    chat_mode_only: true
  });

  return Object.freeze({
    ...status,
    report_file: writeBridgeReport(status, options)
  });
}

async function printHearingToCognitionBridgeProof() {
  const status = await runHearingToCognitionBridgeProof();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printHearingToCognitionBridgeProof().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_MEMORY_AWARE_HEARING_TO_COGNITION_FAIL',
      error: error.message,
      hearing_to_cognition_run_now: true,
      qwen_cognition_run_now: false,
      persistent_memory_used: false,
      short_term_memory_written: false,
      long_term_memory_recalled: false,
      emotional_reinforcement_used: false,
      broca_enabled_now: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      webcam_opened_now: false,
      yolo_inference_run_now: false,
      chat_mode_only: true
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  ROOT,
  TOOLS_DIR,
  HEARING_LOOP_REPORT,
  BRIDGE_OUTPUT_DIR,
  voiceOutputSpeakingNow,
  hearingToCognitionAllowed,
  hearingToCognitionGuardStatus,
  latestHeardText,
  routedHeardText,
  applyWakeGateToHeardText,
  writeBridgeReport,
  emotionFromAffectSummary,
  summarizePersistentMemoryForCognition,
  buildPersistentMemoryContext,
  runCognitionFromHeardText,
  runBrocaFromCognition,
  runPiperWavFromBroca,
  runHearingToCognitionBridgeProof,
  printHearingToCognitionBridgeProof
};
