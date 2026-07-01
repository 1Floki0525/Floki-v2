
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getSelfImprovementConfig } = require('../src/config/floki-config.cjs');
const { buildTrainingRunArgs, splitPipeList } = require('../src/self-improvement/training/qlora-config.cjs');

const config = getSelfImprovementConfig('chat');
const gpuArgs = splitPipeList(config.training_gpu_device_args);

assert.equal(config.training_gpu_runtime_mode, 'cdi');
assert.equal(config.training_cdi_device_name, 'nvidia.com/gpu=all');
assert.deepEqual(gpuArgs, [
  '--device',
  config.training_cdi_device_name,
  '--security-opt=label=disable'
]);
assert.ok(config.training_cdi_spec_path.startsWith('/'));
assert.ok(config.training_nvidia_toolkit_keyring_path.startsWith('/'));
assert.ok(config.training_nvidia_toolkit_repo_path.startsWith('/'));
assert.ok(config.training_cdi_generation_timeout_ms > 0);

const trainingArgs = buildTrainingRunArgs({
  config,
  containerName: 'contract-training',
  hfMasterPath: '/contract/hf-master',
  datasetDir: '/contract/dataset',
  adapterOutDir: '/contract/adapter',
  trainingConfigFile: '/contract/training-config.json'
});
for (const arg of gpuArgs) assert.ok(trainingArgs.includes(arg));

const hfRemSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'self-improvement', 'training', 'hf-rem-inference.cjs'),
  'utf8'
);
assert.match(hfRemSource, /splitPipeList\(config\.training_gpu_device_args\)/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_TRAINING_CDI_YAML_AUTHORITY_PASS',
  runtime_mode: config.training_gpu_runtime_mode,
  gpu_args: gpuArgs,
  cdi_device: config.training_cdi_device_name,
  cdi_spec_path: config.training_cdi_spec_path
}, null, 2));
