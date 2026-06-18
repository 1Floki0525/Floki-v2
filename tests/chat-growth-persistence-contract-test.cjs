'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  runChatGrowthPersistenceProof
} = require('../src/chat/chat-growth-persistence.cjs');

function writeFakeWakeHearingReport(baseDir) {
  ensureDirSync(baseDir);

  const heardText = 'Hey Floki, remember that trust and hope should shape how you grow with me.';
  const reportFile = path.join(baseDir, 'wake-hearing-report.json');

  fs.writeFileSync(reportFile, JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_HEARING_LOOP_PASS',
    heard_text: heardText,
    heard_text_length: heardText.length,
    heard_word_count: heardText.split(/\s+/).filter(Boolean).length,
    capture: {
      output_file: path.join(baseDir, 'contract-boundary.wav'),
      microphone_recorded_now: false
    },
    whisper: {
      report_file: path.join(baseDir, 'contract-boundary-whisper.json'),
      whisper_transcription_run_now: false
    },
    contract_boundary_input: true,
    chat_mode_only: true
  }, null, 2) + '\n');

  return reportFile;
}

async function run() {
  const unique = newId('chat_growth_contract').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/chat-growth-persistence/' + unique);
  const memoryBaseDir = path.join(baseDir, 'chat-memory');
  const brainStateBaseDir = path.join(baseDir, 'brain-state');
  const hearingReportFile = writeFakeWakeHearingReport(baseDir);

  const proof = await runChatGrowthPersistenceProof({
    env: {
      FLOKI_ALLOW_CHAT_GROWTH_PERSISTENCE: '1'
    },
    hearing_report_file: hearingReportFile,
    memory_base_dir: memoryBaseDir,
    brain_state_base_dir: brainStateBaseDir,
    report_file: path.join(baseDir, 'growth-report.json'),
    bridge_report_file: path.join(baseDir, 'bridge-report.json'),
    piper_output_dir: path.join(baseDir, 'piper-wav')
  });

  assert.equal(proof.ok, true);
  assert.equal(proof.marker, 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_PASS');
  assert.equal(proof.contract_marker, 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_CONTRACT_PASS');
  assert.equal(proof.state_scope, 'isolated_contract_state');
  assert.equal(proof.persistent_paths_used, false);
  assert.equal(proof.hearing_report_file, hearingReportFile);
  assert.equal(proof.wake_gate_checked_now, true);
  assert.equal(proof.wake_routed_to_cognition, true);
  assert.equal(proof.qwen_cognition_run_now, true);
  assert.equal(proof.schema_constrained_json, true);
  assert.equal(proof.model_json_fallback_used, false);
  assert.equal(proof.persistent_memory_used, true);
  assert.equal(proof.short_term_memory_written, true);
  assert.equal(proof.long_term_memory_recalled, true);
  assert.equal(proof.emotional_reinforcement_used, true);
  assert.equal(proof.consolidation_promoted_memory, true);
  assert.equal(proof.affect_state_persisted, true);
  assert.equal(proof.personality_state_persisted, true);
  assert.equal(proof.identity_state_persisted, true);
  assert.equal(proof.personality_identity_persisted, true);
  assert.equal(proof.broca_enabled_now, true);
  assert.equal(proof.piper_speech_run_now, true);
  assert.equal(proof.piper_wav_created_now, true);
  assert.equal(proof.speaker_playback_run_now, false);
  assert.equal(proof.chat_mode_only, true);
  assert.equal(fs.existsSync(proof.report_file), true);
  assert.equal(fs.existsSync(proof.bridge_report_file), true);
  assert.equal(fs.existsSync(proof.piper_wav_output_file), true);
  assert.equal(proof.before.paths.short_term_path.startsWith(memoryBaseDir), true);
  assert.equal(proof.before.paths.personality_path.startsWith(brainStateBaseDir), true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_CONTRACT_PASS',
    state_scope: proof.state_scope,
    wake_routed_to_cognition: proof.wake_routed_to_cognition,
    qwen_cognition_run_now: proof.qwen_cognition_run_now,
    schema_constrained_json: proof.schema_constrained_json,
    model_json_fallback_used: proof.model_json_fallback_used,
    persistent_memory_used: proof.persistent_memory_used,
    short_term_memory_written: proof.short_term_memory_written,
    long_term_memory_recalled: proof.long_term_memory_recalled,
    emotional_reinforcement_used: proof.emotional_reinforcement_used,
    consolidation_promoted_memory: proof.consolidation_promoted_memory,
    affect_state_persisted: proof.affect_state_persisted,
    personality_state_persisted: proof.personality_state_persisted,
    identity_state_persisted: proof.identity_state_persisted,
    piper_wav_output_file: proof.piper_wav_output_file,
    speaker_playback_run_now: proof.speaker_playback_run_now,
    chat_mode_only: true
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_GROWTH_PERSISTENCE_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
});
