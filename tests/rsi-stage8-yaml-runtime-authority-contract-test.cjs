'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  getSelfImprovementConfig,
  getSleepConfig
} = require('../src/config/floki-config.cjs');
const {
  assertQualifiedContainerImageReference
} = require('../src/self-improvement/training/training-runner.cjs');

const ROOT = path.resolve(__dirname, '..');
const config = getSelfImprovementConfig('chat');
const sleep = getSleepConfig('chat');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const stringKeys = [
  'training_base_cuda_image','training_source_fingerprint_files','training_image_fingerprint_label',
  'training_container_context_dir','training_container_apt_packages','training_entrypoint',
  'training_script_path','training_debian_frontend','training_pip_no_cache_dir',
  'training_hf_hub_offline','training_transformers_offline','training_run_id_prefix',
  'training_required_artifact_files','training_default_objective',
  'training_status_objective','training_candidate_summary',
  'training_candidate_risk_level','training_adapter_output_dir_name',
  'training_log_file_name','training_metrics_file_name',
  'training_checkpoint_dir_prefix','training_trainer_state_file_name',
  'training_optimizer_state_file_name','training_lr_scheduler_state_file_name',
  'training_rng_state_file_name','training_device_map','training_report_to',
  'manual_training_mode','manual_training_resume_policy','qlora_bias',
  'qlora_task_type','qlora_save_strategy','qlora_dataset_text_field',
  'nightly_training_run_id_prefix','nightly_training_control_file_name',
  'nightly_training_control_response_file_name','nightly_training_mode',
  'nightly_training_resume_policy','nightly_training_checkpoint_request_id_prefix',
  'nightly_training_default_objective','nightly_training_candidate_objective',
  'hf_rem_runtime_subdir','hf_rem_log_file_name','hf_rem_id_prefix',
  'hf_rem_adapter_mount_path','hf_rem_entrypoint','hf_rem_inference_script_path',
  'hf_rem_network_mode','hf_rem_required_adapter_files','hf_rem_system_prompt',
  'hf_rem_model_identity_prefix','hf_rem_master_identity','hf_rem_device_map',
  'live_cognition_provider','code_improvement_provider','manual_training_provider',
  'nightly_training_provider','vision_provider'
];
const numberKeys = [
  'training_run_id_random_bytes','training_log_tail_max_chars',
  'nightly_training_run_id_random_bytes','nightly_training_checkpoint_request_random_bytes',
  'nightly_training_container_stop_timeout_seconds','nightly_training_container_stop_timeout_floor_ms',
  'nightly_training_min_completed_steps','hf_rem_id_random_bytes',
  'hf_rem_temperature','hf_rem_top_p','hf_rem_max_new_tokens','hf_rem_repetition_penalty',
  'rsi_ui_candidate_render_limit','rsi_terminal_event_limit',
  'rsi_terminal_at_bottom_threshold_px','rsi_terminal_poll_ms',
  'rsi_terminal_initial_activity_limit','rsi_terminal_incremental_activity_limit',
  'rsi_terminal_safe_string_max_chars','rsi_terminal_output_max_lines',
  'rsi_terminal_output_max_line_chars','rsi_terminal_code_max_lines',
  'rsi_terminal_code_max_line_chars','rsi_terminal_command_max_chars',
  'rsi_terminal_output_max_chars','rsi_terminal_success_output_max_lines',
  'rsi_terminal_failure_output_max_lines','rsi_terminal_diff_max_chars',
  'rsi_terminal_selection_error_max_chars','rsi_terminal_selection_error_max_lines',
  'rsi_terminal_selection_error_line_max_chars','rsi_terminal_summary_max_chars',
  'activity_stream_default_events','activity_stream_initial_events','activity_stream_min_events',
  'manual_training_segment_number'
];
const booleanKeys = [
  'training_tokenizer_use_fast','hf_rem_tokenizer_use_fast','hf_rem_do_sample'
];
for (const key of stringKeys) assert.equal(typeof config[key], 'string', key + ' must come from chat YAML as string');
for (const key of numberKeys) assert.equal(Number.isFinite(config[key]), true, key + ' must come from chat YAML as number');
for (const key of booleanKeys) assert.equal(typeof config[key], 'boolean', key + ' must come from chat YAML as boolean');

