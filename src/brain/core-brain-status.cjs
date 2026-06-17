'use strict';

const { loadYamlFile } = require('../config/yaml-lite.cjs');

const {
  KNOWN_MODULES,
  createCoreBrain,
  loadCoreBrainConfig,
  validateCoreBrainConfig,
  enabledModuleNames,
  disabledModuleNames,
  missingRequiredModules,
  enabledModulesWithoutFactories,
  registeredModuleNames,
  unregisteredKnownModuleNames
} = require('../../brain/core_brain/index.cjs');

function publicModelStatus(modelConfig) {
  return Object.freeze({
    provider: modelConfig.provider,
    model: modelConfig.model,
    endpoint: modelConfig.endpoint,
    enabled_now: modelConfig.enabled_now === true,
    mode_scope: modelConfig.mode_scope || '',
    temperature: modelConfig.temperature,
    top_p: modelConfig.top_p,
    timeout_ms: modelConfig.timeout_ms,
    keep_alive: modelConfig.keep_alive,
    allow_thinking: modelConfig.allow_thinking === true,
    expose_private_reasoning: modelConfig.expose_private_reasoning === true,
    store_raw_private_reasoning: modelConfig.store_raw_private_reasoning === true
  });
}

function sortedObjectKeys(value) {
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.keys(value).sort();
}

function rawEmbodimentFromConfig(config) {
  const raw = loadYamlFile(config.source_path);

  if (!raw.embodiment || typeof raw.embodiment !== 'object') {
    return Object.freeze({});
  }

  return Object.freeze({ ...raw.embodiment });
}

function modeBoundaryStatus(config, embodiment) {
  const chatMode = config.mode === 'chat';
  const gameMode = config.mode === 'game';

  return Object.freeze({
    active_mode: config.mode,
    chat_mode_means: 'Maker-realm visit using host-machine embodiment',
    game_mode_means: 'Minecraft home-realm incarnation using Minecraft avatar embodiment',
    shared_brain_stack: true,
    separate_embodiment_stack: true,

    chat_realm_body_source: chatMode ? embodiment.body_source : 'not_loaded',
    chat_realm_eyes_source: chatMode ? embodiment.eyes_source : 'not_loaded',
    chat_realm_ears_source: chatMode ? embodiment.ears_source : 'not_loaded',
    chat_realm_voice_source: chatMode ? embodiment.voice_source : 'not_loaded',

    game_realm_body_source: gameMode ? embodiment.body_source : 'not_loaded',
    game_realm_eyes_source: gameMode ? embodiment.eyes_source : 'minecraft_first_person_view',
    game_realm_ears_source: gameMode ? embodiment.ears_source : 'minecraft_game_events_and_chat',
    game_realm_voice_source: gameMode ? embodiment.voice_source : 'minecraft_chat_interface',

    webcam_scope: chatMode ? 'maker_realm_chat_eyes' : 'not_game_eyes',
    microphone_scope: chatMode ? 'maker_realm_chat_ears' : 'not_game_ears',
    speaker_scope: chatMode ? 'maker_realm_chat_voice' : 'not_game_voice',
    minecraft_first_person_view_scope: gameMode ? 'game_realm_eyes' : 'future_game_realm_eyes',

    minecraft_enabled_now: config.policies.minecraft_enabled_now === true,
    body_enabled_now: config.policies.body_enabled_now === true,
    game_world_eyes_enabled_now: config.policies.game_world_eyes_enabled_now === true,
    qwen_vl_live_vision_enabled_now: config.models.vision.enabled_now === true,
    raw_private_reasoning_storage: config.policies.raw_private_reasoning_storage === true,

    game_mode_chat_world_senses_loaded: gameMode && config.modules.chat_world_senses.enabled === true
  });
}

function voiceToolchainStatus(config, embodiment) {
  const voiceSizes = embodiment.voice_model_sizes && typeof embodiment.voice_model_sizes === 'object'
    ? Object.freeze({ ...embodiment.voice_model_sizes })
    : Object.freeze({});

  return Object.freeze({
    mode: config.mode,
    speech_to_text_engine: embodiment.speech_to_text_engine || 'none',
    object_vision_engine: embodiment.object_vision_engine || 'none',
    voice_activity_engine: embodiment.voice_activity_engine || 'none',
    text_to_speech_engine: embodiment.text_to_speech_engine || 'none',
    voice_locale: embodiment.voice_locale || 'none',
    voice_profile: embodiment.voice_profile || 'none',
    voice_model_size: embodiment.voice_model_size || 'none',
    voice_model_sizes: voiceSizes,
    runtime_enabled_now: embodiment.runtime_enabled_now === true
  });
}

function buildCoreBrainStatus(modeOrPath, options = {}) {
  const config = loadCoreBrainConfig(modeOrPath || 'chat');
  validateCoreBrainConfig(config);

  const core = createCoreBrain({
    mode: config.mode,
    config,
    session_id: options.session_id || 'core-brain-status-' + config.mode,
    persist_diagnostics: false
  });

  const embodiment = rawEmbodimentFromConfig(config);
  const enabled = enabledModuleNames(config.modules);
  const disabled = disabledModuleNames(config.modules);
  const loadedRuntimeModules = sortedObjectKeys(core.modules);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CORE_BRAIN_STATUS_REPORT',
    module: 'core_brain_status',
    active_mode: config.mode,
    session_id: core.session_id,
    config_path: config.source_path,
    schema_version: config.schema_version,

    models: Object.freeze({
      cognition: publicModelStatus(config.models.cognition),
      vision: publicModelStatus(config.models.vision)
    }),

    embodiment: Object.freeze({
      realm_name: embodiment.realm_name || '',
      realm_description: embodiment.realm_description || '',
      body_source: embodiment.body_source || '',
      eyes_source: embodiment.eyes_source || '',
      ears_source: embodiment.ears_source || '',
      voice_source: embodiment.voice_source || ''
    }),

    voice_toolchain: voiceToolchainStatus(config, embodiment),

    modules: Object.freeze({
      known_modules: KNOWN_MODULES.slice(),
      enabled_modules: enabled,
      disabled_modules: disabled,
      registered_factories: registeredModuleNames(),
      unregistered_known_modules: unregisteredKnownModuleNames(),
      enabled_modules_without_factories: enabledModulesWithoutFactories(config),
      missing_required_modules: missingRequiredModules(config),
      loaded_runtime_modules: loadedRuntimeModules
    }),

    boundaries: modeBoundaryStatus(config, embodiment),

    policies: Object.freeze({ ...config.policies }),

    runtime: Object.freeze({
      core_brain_loaded: true,
      runtime_module_count: loadedRuntimeModules.length,
      loaded_runtime_modules: loadedRuntimeModules,
      qwen_called: false,
      whisper_cpp_called: false,
      yolo_called: false,
      vad_called: false,
      piper_called: false,
      minecraft_called: false,
      body_called: false,
      eyes_called: false
    })
  });
}

function printCoreBrainStatus(modeOrPath) {
  const status = buildCoreBrainStatus(modeOrPath);
  console.log(JSON.stringify(status, null, 2));
  return status;
}

if (require.main === module) {
  const mode = process.argv[2] || 'chat';
  printCoreBrainStatus(mode);
}

module.exports = {
  publicModelStatus,
  rawEmbodimentFromConfig,
  modeBoundaryStatus,
  voiceToolchainStatus,
  buildCoreBrainStatus,
  printCoreBrainStatus
};
