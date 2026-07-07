'use strict';

/**
 * Floki-v2 model config.
 *
 * Loads model configuration from YAML via the config authority layer.
 * No hardcoded model names, temperatures, or timeouts.
 * The YAML file is the single source of truth.
 */

const { loadFlokiConfig } = require('./floki-config.cjs');

function getModelConfig(mode) {
  const config = loadFlokiConfig(mode || 'chat');
  const cognition = config.models.cognition;
  const vision = config.models.vision;

  return Object.freeze({
    stage: 'stage_07_affect_scaffold_no_cognition_calls',

    cognition: Object.freeze({
      provider: cognition.provider,
      model: cognition.model,
      endpoint: cognition.endpoint,
      enabled_in_current_stage: false,
      wire_in_batch: 'stage_08_frontal_temporal_qwen_cognition',
      allow_thinking: true,
      expose_private_reasoning: false,
      store_raw_private_reasoning: false,
      store_safe_reasoning_summary: true,
      temperature: cognition.temperature,
      top_p: cognition.top_p,
      timeout_ms: cognition.timeout_ms,
      keep_alive: cognition.keep_alive,
      hf: cognition.hf || null
    }),

    vision: Object.freeze({
      provider: vision.provider,
      model: vision.model,
      endpoint: vision.endpoint,
      local_endpoint: vision.local_endpoint || null,
      enabled_in_current_stage: false,
      wire_in_batch: 'future_static_png_then_live_minecraft_eyes',
      allow_thinking: false,
      reject_think_tags: true,
      expose_private_reasoning: false,
      store_raw_private_reasoning: false,
      store_safe_observation_summary: true,
      temperature: vision.temperature,
      top_p: vision.top_p,
      timeout_ms: vision.timeout_ms,
      keep_alive: vision.keep_alive
    }),

    stage_flags: Object.freeze({
      affect_scaffold_enabled_now: true,
      reflective_emotion_enabled_now: false,
      cognition_enabled_now: false,
      broca_enabled_now: false,
      minecraft_enabled_now: false,
      body_enabled_now: false,
      eyes_enabled_now: false
    }),

    forbidden: Object.freeze({
      minecraft_in_current_stage: true,
      mineflayer: true,
      pathfinding_libraries: true,
      rcon_body_control: true,
      desktop_automation: true,
      host_screenshot_vision: true,
      fake_success: true,
      raw_private_reasoning_storage: true
    })
  });
}

function validateModelConfig(modelConfig) {
  if (modelConfig === null || typeof modelConfig !== 'object' || Array.isArray(modelConfig)) {
    throw new TypeError('model config must be a plain object');
  }

  function assertNonEmptyString(value, fieldName) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(fieldName + ' must be a non-empty string');
    }
  }

  function assertBoolean(value, fieldName) {
    if (typeof value !== 'boolean') {
      throw new TypeError(fieldName + ' must be boolean');
    }
  }

  function assertFiniteNumber(value, fieldName) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(fieldName + ' must be a finite number');
    }
  }

  assertNonEmptyString(modelConfig.stage, 'model config stage');
  assertNonEmptyString(modelConfig.cognition.provider, 'cognition provider');
  assertNonEmptyString(modelConfig.cognition.model, 'cognition model');
  assertNonEmptyString(modelConfig.cognition.endpoint, 'cognition endpoint');
  assertBoolean(modelConfig.cognition.enabled_in_current_stage, 'cognition.enabled_in_current_stage');
  assertBoolean(modelConfig.cognition.allow_thinking, 'cognition.allow_thinking');
  assertBoolean(modelConfig.cognition.expose_private_reasoning, 'cognition.expose_private_reasoning');
  assertBoolean(modelConfig.cognition.store_raw_private_reasoning, 'cognition.store_raw_private_reasoning');
  assertBoolean(modelConfig.cognition.store_safe_reasoning_summary, 'cognition.store_safe_reasoning_summary');
  assertFiniteNumber(modelConfig.cognition.temperature, 'cognition temperature');
  assertFiniteNumber(modelConfig.cognition.top_p, 'cognition top_p');
  assertFiniteNumber(modelConfig.cognition.timeout_ms, 'cognition timeout_ms');

  assertNonEmptyString(modelConfig.vision.provider, 'vision provider');
  assertNonEmptyString(modelConfig.vision.model, 'vision model');
  assertNonEmptyString(modelConfig.vision.endpoint, 'vision endpoint');
  assertBoolean(modelConfig.vision.enabled_in_current_stage, 'vision.enabled_in_current_stage');
  assertBoolean(modelConfig.vision.allow_thinking, 'vision.allow_thinking');
  assertBoolean(modelConfig.vision.reject_think_tags, 'vision.reject_think_tags');
  assertBoolean(modelConfig.vision.expose_private_reasoning, 'vision.expose_private_reasoning');
  assertBoolean(modelConfig.vision.store_raw_private_reasoning, 'vision.store_raw_private_reasoning');
  assertBoolean(modelConfig.vision.store_safe_observation_summary, 'vision.store_safe_observation_summary');
  assertFiniteNumber(modelConfig.vision.temperature, 'vision temperature');
  assertFiniteNumber(modelConfig.vision.top_p, 'vision top_p');
  assertFiniteNumber(modelConfig.vision.timeout_ms, 'vision timeout_ms');

  if (modelConfig.cognition.enabled_in_current_stage !== false) {
    throw new Error('cognition calls must remain disabled until Batch 08');
  }

  if (modelConfig.vision.enabled_in_current_stage !== false) {
    throw new Error('vision calls must remain disabled until the eyes stage');
  }

  if (modelConfig.vision.allow_thinking !== false) {
    throw new Error('vision thinking must stay disabled');
  }

  return true;
}

function getCognitionConfig(mode) {
  const config = getModelConfig(mode);
  validateModelConfig(config);
  return config.cognition;
}

function getVisionConfig(mode) {
  const config = getModelConfig(mode);
  validateModelConfig(config);
  return config.vision;
}

function getStageFlags(mode) {
  const config = getModelConfig(mode);
  validateModelConfig(config);
  return config.stage_flags;
}

const MODEL_CONFIG = getModelConfig('chat');
validateModelConfig(MODEL_CONFIG);

module.exports = {
  stage: MODEL_CONFIG.stage,
  cognition: MODEL_CONFIG.cognition,
  vision: MODEL_CONFIG.vision,
  stage_flags: MODEL_CONFIG.stage_flags,
  forbidden: MODEL_CONFIG.forbidden,
  MODEL_CONFIG,
  getModelConfig,
  getCognitionConfig,
  getVisionConfig,
  getStageFlags,
  validateModelConfig
};