assert.equal(config.hf_rem_network_mode, 'none');
assert.equal(config.nightly_rem_provider, config.nightly_training_provider);
assert.equal(sleep.manual_nap_duration_minutes, 30);
assert.equal(sleep.manual_nap_rem_offset_minutes, 10);
assert.equal(sleep.manual_nap_max_rem_cycles, 2);
assert.equal(
  config.training_base_cuda_image,
  'docker.io/nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04'
);
assert.equal(
  assertQualifiedContainerImageReference(
    config.training_base_cuda_image
  ),
  config.training_base_cuda_image
);
assert.throws(
  () => assertQualifiedContainerImageReference(
    'nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04'
  ),
  /FLOKI_TRAINING_BASE_IMAGE_UNQUALIFIED/
);

const requiredSourceReferences = {
  'src/self-improvement/training/training-runner.cjs': [
    'config.training_source_fingerprint_files','config.training_image_fingerprint_label',
    'config.training_container_context_dir','config.training_container_apt_packages',
    'config.training_entrypoint','config.training_script_path',
    'config.training_debian_frontend','config.training_pip_no_cache_dir',
    'config.training_hf_hub_offline','config.training_transformers_offline',
    'config.training_run_id_prefix',
    'config.training_log_tail_max_chars','config.training_required_artifact_files',
    'config.training_adapter_output_dir_name','config.training_log_file_name'
  ],
  'src/self-improvement/training/qlora-config.cjs': [
    'config.training_optimizer_state_file_name','config.training_lr_scheduler_state_file_name',
    'config.training_rng_state_file_name','config.qlora_save_strategy',
    'config.qlora_dataset_text_field','config.training_entrypoint',
    'config.training_script_path'
  ],
  'containers/self-improvement-training/train_qlora.py': [
    'config["optimizer_state_file_name"]','config["lr_scheduler_state_file_name"]',
    'config["rng_state_file_name"]','config["dataset_text_field"]',
    'config["metrics_file_name"]','config["checkpoint_dir_prefix"]'
  ],
  'src/self-improvement/training/nightly-training-session.cjs': [
    'config.nightly_training_run_id_prefix','config.nightly_training_control_file_name',
    'config.nightly_training_mode','config.nightly_training_resume_policy',
    'config.nightly_training_checkpoint_request_id_prefix',
    'config.nightly_training_container_stop_timeout_seconds',
    'config.nightly_training_min_completed_steps'
  ],
  'src/self-improvement/training/hf-rem-inference.cjs': [
    'config.hf_rem_network_mode','config.hf_rem_adapter_mount_path',
    'config.hf_rem_entrypoint','config.hf_rem_inference_script_path',
    'config.hf_rem_temperature','config.hf_rem_top_p',
    'config.hf_rem_max_new_tokens','config.hf_rem_repetition_penalty'
  ],
  'src/self-improvement/training/training-scheduler.cjs': [
    'config.training_enabled === true','config.nightly_training_enabled === true',
    'config.hf_rem_system_prompt'
  ],
  'src/chat/manual-nap.cjs': ['max_rem_cycles','maxRemCycles'],
  'src/self-improvement/ui-status.cjs': ['ui_limits: Object.freeze','config.rsi_ui_candidate_render_limit'],
  'apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx': ['status?.ui_limits?.candidate_render_limit'],
  'apps/floki-neural-interface/src/pages/RSILab.jsx': ['uiLimitsRef','terminal_poll_ms','terminal_event_limit'],
  'src/runtime/chat-local-runtime.cjs': [
    'activity_stream_default_events','activity_stream_min_events','ui_limits',
    'restartKnowledgeAfterTraining','restartKnowledge: restartKnowledgeAfterTraining'
  ],
  'src/self-improvement/training/runtime-resource-controller.cjs': [
    'restoreRuntimeResources','restartKnowledge','FLOKI_TRAINING_RESOURCE_ENTER_FAILED'
  ]
};
for (const [relative, markers] of Object.entries(requiredSourceReferences)) {
  const source = read(relative);
  for (const marker of markers) assert.equal(source.includes(marker), true, relative + ' missing YAML transport marker: ' + marker);
}

