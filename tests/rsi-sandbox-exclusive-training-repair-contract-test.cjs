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
const __flokiNightlyOwnershipConfigText =
  require("node:fs").readFileSync(
    require("node:path").resolve(
      __dirname,
      "../config/chat.config.yaml.temp"
    ),
    "utf8"
  );

function __flokiReadNightlySetting(key) {
  const prefix = `${key}:`;
  const matches = __flokiNightlyOwnershipConfigText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));

  assert.equal(
    matches.length,
    1,
    `expected exactly one configured setting: ${key}`
  );

  let value = matches[0].slice(prefix.length).trim();

  if (
    value.length >= 2 &&
    (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
  ) {
    value = value.slice(1, -1);
  }

  assert.ok(value, `configured setting is empty: ${key}`);
  return value;
}

function __flokiReadNightlyPipe(key) {
  return __flokiReadNightlySetting(key)
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);
}

const __flokiSuspendedWorkers =
  __flokiReadNightlyPipe("training_suspend_workers");
const __flokiKeptAliveWorkers =
  __flokiReadNightlyPipe("training_keep_alive_workers");
const __flokiSchedulerWorkers =
  __flokiKeptAliveWorkers.filter(
    (worker) => worker.toLowerCase().includes("scheduler")
  );

assert.equal(
  __flokiSchedulerWorkers.length,
  1,
  "config must keep exactly one scheduler alive during training"
);
assert.equal(
  __flokiSuspendedWorkers.includes(__flokiSchedulerWorkers[0]),
  false,
  "configured scheduler must not be suspended during training"
);
assert.deepEqual(
  __flokiSuspendedWorkers.filter(
    (worker) => __flokiKeptAliveWorkers.includes(worker)
  ),
  [],
  "suspended and kept-alive worker lists must be disjoint"
);

const __flokiNightlyTrainingProvider =
  __flokiReadNightlySetting("nightly_training_provider");
const __flokiNightlyRemProvider =
  __flokiReadNightlySetting("nightly_rem_provider");
const __flokiManualNapRemProvider =
  __flokiReadNightlySetting("manual_nap_rem_provider");
const __flokiLiveCognitionProvider =
  __flokiReadNightlySetting("live_cognition_provider");
const __flokiWakeReloadPolicy =
  __flokiReadNightlySetting("nightly_ollama_reload_policy");

assert.equal(
  __flokiNightlyRemProvider,
  __flokiNightlyTrainingProvider,
  "nightly dreams and training must share the configured provider"
);
assert.equal(
  __flokiManualNapRemProvider,
  __flokiNightlyTrainingProvider,
  "manual-nap dreams must share the configured nightly provider"
);
assert.notEqual(
  __flokiLiveCognitionProvider,
  __flokiNightlyTrainingProvider,
  "development live cognition must remain separate from nightly inference"
);
assert.ok(
  __flokiSuspendedWorkers.some(
    (worker) => worker.toLowerCase().includes(
      __flokiLiveCognitionProvider.toLowerCase()
    )
  ),
  "nightly operation must suspend the configured live cognition provider"
);
assert.equal(
  __flokiKeptAliveWorkers.some(
    (worker) => worker.toLowerCase().includes(
      __flokiLiveCognitionProvider.toLowerCase()
    )
  ),
  false,
  "nightly keep-alive workers must exclude live cognition"
);
assert.match(
  __flokiWakeReloadPolicy,
  /wake/i,
  "development cognition may reload only during wake restoration"
);
assert.match(config.training_suspend_workers, /regular_rsi_sandbox/);

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
// Contract updated 2026-07-04: the sleep-cycle scheduler owns the nightly
// epoch → REM state machine, so entering HF training resource mode must
// preserve it instead of stopping it through the configured stop script.
assert.doesNotMatch(
  controller,
  /runConfiguredScript\(\s*config,\s*'training_sleep_scheduler_stop_script'/
);
assert.match(controller, /scheduler_preserved = true/);
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
