'use strict';

const path = require('node:path');
const {
  PROJECT_ROOT,
  getModelConfig,
  getPathConfig,
  getSelfImprovementConfig
} = require('../config/floki-config.cjs');

function resolveProjectPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('self-improvement path must be a non-empty string');
  }
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function loadSelfImprovementConfig() {
  const raw = getSelfImprovementConfig('chat');
  const paths = getPathConfig('chat');
  const model = getModelConfig('chat').cognition;
  return Object.freeze({
    ...raw,
    project_root: PROJECT_ROOT,
    chat_runtime_root: path.resolve(PROJECT_ROOT, paths.chat_runtime_root),
    workspace_root: resolveProjectPath(raw.workspace_root),
    candidate_root: resolveProjectPath(raw.candidate_root),
    outbox_root: resolveProjectPath(raw.outbox_root),
    runtime_root: resolveProjectPath(raw.runtime_root),
    model_proxy_root: resolveProjectPath(raw.model_proxy_root),
    adapter_root: resolveProjectPath(raw.adapter_root),
    dataset_root: resolveProjectPath(raw.dataset_root),
    training_runtime_root: resolveProjectPath(raw.training_runtime_root),
    gpu_ownership_lock_file: resolveProjectPath(raw.gpu_ownership_lock_file),
    model: Object.freeze({
      provider: model.provider,
      name: model.model,
      endpoint: model.endpoint,
      temperature: model.temperature,
      top_p: model.top_p,
      timeout_ms: model.timeout_ms,
      keep_alive: model.keep_alive
    })
  });
}

module.exports = {
  loadSelfImprovementConfig,
  resolveProjectPath
};
