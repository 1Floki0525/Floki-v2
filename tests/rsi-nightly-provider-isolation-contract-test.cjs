'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const runtime = fs.readFileSync(
  path.join(ROOT, 'src/runtime/chat-local-runtime.cjs'),
  'utf8'
);
const scheduler = fs.readFileSync(
  path.join(ROOT, 'src/chat/sleep-cycle-scheduler.cjs'),
  'utf8'
);
const trainingScheduler = fs.readFileSync(
  path.join(ROOT, 'src/self-improvement/training/training-scheduler.cjs'),
  'utf8'
);
const startScript = fs.readFileSync(
  path.join(ROOT, 'bin/floki-sleep-scheduler-start.sh'),
  'utf8'
);

assert.match(
  runtime,
  /runDreamEngineOnce\(\{\s*sleep_kind:\s*['"]manual_nap['"]/,
  'manual nap must continue through the normal Ollama dream engine path'
);
assert.doesNotMatch(
  runtime.match(/async function processManualNap\(\)[\s\S]*?\n  }/)[0],
  /dream_generator\s*:/,
  'manual nap must not inject the Hugging Face generator'
);
assert.match(scheduler, /getProductionNightlyTrainingCoordinator/);
assert.match(scheduler, /trainingCoordinator\.runNightlyRem/);
assert.match(trainingScheduler, /config\.nightly_rem_provider !== config\.nightly_training_provider/);
assert.match(trainingScheduler, /fake_generator_counts_as_model:\s*true/);
assert.doesNotMatch(startScript, /FLOKI_ALLOW_NIGHTLY_TRAINING/);
assert.doesNotMatch(trainingScheduler, /FLOKI_ALLOW_NIGHTLY_TRAINING/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_NIGHTLY_PROVIDER_ISOLATION_PASS',
  nightly_provider: 'huggingface',
  manual_nap_provider: 'ollama',
  production_scheduler_guarded: true
}, null, 2));
