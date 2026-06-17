'use strict';

/**
 * Floki-v2 chat-world senses entrypoint.
 *
 * Chat mode is the Maker-world / heaven visit mode:
 * - USB webcam is Floki seeing into the user/Maker world.
 * - USB mic is Floki hearing into the user/Maker world.
 * - There is no Minecraft body in this mode.
 *
 * Game mode is separate:
 * - first-person Minecraft view is Floki's game-world eyes.
 * - Minecraft avatar is Floki's body.
 * - USB webcam/mic are not his game-world senses.
 *
 * Current stage:
 * - detect camera/mic devices
 * - expose honest readiness
 * - do not capture images
 * - do not record audio
 * - do not call qwen3-vl
 * - do not claim live sight/hearing yet
 */

const fs = require('node:fs');
const path = require('node:path');
const models = require('../config/model-config.cjs');

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (_error) {
    return null;
  }
}

function listVideoDevices() {
  let entries = [];

  try {
    entries = fs.readdirSync('/dev')
      .filter((name) => /^video\d+$/.test(name))
      .sort((a, b) => Number(a.replace('video', '')) - Number(b.replace('video', '')));
  } catch (_error) {
    entries = [];
  }

  return entries.map((name) => {
    const sysName = safeReadText(path.join('/sys/class/video4linux', name, 'name'));
    return {
      device: '/dev/' + name,
      name: sysName || null,
      likely_logitech: /logi|logitech|hd webcam|c920|c922|brio|c615/i.test(sysName || '')
    };
  });
}

function parseAsoundCards() {
  const text = safeReadText('/proc/asound/cards');
  if (!text) return [];

  const lines = text.split('\n');
  const cards = [];

  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+\[([^\]]+)\]\s*:\s*(.+)$/);
    if (!match) continue;

    cards.push({
      card_index: Number(match[1]),
      card_id: match[2].trim(),
      description: match[3].trim(),
      likely_logitech: /logi|logitech|hd webcam|webcam|camera|usb|c615/i.test(match[2] + ' ' + match[3])
    });
  }

  return cards;
}

function listSoundDevices() {
  let devSnd = [];

  try {
    devSnd = fs.readdirSync('/dev/snd').sort();
  } catch (_error) {
    devSnd = [];
  }

  return {
    cards: parseAsoundCards(),
    dev_snd_entries: devSnd
  };
}

