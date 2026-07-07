'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');
const { validateTrainingArtifacts } = require('../src/self-improvement/training/training-runner.cjs');

const config = loadSelfImprovementConfig();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-training-artifacts-'));

try {
  const required = String(config.training_required_artifact_files)
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean);

  for (const fileName of required) {
    const target = path.join(tmp, fileName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fileName === config.training_metrics_file_name) continue;
    fs.writeFileSync(target, fileName.endsWith('.json') ? '{}\n' : 'artifact\n');
  }

  const metricsFile = path.join(tmp, config.training_metrics_file_name);
  fs.writeFileSync(metricsFile, JSON.stringify({
    train_loss: 1.25,
    epoch: 0,
    global_step: 0,
    completed_epochs: 0
  }) + '\n');

  assert.throws(
    () => validateTrainingArtifacts(tmp, config),
    /FLOKI_INCOMPLETE_EPOCH_CANDIDATE_BLOCKED/
  );

  fs.writeFileSync(metricsFile, JSON.stringify({
    train_loss: 1.25,
    epoch: 1,
    global_step: 1,
    completed_epochs: 1
  }) + '\n');

  const validated = validateTrainingArtifacts(tmp, config);
  assert.equal(validated.metrics.train_loss, 1.25);
  assert.equal(validated.metrics.completed_epochs, 1);

  const removable = required.find(
    (fileName) => fileName !== config.training_metrics_file_name
  );
  assert.ok(removable, 'a non-metrics required artifact is needed');
  fs.rmSync(path.join(tmp, removable));
  assert.throws(
    () => validateTrainingArtifacts(tmp, config),
    /required adapter artifacts/
  );

  console.log('FLOKI_RSI_TRAINING_ARTIFACT_VALIDATION_PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
