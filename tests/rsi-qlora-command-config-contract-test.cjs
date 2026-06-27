'use strict';

// Contract: QLoRA training config + container args are generated from YAML, are
// QLoRA-only (refuse full fine-tune), carry the GPU device args and read-only HF
// master/dataset mounts with a writable adapter mount and no host sockets.

const assert = require('node:assert/strict');

const q = require('../src/self-improvement/training/qlora-config.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const config = loadSelfImprovementConfig();

// --- training config (deterministic, QLoRA-only) ---
const tc = q.buildTrainingConfig({ config });
assert.equal(tc.method, 'qlora');
assert.equal(tc.full_finetune, false);
assert.equal(tc.quantization.load_in_4bit, true);
assert.equal(tc.lora.r, config.qlora_rank);
assert.equal(tc.lora.alpha, config.qlora_alpha);
assert.deepEqual(tc.lora.target_modules, config.qlora_target_modules.split('|'));
assert.equal(tc.training.seed, config.qlora_seed);
assert.equal(tc.training.learning_rate, config.qlora_learning_rate);
assert.equal(tc.base_model_path, config.training_hf_master_mount_path);

// --- refuse full fine-tune / non-QLoRA ---
assert.throws(() => q.buildTrainingConfig({ config: Object.assign({}, config, { qlora_load_in_4bit: false }) }), /full-weight fine-tuning is not allowed/);
assert.throws(() => q.buildTrainingConfig({ config: Object.assign({}, config, { qlora_rank: 0 }) }), /positive qlora_rank/);

// --- container run args ---
const args = q.buildTrainingRunArgs({
  config,
  containerName: 'floki-rsi-training-x',
  hfMasterPath: '/host/Qwen3.5-4B',
  datasetDir: '/host/datasets/ds-1',
  adapterOutDir: '/host/adapters/adapter-v1',
  trainingConfigFile: '/host/run/training-config.json'
});
const joined = args.join(' ');

// GPU device args present (from YAML)
for (const piece of config.training_gpu_device_args.split('|')) {
  assert.ok(args.includes(piece), 'gpu arg present: ' + piece);
}
assert.ok(args.includes('--memory') && args.includes('--cpus') && args.includes('--pids-limit'), 'resource limits present');
assert.ok(args.includes('--security-opt=' + config.security_opt), 'security-opt present');

// mounts: HF master ro, dataset ro, adapter rw, config ro
const mounts = [];
for (let i = 0; i < args.length; i += 1) if (args[i] === '-v') mounts.push(args[i + 1]);
const hfMount = mounts.find((m) => m.includes(config.training_hf_master_mount_path));
assert.ok(hfMount && /ro/.test(hfMount), 'HF master mounted read-only');
const dsMount = mounts.find((m) => m.includes(config.training_dataset_mount_path));
assert.ok(dsMount && /ro/.test(dsMount), 'dataset mounted read-only');
const adMount = mounts.find((m) => m.includes(config.training_adapter_mount_path));
assert.ok(adMount && /rw/.test(adMount), 'adapter output writable');

// no host sockets / secrets / privileged
for (const needle of ['docker.sock', 'podman.sock', '--privileged', 'cookies.txt', '/.ssh', '.env']) {
  assert.ok(!joined.includes(needle), 'training container must not expose: ' + needle);
}
assert.ok(args.includes(config.training_container_image), 'uses configured training image');

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_QLORA_COMMAND_CONFIG_PASS',
  qlora_only: true,
  full_finetune_refused: true,
  gpu_args_present: true,
  mounts_correct: true,
  no_host_sockets: true
}, null, 2));
