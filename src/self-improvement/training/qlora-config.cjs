'use strict';

const path = require('node:path');
const { loadSelfImprovementConfig } = require('../config.cjs');

function splitPipeList(value) {
  if (typeof value !== 'string') return [];
  return value.split('|').map((s) => s.trim()).filter(Boolean);
}

function buildTrainingConfig(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  if (config.qlora_load_in_4bit !== true) {
    throw new Error('QLoRA requires qlora_load_in_4bit=true; full-weight fine-tuning is not allowed');
  }
  if (!(config.qlora_rank > 0)) {
    throw new Error('QLoRA requires a positive qlora_rank (LoRA adapter), not a full fine-tune');
  }
  return Object.freeze({
    marker: 'FLOKI_V2_RSI_TRAINING_CONFIG',
    schema_version: 1,
    method: 'qlora',
    full_finetune: false,
    base_model_path: config.training_hf_master_mount_path,
    dataset_path: path.posix.join(config.training_dataset_mount_path, config.dataset_records_file_name),
    adapter_output_path: config.training_adapter_mount_path,
    tokenizer_use_fast: config.training_tokenizer_use_fast,
    device_map: config.training_device_map,
    checkpoint_dir_prefix: config.training_checkpoint_dir_prefix,
    trainer_state_file_name: config.training_trainer_state_file_name,
    metrics_file_name: config.training_metrics_file_name,
    optimizer_state_file_name: config.training_optimizer_state_file_name,
    lr_scheduler_state_file_name: config.training_lr_scheduler_state_file_name,
    rng_state_file_name: config.training_rng_state_file_name,
    dataset_text_field: config.qlora_dataset_text_field,
    gpu: Object.freeze({
      expected_name: config.training_expected_gpu_name,
      expected_compute_capability: Object.freeze([
        config.training_expected_compute_capability_major,
        config.training_expected_compute_capability_minor
      ]),
      require_bf16: config.training_require_bf16
    }),
    quantization: Object.freeze({
      load_in_4bit: config.qlora_load_in_4bit,
      bnb_4bit_quant_type: config.qlora_bnb_4bit_quant_type,
      bnb_4bit_compute_dtype: config.qlora_bnb_4bit_compute_dtype,
      bnb_4bit_use_double_quant: config.qlora_bnb_4bit_use_double_quant
    }),
    lora: Object.freeze({
      r: config.qlora_rank,
      alpha: config.qlora_alpha,
      dropout: config.qlora_dropout,
      target_modules: splitPipeList(config.qlora_target_modules),
      bias: config.qlora_bias,
      task_type: config.qlora_task_type
    }),
    training: Object.freeze({
      learning_rate: config.qlora_learning_rate,
      per_device_train_batch_size: config.qlora_batch_size,
      gradient_accumulation_steps: config.qlora_gradient_accumulation_steps,
      max_seq_length: config.qlora_max_seq_length,
      num_train_epochs: config.qlora_num_train_epochs,
      max_steps: config.qlora_max_steps,
      warmup_ratio: config.qlora_warmup_ratio,
      weight_decay: config.qlora_weight_decay,
      lr_scheduler_type: config.qlora_lr_scheduler_type,
      optim: config.qlora_optimizer,
      seed: config.qlora_seed,
      logging_steps: config.qlora_logging_steps,
      save_steps: config.training_checkpoint_interval_steps,
      save_total_limit: config.nightly_training_save_total_limit,
      save_strategy: config.qlora_save_strategy,
      report_to: splitPipeList(config.training_report_to),
      disable_tqdm: config.training_disable_tqdm
    }),
    scheduler: Object.freeze({
      mode: config.manual_training_mode,
      segment_number: config.manual_training_segment_number,
      resume_from_checkpoint: config.manual_training_resume_policy,
      control_file: null,
      control_response_file: null,
      checkpoint_before_rem: false
    })
  });
}

function buildTrainingRunArgs(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const containerName = options.containerName;
  const hfMasterPath = options.hfMasterPath || config.hf_master_path;
  const datasetDir = options.datasetDir;
  const adapterOutDir = options.adapterOutDir;
  const trainingConfigFile = options.trainingConfigFile;
  if (!containerName || !datasetDir || !adapterOutDir || !trainingConfigFile) {
    throw new Error('buildTrainingRunArgs requires containerName, datasetDir, adapterOutDir, trainingConfigFile');
  }

  const gpuArgs = splitPipeList(config.training_gpu_device_args);
  return [
    'run',
    '--rm',
    '--name', containerName,
    ...gpuArgs,
    '--security-opt=' + config.security_opt,
    '--pids-limit', String(config.training_pids_limit),
    '--memory', String(config.training_memory_limit),
    '--cpus', String(config.training_cpu_limit),
    '--network', String(config.network_mode),
    '--workdir', config.training_container_workdir,
    '-v', hfMasterPath + ':' + config.training_hf_master_mount_path + ':' + config.self_context_mount_options,
    '-v', datasetDir + ':' + config.training_dataset_mount_path + ':' + config.self_context_mount_options,
    '-v', adapterOutDir + ':' + config.training_adapter_mount_path + ':' + config.outbox_mount_options,
    '-v', trainingConfigFile + ':' + config.training_config_mount_path + ':' + config.config_mount_options,
    '-e', 'FLOKI_TRAINING_CONFIG_FILE=' + config.training_config_mount_path,
    '--entrypoint', config.training_entrypoint,
    config.training_container_image,
    config.training_script_path
  ];
}

module.exports = {
  buildTrainingConfig,
  buildTrainingRunArgs,
  splitPipeList
};
