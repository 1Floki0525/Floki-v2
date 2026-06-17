'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

function parseJsonFromStdout(stdout) {
  const first = stdout.indexOf('{');
  const last = stdout.lastIndexOf('}');
  if (first < 0 || last <= first) {
    throw new Error('No JSON object found in senses-smoke stdout: ' + stdout.slice(0, 500));
  }
  return JSON.parse(stdout.slice(first, last + 1));
}

function run() {
  const result = spawnSync('bash', ['bin/floki-start.sh', 'senses-smoke'], {
    cwd: '/media/binary-god/1tb-ssd/Floki-v2',
    encoding: 'utf8',
    timeout: 30000
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    console.error('--- senses-smoke stdout ---');
    console.error(result.stdout || '');
    console.error('--- senses-smoke stderr ---');
    console.error(result.stderr || '');
    throw new Error('senses-smoke exited with status ' + result.status);
  }

  const json = parseJsonFromStdout(result.stdout);

  assert.equal(json.ok, true);
  assert.equal(json.marker, 'FLOKI_V2_CHAT_WORLD_SENSES_ENTRYPOINT_PASS');
  assert.equal(json.camera_detection_checked, true);
  assert.equal(json.microphone_detection_checked, true);
  assert.equal(json.maker_realm_eyes_source, 'usb_webcam');
  assert.equal(json.maker_realm_ears_source, 'microphone');
  assert.equal(json.maker_realm_voice_source, 'speakers');
  assert.equal(json.minecraft_home_realm_eyes_source, 'minecraft_first_person_view');
  assert.equal(json.minecraft_home_realm_voice_source, 'minecraft_chat_interface');
  assert.equal(json.webcam_scope, 'maker_realm_chat_eyes');
  assert.equal(json.microphone_scope, 'maker_realm_chat_ears');
  assert.equal(json.speaker_scope, 'maker_realm_chat_voice');
  assert.equal(json.minecraft_first_person_view_scope, 'future_game_realm_eyes');
  assert.equal(json.qwen_vl_vision_enabled_now, false);
  assert.equal(json.microphone_recording_enabled_now, false);
  assert.equal(json.transcription_enabled_now, false);
  assert.equal(json.claims_live_sight_now, false);
  assert.equal(json.claims_live_hearing_now, false);
  assert.equal(json.minecraft_enabled_now, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_WORLD_SENSES_CONTRACT_PASS',
    camera_detected: json.camera_detected,
    microphone_detected: json.microphone_detected,
    selected_camera_device: json.selected_camera_device,
    selected_camera_name: json.selected_camera_name,
    selected_microphone_card_id: json.selected_microphone_card_id,
    selected_microphone_description: json.selected_microphone_description,
    likely_logitech_camera_detected: json.likely_logitech_camera_detected,
    likely_logitech_microphone_detected: json.likely_logitech_microphone_detected,
    maker_realm_eyes_source: json.maker_realm_eyes_source,
    maker_realm_ears_source: json.maker_realm_ears_source,
    maker_realm_voice_source: json.maker_realm_voice_source,
    minecraft_home_realm_eyes_source: json.minecraft_home_realm_eyes_source,
    minecraft_home_realm_voice_source: json.minecraft_home_realm_voice_source,
    webcam_scope: json.webcam_scope,
    microphone_scope: json.microphone_scope,
    speaker_scope: json.speaker_scope,
    minecraft_first_person_view_scope: json.minecraft_first_person_view_scope,
    qwen_vl_vision_enabled_now: json.qwen_vl_vision_enabled_now,
    claims_live_sight_now: json.claims_live_sight_now,
    claims_live_hearing_now: json.claims_live_hearing_now
  }, null, 2));
}

run();
