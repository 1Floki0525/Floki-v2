'use strict';

const path = require('node:path');
const { loadYamlFile } = require('../config/yaml-lite.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const CHAT_CONFIG_PATH = path.join(ROOT, 'config', 'chat.config.yaml');
const GAME_CONFIG_PATH = path.join(ROOT, 'config', 'game.config.yaml');

const SUPPORTED_CHAT_VOICE_MODEL_SIZES = Object.freeze([
  'tiny',
  'small',
  'med',
  'large'
]);

function fail(message) {
  throw new Error(message);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(label + ' must be an object');
  }

  return value;
}

function requireString(value, expected, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(label + ' must be a non-empty string');
  }

  if (expected && value !== expected) {
    fail(label + ' must be ' + expected + ', got ' + value);
  }

  return value;
}

function requireBoolean(value, expected, label) {
  if (typeof value !== 'boolean') {
    fail(label + ' must be a boolean');
  }

  if (typeof expected === 'boolean' && value !== expected) {
    fail(label + ' must be ' + expected + ', got ' + value);
  }

  return value;
}

function readEmbodimentConfig(filePath) {
  const raw = loadYamlFile(filePath);
  return requireObject(raw.embodiment, 'embodiment');
}

function validateVoiceModelSizes(embodiment) {
  const sizes = requireObject(embodiment.voice_model_sizes, 'embodiment.voice_model_sizes');
  const enabled = [];

  for (const size of SUPPORTED_CHAT_VOICE_MODEL_SIZES) {
    requireBoolean(sizes[size], true, 'embodiment.voice_model_sizes.' + size);
    enabled.push(size);
  }

  const selected = requireString(embodiment.voice_model_size, null, 'embodiment.voice_model_size');

  if (!SUPPORTED_CHAT_VOICE_MODEL_SIZES.includes(selected)) {
    fail('embodiment.voice_model_size must be one of tiny, small, med, large');
  }

  if (sizes[selected] !== true) {
    fail('selected voice model size is not enabled: ' + selected);
  }

  return Object.freeze({
    selected,
    enabled
  });
}

function validateChatEmbodimentConfig(filePath = CHAT_CONFIG_PATH) {
  const embodiment = readEmbodimentConfig(filePath);
  const voiceSizes = validateVoiceModelSizes(embodiment);

  requireString(embodiment.realm_name, 'maker_realm', 'embodiment.realm_name');
  requireString(embodiment.realm_description, null, 'embodiment.realm_description');
  requireString(embodiment.body_source, 'host_machine', 'embodiment.body_source');
  requireString(embodiment.eyes_source, 'usb_webcam', 'embodiment.eyes_source');
  requireString(embodiment.ears_source, 'microphone', 'embodiment.ears_source');
  requireString(embodiment.voice_source, 'speakers', 'embodiment.voice_source');

  requireString(embodiment.speech_to_text_engine, 'whisper_cpp', 'embodiment.speech_to_text_engine');
  requireString(embodiment.object_vision_engine, 'yolo', 'embodiment.object_vision_engine');
  requireString(embodiment.voice_activity_engine, 'vad', 'embodiment.voice_activity_engine');
  requireString(embodiment.text_to_speech_engine, 'piper', 'embodiment.text_to_speech_engine');

  requireString(embodiment.voice_locale, 'en_US', 'embodiment.voice_locale');
  requireString(embodiment.voice_profile, null, 'embodiment.voice_profile');
  requireBoolean(embodiment.runtime_enabled_now, false, 'embodiment.runtime_enabled_now');

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_EMBODIMENT_CONFIG_STATUS',
    mode: 'chat',
    realm_name: embodiment.realm_name,
    body_source: embodiment.body_source,
    eyes_source: embodiment.eyes_source,
    ears_source: embodiment.ears_source,
    voice_source: embodiment.voice_source,
    speech_to_text_engine: embodiment.speech_to_text_engine,
    object_vision_engine: embodiment.object_vision_engine,
    voice_activity_engine: embodiment.voice_activity_engine,
    text_to_speech_engine: embodiment.text_to_speech_engine,
    voice_locale: embodiment.voice_locale,
    voice_profile: embodiment.voice_profile,
    selected_voice_model_size: voiceSizes.selected,
    supported_voice_model_sizes: voiceSizes.enabled,
    runtime_enabled_now: false,
    whisper_cpp_called: false,
    yolo_called: false,
    vad_called: false,
    piper_called: false
  });
}

function validateGameEmbodimentSeparation(filePath = GAME_CONFIG_PATH) {
  const embodiment = readEmbodimentConfig(filePath);

  requireString(embodiment.realm_name, 'minecraft_home_realm', 'game embodiment.realm_name');
  requireString(embodiment.body_source, 'minecraft_player_avatar', 'game embodiment.body_source');
  requireString(embodiment.eyes_source, 'minecraft_first_person_view', 'game embodiment.eyes_source');
  requireString(embodiment.ears_source, 'minecraft_game_events_and_chat', 'game embodiment.ears_source');
  requireString(embodiment.voice_source, 'minecraft_chat_interface', 'game embodiment.voice_source');

  requireString(embodiment.speech_to_text_engine, 'none', 'game embodiment.speech_to_text_engine');
  requireString(embodiment.object_vision_engine, 'future_minecraft_first_person_detector', 'game embodiment.object_vision_engine');
  requireString(embodiment.voice_activity_engine, 'none', 'game embodiment.voice_activity_engine');
  requireString(embodiment.text_to_speech_engine, 'minecraft_chat', 'game embodiment.text_to_speech_engine');
  requireString(embodiment.voice_model_size, 'none', 'game embodiment.voice_model_size');
  requireBoolean(embodiment.runtime_enabled_now, false, 'game embodiment.runtime_enabled_now');

  return Object.freeze({
    ok: true,
    mode: 'game',
    realm_name: embodiment.realm_name,
    body_source: embodiment.body_source,
    eyes_source: embodiment.eyes_source,
    ears_source: embodiment.ears_source,
    voice_source: embodiment.voice_source,
    runtime_enabled_now: false
  });
}

function buildChatEmbodimentConfigStatus() {
  const chat = validateChatEmbodimentConfig(CHAT_CONFIG_PATH);
  const game = validateGameEmbodimentSeparation(GAME_CONFIG_PATH);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_EMBODIMENT_CONFIG_PASS',
    chat,
    game_separation: game,
    config_source_of_truth: 'config/chat.config.yaml',
    voice_selection_change_point: 'config/chat.config.yaml embodiment.voice_profile and embodiment.voice_model_size',
    supported_voice_model_sizes: chat.supported_voice_model_sizes,
    selected_voice_model_size: chat.selected_voice_model_size,
    runtime_wiring_enabled_now: false,
    whisper_cpp_called: false,
    yolo_called: false,
    vad_called: false,
    piper_called: false,
    minecraft_called: false
  });
}

function printChatEmbodimentConfigStatus() {
  const status = buildChatEmbodimentConfigStatus();
  console.log(JSON.stringify(status, null, 2));
  return status;
}

if (require.main === module) {
  printChatEmbodimentConfigStatus();
}

module.exports = {
  CHAT_CONFIG_PATH,
  GAME_CONFIG_PATH,
  SUPPORTED_CHAT_VOICE_MODEL_SIZES,
  readEmbodimentConfig,
  validateVoiceModelSizes,
  validateChatEmbodimentConfig,
  validateGameEmbodimentSeparation,
  buildChatEmbodimentConfigStatus,
  printChatEmbodimentConfigStatus
};
