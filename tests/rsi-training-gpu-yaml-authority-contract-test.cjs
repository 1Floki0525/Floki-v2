
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');
const { buildTrainingRunArgs, splitPipeList } = require('../src/self-improvement/training/qlora-config.cjs');

const config = loadSelfImprovementConfig();
const configuredGpuArgs = splitPipeList(config.training_gpu_device_args);
assert.equal(config.training_gpu_runtime_mode, 'cdi');
assert.deepEqual(configuredGpuArgs, [
  '--device',
  config.training_cdi_device_name,
  '--security-opt=label=disable'
]);

const trainingArgs = buildTrainingRunArgs({
  config,
  containerName: config.training_container_name_prefix + '-yaml-authority-contract',
  hfMasterPath: config.hf_master_path,
  datasetDir: config.dataset_root,
  adapterOutDir: config.adapter_root,
  trainingConfigFile: path.join(config.training_runtime_root, config.training_config_file_name)
});
const trainingNameIndex = trainingArgs.indexOf('--name');
assert.ok(trainingNameIndex >= 0);
assert.deepEqual(
  trainingArgs.slice(trainingNameIndex + 2, trainingNameIndex + 2 + configuredGpuArgs.length),
  configuredGpuArgs
);

const hfRemSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'self-improvement', 'training', 'hf-rem-inference.cjs'),
  'utf8'
);
assert.match(hfRemSource, /splitPipeList\(config\.training_gpu_device_args\)/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_TRAINING_GPU_YAML_AUTHORITY_PASS',
  runtime_mode: config.training_gpu_runtime_mode,
  gpu_args: configuredGpuArgs,
  engine: config.sandbox_engine,
  training_image: config.training_container_image,
  entrypoint: config.training_entrypoint
}, null, 2));
