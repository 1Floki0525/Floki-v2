'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const {
  buildCoreBrainStatus
} = require('../src/brain/core-brain-status.cjs');

function assertSafeRuntime(status) {
  assert.equal(status.marker, 'FLOKI_V2_CORE_BRAIN_STATUS_REPORT');
  assert.equal(status.ok, true);

  assert.equal(status.runtime.qwen_called, false);
  assert.equal(status.runtime.whisper_cpp_called, false);
  assert.equal(status.runtime.yolo_called, false);
  assert.equal(status.runtime.vad_called, false);
  assert.equal(status.runtime.piper_called, false);
  assert.equal(status.runtime.minecraft_called, false);
  assert.equal(status.runtime.body_called, false);
  assert.equal(status.runtime.eyes_called, false);

  assert.equal(status.boundaries.minecraft_enabled_now, false);
  assert.equal(status.boundaries.body_enabled_now, false);
  assert.equal(status.boundaries.game_world_eyes_enabled_now, false);
  assert.equal(status.boundaries.qwen_vl_live_vision_enabled_now, false);
  assert.equal(status.boundaries.raw_private_reasoning_storage, false);

  assert.deepEqual(status.modules.enabled_modules_without_factories, []);
  assert.deepEqual(status.modules.missing_required_modules, []);

  assert.equal(status.models.cognition.store_raw_private_reasoning, false);
  assert.equal(status.models.cognition.expose_private_reasoning, false);
  assert.equal(status.models.vision.store_raw_private_reasoning, false);
  assert.equal(status.models.vision.expose_private_reasoning, false);
}

function run() {
  const chat = buildCoreBrainStatus('chat');
  const game = buildCoreBrainStatus('game');

  assertSafeRuntime(chat);
  assertSafeRuntime(game);

  assert.equal(chat.active_mode, 'chat');
  assert.equal(game.active_mode, 'game');

  assert.equal(chat.config_path.endsWith('/config/chat.config.yaml'), true);
  assert.equal(game.config_path.endsWith('/config/game.config.yaml'), true);

  assert.ok(typeof chat.models.cognition.model === 'string' && chat.models.cognition.model.length > 0, 'chat cognition model from YAML must be non-empty');
  assert.ok(typeof chat.models.vision.model === 'string' && chat.models.vision.model.length > 0, 'chat vision model from YAML must be non-empty');
  assert.ok(typeof game.models.cognition.model === 'string' && game.models.cognition.model.length > 0, 'game cognition model from YAML must be non-empty');
  assert.ok(typeof game.models.vision.model === 'string' && game.models.vision.model.length > 0, 'game vision model from YAML must be non-empty');

  assert.equal(chat.embodiment.realm_name, 'maker_realm');
  assert.equal(chat.embodiment.body_source, 'host_machine');
  assert.equal(chat.embodiment.eyes_source, 'usb_webcam');
  assert.equal(chat.embodiment.ears_source, 'microphone');
  assert.equal(chat.embodiment.voice_source, 'speakers');

  assert.equal(chat.voice_toolchain.speech_to_text_engine, 'whisper_cpp');
  assert.equal(chat.voice_toolchain.object_vision_engine, 'yolo');
  assert.equal(chat.voice_toolchain.voice_activity_engine, 'vad');
  assert.equal(chat.voice_toolchain.text_to_speech_engine, 'piper');
  assert.equal(chat.voice_toolchain.voice_locale, 'en_US');
  assert.equal(chat.voice_toolchain.voice_model_sizes.tiny, true);
  assert.equal(chat.voice_toolchain.voice_model_sizes.small, true);
  assert.equal(chat.voice_toolchain.voice_model_sizes.med, true);
  assert.equal(chat.voice_toolchain.voice_model_sizes.large, true);
  assert.equal(chat.voice_toolchain.runtime_enabled_now, false);

  assert.equal(game.embodiment.realm_name, 'minecraft_home_realm');
  assert.equal(game.embodiment.body_source, 'minecraft_player_avatar');
  assert.equal(game.embodiment.eyes_source, 'minecraft_first_person_view');
  assert.equal(game.embodiment.ears_source, 'minecraft_game_events_and_chat');
  assert.equal(game.embodiment.voice_source, 'minecraft_chat_interface');

  assert.equal(chat.boundaries.webcam_scope, 'maker_realm_chat_eyes');
  assert.equal(chat.boundaries.microphone_scope, 'maker_realm_chat_ears');
  assert.equal(chat.boundaries.speaker_scope, 'maker_realm_chat_voice');
  assert.equal(chat.boundaries.minecraft_first_person_view_scope, 'future_game_realm_eyes');

  assert.equal(game.boundaries.webcam_scope, 'not_game_eyes');
  assert.equal(game.boundaries.microphone_scope, 'not_game_ears');
  assert.equal(game.boundaries.speaker_scope, 'not_game_voice');
  assert.equal(game.boundaries.minecraft_first_person_view_scope, 'game_realm_eyes');

  assert.equal(chat.modules.enabled_modules.includes('chat_world_senses'), true);
  assert.equal(chat.modules.loaded_runtime_modules.includes('chat_world_senses'), true);
  assert.equal(game.modules.enabled_modules.includes('chat_world_senses'), false);
  assert.equal(game.modules.loaded_runtime_modules.includes('chat_world_senses'), false);

  assert.equal(chat.modules.disabled_modules.includes('game_world_eyes'), true);
  assert.equal(chat.modules.disabled_modules.includes('game_world_body'), true);
  assert.equal(game.modules.disabled_modules.includes('game_world_eyes'), true);
  assert.equal(game.modules.disabled_modules.includes('game_world_body'), true);

  const cliChat = execFileSync(process.execPath, ['src/brain/core-brain-status.cjs', 'chat'], {
    cwd: ROOT,
    encoding: 'utf8'
  });

  const parsedCliChat = JSON.parse(cliChat);
  assert.equal(parsedCliChat.marker, 'FLOKI_V2_CORE_BRAIN_STATUS_REPORT');
  assert.equal(parsedCliChat.active_mode, 'chat');
  assert.equal(parsedCliChat.embodiment.eyes_source, 'usb_webcam');

  const cliGame = execFileSync(process.execPath, ['src/brain/core-brain-status.cjs', 'game'], {
    cwd: ROOT,
    encoding: 'utf8'
  });

  const parsedCliGame = JSON.parse(cliGame);
  assert.equal(parsedCliGame.marker, 'FLOKI_V2_CORE_BRAIN_STATUS_REPORT');
  assert.equal(parsedCliGame.active_mode, 'game');
  assert.equal(parsedCliGame.embodiment.eyes_source, 'minecraft_first_person_view');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CORE_BRAIN_STATUS_PASS',
    chat_mode: chat.active_mode,
    game_mode: game.active_mode,
    chat_realm_eyes_source: chat.embodiment.eyes_source,
    chat_realm_ears_source: chat.embodiment.ears_source,
    chat_realm_voice_source: chat.embodiment.voice_source,
    game_realm_eyes_source: game.embodiment.eyes_source,
    game_realm_voice_source: game.embodiment.voice_source,
    chat_voice_toolchain_declared: true,
    whisper_cpp_called: false,
    yolo_called: false,
    vad_called: false,
    piper_called: false,
    minecraft_called: false,
    body_called: false,
    eyes_called: false
  }, null, 2));
}

run();
