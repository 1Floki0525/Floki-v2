
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateTrainingArtifacts } = require('../src/self-improvement/training/training-runner.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-training-artifacts-'));
fs.writeFileSync(path.join(tmp, 'adapter_config.json'), '{}\n');
fs.writeFileSync(path.join(tmp, 'adapter_model.safetensors'), 'artifact\n');
fs.writeFileSync(path.join(tmp, 'metrics.json'), JSON.stringify({ train_loss: 1.25 }) + '\n');
assert.equal(validateTrainingArtifacts(tmp).metrics.train_loss, 1.25);
fs.rmSync(path.join(tmp, 'adapter_model.safetensors'));
assert.throws(() => validateTrainingArtifacts(tmp), /required adapter artifacts/);
console.log('FLOKI_RSI_TRAINING_ARTIFACT_VALIDATION_PASS');
