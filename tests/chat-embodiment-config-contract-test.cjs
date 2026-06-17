'use strict';

const assert = require('node:assert/strict');

const {
  SUPPORTED_CHAT_VOICE_MODEL_SIZES,
  validateVoiceModelSizes,
  validateChatEmbodimentConfig,
  validateGameEmbodimentSeparation,
  buildChatEmbodimentConfigStatus
} = require('../src/senses/chat-embodiment-config.cjs');

function run() {
  const status = buildChatEmbodimentConfigStatus();

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_CHAT_EMBODIMENT_CONFIG_PASS');
  assert.equal(status.config_source_of_truth, 'config/chat.config.yaml');

  assert.deepEqual(SUPPORTED_CHAT_VOICE_MODEL_SIZES, ['tiny', 'small', 'med', 'large']);
  assert.deepEqual(status.supported_voice_model_sizes, ['tiny', 'small', 'med', 'large']);
  assert.equal(status.selected_voice_model_size, 'large');

  assert.equal(status.chat.realm_name, 'maker_realm');
  assert.equal(status.chat.body_source, 'host_machine');
  assert.equal(status.chat.eyes_source, 'usb_webcam');
  assert.equal(status.chat.ears_source, 'microphone');
  assert.equal(status.chat.voice_source, 'speakers');

  assert.equal(status.chat.speech_to_text_engine, 'whisper_cpp');
  assert.equal(status.chat.object_vision_engine, 'yolo');
  assert.equal(status.chat.voice_activity_engine, 'vad');
  assert.equal(status.chat.text_to_speech_engine, 'piper');
  assert.equal(status.chat.voice_locale, 'en_US');
  assert.equal(status.chat.voice_profile, 'us_english_male_ryan');
  assert.equal(status.chat.runtime_enabled_now, false);

  assert.equal(status.game_separation.realm_name, 'minecraft_home_realm');
  assert.equal(status.game_separation.body_source, 'minecraft_player_avatar');
  assert.equal(status.game_separation.eyes_source, 'minecraft_first_person_view');
  assert.equal(status.game_separation.ears_source, 'minecraft_game_events_and_chat');
  assert.equal(status.game_separation.voice_source, 'minecraft_chat_interface');
  assert.equal(status.game_separation.runtime_enabled_now, false);

  assert.equal(status.runtime_wiring_enabled_now, false);
  assert.equal(status.whisper_cpp_called, false);
  assert.equal(status.yolo_called, false);
  assert.equal(status.vad_called, false);
  assert.equal(status.piper_called, false);
  assert.equal(status.minecraft_called, false);

  const chat = validateChatEmbodimentConfig();
  const game = validateGameEmbodimentSeparation();

  assert.equal(chat.marker, 'FLOKI_V2_CHAT_EMBODIMENT_CONFIG_STATUS');
  assert.equal(game.mode, 'game');

  assert.throws(() => {
    validateVoiceModelSizes({
      voice_model_size: 'giant',
      voice_model_sizes: {
        tiny: true,
        small: true,
        med: true,
        large: true
      }
    });
  }, /voice_model_size must be one of tiny, small, med, large/);

  assert.throws(() => {
    validateVoiceModelSizes({
      voice_model_size: 'small',
      voice_model_sizes: {
        tiny: true,
        small: false,
        med: true,
        large: true
      }
    });
  }, /embodiment.voice_model_sizes.small must be true/);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_EMBODIMENT_CONFIG_PASS',
    chat_realm_body_source: status.chat.body_source,
    chat_realm_eyes_source: status.chat.eyes_source,
    chat_realm_ears_source: status.chat.ears_source,
    chat_realm_voice_source: status.chat.voice_source,
    speech_to_text_engine: status.chat.speech_to_text_engine,
    object_vision_engine: status.chat.object_vision_engine,
    voice_activity_engine: status.chat.voice_activity_engine,
    text_to_speech_engine: status.chat.text_to_speech_engine,
    selected_voice_model_size: status.selected_voice_model_size,
    supported_voice_model_sizes: status.supported_voice_model_sizes,
    game_realm_eyes_source: status.game_separation.eyes_source,
    runtime_wiring_enabled_now: false,
    whisper_cpp_called: false,
    yolo_called: false,
    vad_called: false,
    piper_called: false
  }, null, 2));
}

run();
