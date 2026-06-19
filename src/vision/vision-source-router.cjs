'use strict';

const {
  loadFlokiConfig,
  getVisionConfig,
  getChatWorldVisionConfig,
  getGameWorldVisionConfig,
  getPinealVisionConfig
} = require('../config/floki-config.cjs');

const INNER_MODES = Object.freeze(new Set([
  'sleep',
  'sleeping',
  'dream',
  'dreaming',
  'reflection',
  'reflecting',
  'thinking',
  'inner_thought'
]));

function normalizeMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'chat') return 'chat';
  if (value === 'game') return 'game';
  if (INNER_MODES.has(value)) return value;
  throw new Error('unknown vision mode: ' + mode);
}

function assertVisionSourceContract(config, activeMode) {
  if (activeMode === 'chat' && config.vision.external_eyes_source !== config.chat_world_vision.source) {
    throw new Error('vision.external_eyes_source must match chat_world_vision.source');
  }
  if (activeMode === 'game' && config.vision.external_eyes_source !== config.game_world_vision.source) {
    throw new Error('vision.external_eyes_source must match game_world_vision.source');
  }
  if (config.vision.inner_vision_source !== 'pineal_mind_eye') {
    throw new Error('vision.inner_vision_source must be pineal_mind_eye');
  }
  if (activeMode === 'chat' && config.chat_world_vision.used_as_game_world_eyes !== false) {
    throw new Error('chat_world_vision.used_as_game_world_eyes must be false');
  }
}

function configModeForVisionMode(activeMode) {
  return activeMode === 'game' ? 'game' : 'chat';
}

function sourceForMode(activeMode, config) {
  if (activeMode === 'chat') {
    return {
      source: config.chat_world_vision.source,
      source_kind: 'external_physical_eyes',
      sight_scope: config.chat_world_vision.sight_scope,
      external_world_observation: true,
      internal_reality: false,
      public_transcript_visible: false,
      spoken_aloud: false
    };
  }

  if (activeMode === 'game') {
    return {
      source: config.game_world_vision.source,
      source_kind: 'external_game_world_eyes',
      sight_scope: config.game_world_vision.sight_scope,
      external_world_observation: true,
      internal_reality: false,
      public_transcript_visible: false,
      spoken_aloud: false
    };
  }

  return {
    source: config.vision.inner_vision_source,
    source_kind: 'private_inner_mind_eye',
    sight_scope: 'private_inner_dreamscape',
    external_world_observation: false,
    internal_reality: true,
    public_transcript_visible: config.pineal_vision.public_transcript_visible,
    spoken_aloud: config.pineal_vision.spoken_aloud
  };
}

function resolveVisionSource(options = {}) {
  const activeMode = normalizeMode(options.mode || 'chat');
  const configMode = options.config_mode || configModeForVisionMode(activeMode);
  const config = {
    root: loadFlokiConfig(configMode),
    vision: getVisionConfig(configMode),
    pineal_vision: getPinealVisionConfig(configMode)
  };
  if (activeMode === 'chat') {
    config.chat_world_vision = getChatWorldVisionConfig(configMode);
  }
  if (activeMode === 'game') {
    config.game_world_vision = getGameWorldVisionConfig(configMode);
  }
  const frozenConfig = Object.freeze(config);

  assertVisionSourceContract(frozenConfig, activeMode);

  const source = sourceForMode(activeMode, frozenConfig);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_VISION_SOURCE_ROUTER_PASS',
    active_mode: activeMode,
    config_mode: configMode,
    config_path: config.root.source_path,
    current_source: source.source,
    source_kind: source.source_kind,
    sight_scope: source.sight_scope,
    external_world_observation: source.external_world_observation,
    internal_reality: source.internal_reality,
    public_transcript_visible: source.public_transcript_visible,
    spoken_aloud: source.spoken_aloud,
    target_capture_fps: frozenConfig.vision.target_capture_fps,
    chat_mode_uses_webcam_eyes: true,
    game_mode_uses_first_person_game_view: true,
    pineal_mind_eye_used_for_dreams: frozenConfig.vision.inner_vision_source === 'pineal_mind_eye',
    webcam_used_as_game_world_eyes: false,
    minecraft_first_person_used_as_chat_webcam_eyes: false,
    pineal_mind_eye_treated_as_external_reality: false,
    desktop_automation_used_for_sight: false,
    mineflayer_used: false,
    pathfinding_used: false,
    rcon_body_control_used: false,
    chat_mode_only: activeMode !== 'game',
    game_mode_started: activeMode === 'game' && options.game_mode_started === true
  });
}

module.exports = {
  INNER_MODES,
  normalizeMode,
  resolveVisionSource,
  assertVisionSourceContract
};

if (require.main === module) {
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
  const mode = modeArg ? modeArg.slice('--mode='.length) : 'chat';
  try {
    console.log(JSON.stringify(resolveVisionSource({ mode }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_VISION_SOURCE_ROUTER_FAIL',
      error: error.message,
      chat_mode_only: mode !== 'game',
      game_mode_started: false
    }, null, 2));
    process.exit(1);
  }
}