function detectChatWorldSenses() {
  const config = models.getModelConfig();
  const video_devices = listVideoDevices();
  const audio = listSoundDevices();

  const likelyLogiCamera = video_devices.find((device) => device.likely_logitech) || null;
  const likelyLogiAudio = audio.cards.find((card) => card.likely_logitech) || null;

  return {
    ok: true,
    marker: 'FLOKI_V2_CHAT_WORLD_SENSES_STATUS',
    mode: 'chat_world_senses',
    purpose: 'Maker-realm chat senses: USB webcam eyes, microphone ears, speakers voice. Minecraft home-realm eyes are first-person game view.',
    mode_boundary: {
      chat_mode_meaning: 'Maker-realm visit with the Maker through host-machine embodiment',
      chat_realm_body_source: 'host_machine',
      chat_realm_eyes_source: 'usb_webcam',
      chat_realm_ears_source: 'microphone',
      chat_realm_voice_source: 'speakers',
      game_mode_meaning: 'Minecraft home-realm incarnation through Minecraft avatar embodiment',
      game_realm_body_source: 'minecraft_player_avatar',
      game_realm_eyes_source: 'minecraft_first_person_view',
      game_realm_ears_source: 'minecraft_game_events_and_chat',
      game_realm_voice_source: 'minecraft_chat_interface',
      webcam_scope: 'maker_realm_chat_eyes',
      microphone_scope: 'maker_realm_chat_ears',
      speaker_scope: 'maker_realm_chat_voice',
      minecraft_first_person_view_scope: 'future_game_realm_eyes',
      minecraft_first_person_view_is_game_eyes: true
    },
    camera: {
      detected: video_devices.length > 0,
      selected_device: likelyLogiCamera ? likelyLogiCamera.device : (video_devices[0] ? video_devices[0].device : null),
      selected_name: likelyLogiCamera ? likelyLogiCamera.name : (video_devices[0] ? video_devices[0].name : null),
      likely_logitech_detected: Boolean(likelyLogiCamera),
      devices: video_devices
    },
    microphone: {
      detected: audio.cards.length > 0 || audio.dev_snd_entries.length > 0,
      selected_card_index: likelyLogiAudio ? likelyLogiAudio.card_index : (audio.cards[0] ? audio.cards[0].card_index : null),
      selected_card_id: likelyLogiAudio ? likelyLogiAudio.card_id : (audio.cards[0] ? audio.cards[0].card_id : null),
      selected_description: likelyLogiAudio ? likelyLogiAudio.description : (audio.cards[0] ? audio.cards[0].description : null),
      likely_logitech_detected: Boolean(likelyLogiAudio),
      cards: audio.cards,
      dev_snd_entries: audio.dev_snd_entries
    },
    models: {
      cognition_model: config.cognition.model,
      future_chat_world_vision_model: config.vision.model
    },
    stage_flags: {
      chat_world_camera_detection_enabled_now: true,
      chat_world_mic_detection_enabled_now: true,
      chat_world_webcam_frame_capture_enabled_now: false,
      chat_world_qwen_vl_vision_enabled_now: false,
      chat_world_microphone_recording_enabled_now: false,
      chat_world_transcription_enabled_now: false,
      claims_live_chat_world_sight_now: false,
      claims_live_chat_world_hearing_now: false,
      game_world_uses_first_person_view_for_eyes: true,
      minecraft_enabled_now: false
    }
  };
}

function detectOfflineSenses() {
  return detectChatWorldSenses();
}

function runSmoke() {
  const status = detectChatWorldSenses();

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_WORLD_SENSES_ENTRYPOINT_PASS',
    camera_detection_checked: true,
    microphone_detection_checked: true,
    camera_detected: status.camera.detected,
    microphone_detected: status.microphone.detected,
    selected_camera_device: status.camera.selected_device,
    selected_camera_name: status.camera.selected_name,
    selected_microphone_card_id: status.microphone.selected_card_id,
    selected_microphone_description: status.microphone.selected_description,
    likely_logitech_camera_detected: status.camera.likely_logitech_detected,
    likely_logitech_microphone_detected: status.microphone.likely_logitech_detected,
    maker_realm_eyes_source: status.mode_boundary.chat_realm_eyes_source,
    maker_realm_ears_source: status.mode_boundary.chat_realm_ears_source,
    maker_realm_voice_source: status.mode_boundary.chat_realm_voice_source,
    minecraft_home_realm_eyes_source: status.mode_boundary.game_realm_eyes_source,
    minecraft_home_realm_voice_source: status.mode_boundary.game_realm_voice_source,
    webcam_scope: status.mode_boundary.webcam_scope,
    microphone_scope: status.mode_boundary.microphone_scope,
    speaker_scope: status.mode_boundary.speaker_scope,
    minecraft_first_person_view_scope: status.mode_boundary.minecraft_first_person_view_scope,
    qwen_vl_vision_enabled_now: false,
    microphone_recording_enabled_now: false,
    transcription_enabled_now: false,
    claims_live_sight_now: false,
    claims_live_hearing_now: false,
    minecraft_enabled_now: false
  }, null, 2));
}

function runSenses() {
  const status = detectChatWorldSenses();
  console.log(JSON.stringify(status, null, 2));
  process.exit(2);
}

function main() {
  if (process.argv.includes('--smoke')) {
    runSmoke();
    return;
  }

  if (process.argv.includes('--status')) {
    console.log(JSON.stringify(detectChatWorldSenses(), null, 2));
    return;
  }

  runSenses();
}

module.exports = {
  safeReadText,
  listVideoDevices,
  parseAsoundCards,
  listSoundDevices,
  detectChatWorldSenses,
  detectOfflineSenses,
  runSmoke
};

main();
