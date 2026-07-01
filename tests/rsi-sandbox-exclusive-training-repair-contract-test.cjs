'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');
const { buildTrainingRunArgs, splitPipeList } = require('../src/self-improvement/training/qlora-config.cjs');

const config = loadSelfImprovementConfig();
assert.equal(config.persistent_container_enabled, true);
assert.ok(config.persistent_container_name);
assert.equal(config.training_gpu_runtime_mode, 'cdi');
assert.deepEqual(splitPipeList(config.training_gpu_device_args), [
  '--device',
  config.training_cdi_device_name,
  '--security-opt=label=disable'
]);
assert.match(config.training_suspend_workers, /sleep_scheduler/);
assert.match(config.training_suspend_workers, /regular_rsi_sandbox/);
assert.doesNotMatch(config.training_keep_alive_workers, /sleep_scheduler/);
assert.ok(config.training_sleep_scheduler_stop_script);
assert.ok(config.training_sleep_scheduler_start_script);
assert.ok(config.training_gpu_process_query_command);
assert.ok(config.training_gpu_process_query_args);
assert.ok(config.training_exclusive_status_label);

const controller = fs.readFileSync(
  path.join(__dirname, '..', 'src/self-improvement/training/runtime-resource-controller.cjs'),
  'utf8'
);
const stopAudio = controller.indexOf('await stopLiveAudio(liveAudio)');
const unload = controller.indexOf('await unloadAllLoaded');
const quiesce = controller.indexOf('await waitForGpuComputeQuiescence');
const acquire = controller.indexOf('acquireTrainingGpu(config, options)');
assert.ok(stopAudio >= 0 && stopAudio < unload);
assert.ok(unload >= 0 && unload < quiesce);
assert.ok(quiesce >= 0 && quiesce < acquire);
assert.match(controller, /training_sleep_scheduler_stop_script/);
assert.match(controller, /training_sleep_scheduler_start_script/);
assert.match(controller, /config\.training_gpu_process_query_command/);
assert.match(controller, /config\.training_gpu_process_query_args/);

const runtime = fs.readFileSync(
  path.join(__dirname, '..', 'src/runtime/chat-local-runtime.cjs'),
  'utf8'
);
assert.match(runtime, /exclusive_training_resource_transition/);
assert.match(runtime, /training_scheduler_restart_required/);
assert.match(runtime, /restart_scheduler:/);

const interfaceSource = fs.readFileSync(
  path.join(__dirname, '..', 'src/runtime/chat-local-interface-api.cjs'),
  'utf8'
);
assert.match(interfaceSource, /exclusiveTraining/);
assert.match(interfaceSource, /training_exclusive_status_label/);
assert.match(interfaceSource, /trainingControlPlaneNames/);

const trainer = fs.readFileSync(
  path.join(__dirname, '..', 'containers/self-improvement-training/train_qlora.py'),
  'utf8'
);
assert.match(trainer, /FLOKI_EXCLUSIVE_TRAINING_PREFLIGHT_V2/);
assert.ok(trainer.indexOf('verify_gpu(config, torch)') < trainer.indexOf('AutoModelForCausalLM.from_pretrained'));
assert.match(trainer, /warmup_steps=warmup_steps/);
assert.doesNotMatch(trainer, /warmup_ratio=float/);

const args = buildTrainingRunArgs({
  config,
  containerName: config.training_container_name_prefix + '-contract',
  hfMasterPath: config.hf_master_path,
  datasetDir: config.dataset_root,
  adapterOutDir: config.adapter_root,
  trainingConfigFile: path.join(config.training_runtime_root, config.training_config_file_name)
});
for (const arg of splitPipeList(config.training_gpu_device_args)) {
  assert.ok(args.includes(arg));
}

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_SANDBOX_AND_EXCLUSIVE_TRAINING_SOURCE_PASS',
  persistent_container: config.persistent_container_name,
  exclusive_training: true,
  gpu_runtime_mode: config.training_gpu_runtime_mode
}, null, 2));
