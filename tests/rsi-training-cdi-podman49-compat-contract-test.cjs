
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');
const { splitPipeList } = require('../src/self-improvement/training/qlora-config.cjs');

const config = loadSelfImprovementConfig();
const gpuArgs = splitPipeList(config.training_gpu_device_args);

assert.equal(config.training_gpu_runtime_mode, 'cdi');
assert.deepEqual(gpuArgs, [
  '--device',
  config.training_cdi_device_name,
  '--security-opt=label=disable'
]);
assert.equal(config.training_cdi_spec_path, '/etc/cdi/nvidia.yaml');
assert.equal(config.training_cdi_generated_spec_path, '/var/run/cdi/nvidia.yaml');
assert.equal(config.training_cdi_podman_spec_version, '0.6.0');
assert.ok(config.training_cdi_generation_timeout_ms > 0);
assert.deepEqual(splitPipeList(config.training_cdi_generate_args), [
  '--feature-flag',
  'no-additional-gids-for-device-nodes'
]);
assert.ok(config.training_gpu_probe_command);
assert.ok(config.training_gpu_probe_args);

const qlora = fs.readFileSync('src/self-improvement/training/qlora-config.cjs', 'utf8');
const rem = fs.readFileSync('src/self-improvement/training/hf-rem-inference.cjs', 'utf8');
assert.match(qlora, /splitPipeList\(config\.training_gpu_device_args\)/);
assert.match(rem, /splitPipeList\(config\.training_gpu_device_args\)/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_PODMAN49_CDI06_COMPAT_PASS',
  gpu_args: gpuArgs,
  podman_cdi_spec_version: config.training_cdi_podman_spec_version,
  spec_path: config.training_cdi_spec_path,
  generated_spec_path: config.training_cdi_generated_spec_path
}, null, 2));