const scheduler = read('src/self-improvement/training/training-scheduler.cjs');
const schedulerStart = read('bin/floki-sleep-scheduler-start.sh');
assert.equal(scheduler.includes('FLOKI_ALLOW_NIGHTLY_TRAINING'), false, 'nightly training must be enabled only by chat YAML');
assert.equal(schedulerStart.includes('FLOKI_ALLOW_NIGHTLY_TRAINING'), false, 'scheduler shell must not override chat YAML');

const trainer = read('containers/self-improvement-training/train_qlora.py');
for (const literal of ['trainer_state.json','optimizer.pt','scheduler.pt','rng_state.pth']) {
  assert.equal(trainer.includes(literal), false, 'trainer state filename is hardcoded: ' + literal);
}
const trainingContainerfile = read('containers/self-improvement-training/Containerfile');
for (const pattern of [
  /ARG BASE_CUDA_IMAGE=/,
  /ARG PYTHON_PACKAGES=/,
  /ARG APT_PACKAGES=/,
  /ARG TRAINING_WORKDIR=/,
  /ARG TRAINING_ENTRYPOINT=/,
  /ARG TRAINING_SCRIPT_PATH=/,
  /ARG REM_INFERENCE_SCRIPT_PATH=/,
  /ARG DEBIAN_FRONTEND_VALUE=/,
  /ARG PIP_NO_CACHE_DIR_VALUE=/,
  /ARG HF_HUB_OFFLINE_VALUE=/,
  /ARG TRANSFORMERS_OFFLINE_VALUE=/
]) {
  assert.doesNotMatch(trainingContainerfile, pattern, 'training Containerfile contains a build-setting default instead of requiring chat YAML build args');
}
for (const marker of [
  'ARG BASE_CUDA_IMAGE', 'ARG PYTHON_PACKAGES', 'ARG APT_PACKAGES',
  'ARG TRAINING_WORKDIR', 'ARG TRAINING_ENTRYPOINT',
  'ARG TRAINING_SCRIPT_PATH', 'ARG REM_INFERENCE_SCRIPT_PATH',
  'ARG DEBIAN_FRONTEND_VALUE', 'ARG PIP_NO_CACHE_DIR_VALUE',
  'ARG HF_HUB_OFFLINE_VALUE', 'ARG TRANSFORMERS_OFFLINE_VALUE'
]) {
  assert.equal(trainingContainerfile.includes(marker), true, 'training Containerfile is missing required YAML-fed build argument: ' + marker);
}
assert.doesNotMatch(trainingContainerfile, /^ENTRYPOINT/m, 'training command must be supplied from chat YAML by the container runner');

const lab = read('apps/floki-neural-interface/src/pages/RSILab.jsx');
for (const pattern of [/setTimeout\(poll,\s*2000\)/, /slice\(-3000\)/, /limit:\s*500/, /limit:\s*200/]) {
  assert.doesNotMatch(lab, pattern, 'RSI UI contains an operational literal that belongs in chat YAML');
}

const publicTemplate = read('config/chat.config.yaml.temp');
for (const fragment of [
  ['media','binary-god'].join('/'),
  ['home','binary-god'].join('/'),
  ['mnt','firstlight'].join('/')
]) {
  assert.equal(publicTemplate.includes('/' + fragment), false, 'public template leaked a private host path');
}

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_STAGE8_YAML_RUNTIME_AUTHORITY_PASS',
  string_keys: stringKeys.length,
  number_keys: numberKeys.length,
  boolean_keys: booleanKeys.length,
  nightly_training_yaml_only: true,
  manual_nap_offsets_minutes: [10, 20],
  production_literals_removed: true,
  public_template_private_paths_absent: true
}, null, 2));
