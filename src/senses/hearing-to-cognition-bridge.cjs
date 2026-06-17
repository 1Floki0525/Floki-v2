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
const { summarizeAffectForMemory } = require('../brain/affect-state-schema.cjs');
const { statePath } = require('../util/fs-safe.cjs');
const { newId } = require('../util/ids.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const HEARING_LOOP_REPORT = path.join(TOOLS_DIR, 'output', 'chat-hearing-loop', 'latest-chat-hearing-loop.json');
const BRIDGE_OUTPUT_DIR = path.join(TOOLS_DIR, 'output', 'hearing-to-cognition');

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
    broca_enabled_now: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    webcam_opened_now: false,
    yolo_inference_run_now: false,
    chat_mode_only: true,
    reason: allowed
      ? 'Hearing-to-cognition bridge is explicitly allowed for this one proof run.'
      : 'Hearing-to-cognition is guarded. Run npm run proof:hearing-to-cognition to pass latest heard_text into cognition once.'
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function latestHeardText(options = {}) {
  const reportFile = options.report_file || process.env.FLOKI_HEARING_REPORT || HEARING_LOOP_REPORT;

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

function writeBridgeReport(status) {
  fs.mkdirSync(BRIDGE_OUTPUT_DIR, { recursive: true });
  const reportFile = path.join(BRIDGE_OUTPUT_DIR, 'latest-hearing-to-cognition.json');
  fs.writeFileSync(reportFile, JSON.stringify(status, null, 2) + '\n');
  return reportFile;
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
  const recall = hippocampus.recall({
    text: heard.heard_text,
    streams: ['short_term'],
    limit: 5
  });

  const cognition = await frontal.runCognition({
    event,
    understanding: understanding.payload,
    salience: salience.payload,
    affect: affectSummary,
    memories: recall.payload.matches.map((match) => ({
      memory_id: match.record.id,
      summary: match.record.content.summary,
      tags: match.record.tags,
      affect: match.record.affect
    })),
    personality: personalityOut.payload.current,
    identity: identityOut.payload.current
  });

  validateBrainOutput(cognition);

  return Object.freeze({
    event,
    cognition,
    diagnostics_path: diagnosticsPath,
    memory_id: memory.payload.record.id,
    recall_count: recall.payload.matches.length,
    trace_id: unique
  });
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
      broca_enabled_now: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      webcam_opened_now: false,
      yolo_inference_run_now: false,
      chat_mode_only: true
    });

    return Object.freeze({
      ...status,
      report_file: writeBridgeReport(status)
    });
  }

  const bridge = await runCognitionFromHeardText(heard, options);
  const cognition = bridge.cognition;
  const cognitionPayload = cognition.payload || {};
  const cognitionInner = cognitionPayload.cognition || {};

  const ok = cognition.type === 'model_response_summary' &&
    cognition.source === 'frontal' &&
    cognitionPayload.raw_private_reasoning_stored === false &&
    typeof cognitionInner.safe_thought_summary === 'string' &&
    cognitionInner.safe_thought_summary.length > 0;

  const status = Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_HEARING_TO_COGNITION_BRIDGE_PASS' : 'FLOKI_V2_HEARING_TO_COGNITION_BRIDGE_FAIL',
    heard_text: heard.heard_text,
    heard_text_length: heard.heard_text_length,
    heard_word_count: heard.heard_word_count,
    source_report_file: heard.report_file,
    capture_file: heard.capture_file,
    whisper_report_file: heard.whisper_report_file,
    user_event_id: bridge.event.id,
    trace_id: bridge.trace_id,
    diagnostics_path: bridge.diagnostics_path,
    memory_id: bridge.memory_id,
    recall_count: bridge.recall_count,
    cognition_output_id: cognition.id,
    cognition_model: cognitionPayload.model || null,
    cognition_type: cognition.type,
    cognition_source: cognition.source,
    safe_thought_summary: cognitionInner.safe_thought_summary || '',
    felt_interpretation: cognitionInner.felt_interpretation || '',
    response_intent_for_broca: cognitionInner.response_intent_for_broca || '',
    normalized_model_json: cognitionPayload.normalized_model_json === true,
    raw_private_reasoning_stored: cognitionPayload.raw_private_reasoning_stored === true,
    hearing_to_cognition_run_now: true,
    qwen_cognition_run_now: true,
    broca_enabled_now: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    webcam_opened_now: false,
    yolo_inference_run_now: false,
    chat_mode_only: true
  });

  return Object.freeze({
    ...status,
    report_file: writeBridgeReport(status)
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
      marker: 'FLOKI_V2_HEARING_TO_COGNITION_BRIDGE_FAIL',
      error: error.message,
      hearing_to_cognition_run_now: true,
      qwen_cognition_run_now: false,
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
  hearingToCognitionAllowed,
  hearingToCognitionGuardStatus,
  latestHeardText,
  writeBridgeReport,
  runCognitionFromHeardText,
  runHearingToCognitionBridgeProof,
  printHearingToCognitionBridgeProof
};
