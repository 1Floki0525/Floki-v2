'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');

const {
  writeBridgeReport,
  runHearingToCognitionBridgeProof
} = require('../src/senses/hearing-to-cognition-bridge.cjs');

function writeFakeHearingReport(baseDir, heardText) {
  fs.mkdirSync(baseDir, { recursive: true });

  const filePath = path.join(baseDir, 'fake-hearing-report.json');

  fs.writeFileSync(filePath, JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_HEARING_LOOP_PASS',
    heard_text: heardText,
    heard_text_length: heardText.length,
    heard_word_count: heardText.split(/\s+/).filter(Boolean).length,
    capture: {
      output_file: '/tmp/fake-capture.wav'
    },
    whisper: {
      report_file: '/tmp/fake-whisper.json'
    }
  }, null, 2) + '\n');

  return filePath;
}

async function run() {
  const unique = newId('report_isolation').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/hearing-bridge-report-isolation/' + unique);
  const explicitReport = path.join(baseDir, 'explicit-report.json');

  const written = writeBridgeReport({
    ok: true,
    marker: 'FLOKI_V2_HEARING_BRIDGE_EXPLICIT_REPORT_TEST',
    chat_mode_only: true
  }, {
    report_file: explicitReport
  });

  assert.equal(written, explicitReport);
  assert.equal(fs.existsSync(explicitReport), true);

  const disabled = writeBridgeReport({
    ok: true,
    marker: 'FLOKI_V2_HEARING_BRIDGE_DISABLED_REPORT_TEST',
    chat_mode_only: true
  }, {
    write_report: false
  });

  assert.equal(disabled, null);

  const fakeHearingReport = writeFakeHearingReport(
    path.join(baseDir, 'fake-input'),
    'background speech without the wake phrase'
  );

  const proof = await runHearingToCognitionBridgeProof({
    write_report: false,
    env: {
      FLOKI_ALLOW_HEARING_TO_COGNITION: '1'
    },
    report_file: fakeHearingReport,
    modality: 'spoken',
    source: 'background'
  });

  assert.equal(proof.ok, true);
  assert.equal(proof.marker, 'FLOKI_V2_WAKE_GATED_HEARING_TO_COGNITION_IGNORED');
  assert.equal(proof.report_file, null);
  assert.equal(proof.qwen_cognition_run_now, false);
  assert.equal(proof.persistent_memory_used, false);
  assert.equal(proof.broca_enabled_now, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_HEARING_BRIDGE_REPORT_ISOLATION_PASS',
    explicit_report_supported: true,
    write_report_false_supported: true,
    contract_proofs_do_not_clobber_latest_live_report: true,
    fake_contract_input_stays_test_only: true,
    chat_mode_only: true
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_HEARING_BRIDGE_REPORT_ISOLATION_FAIL',
    error: error.message
  }, null, 2));
  process.exit(1);
});
