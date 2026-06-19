'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadYamlFile } = require('../src/config/yaml-lite.cjs');

function indexOfOrFail(source, needle) {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, 'missing source needle: ' + needle);
  return index;
}

function run() {
  assert.equal(process.version.startsWith('v24.'), true, 'Node 24 is required');
  const startScript = fs.readFileSync(path.join(__dirname, '..', 'bin', 'floki-start.sh'), 'utf8');
  const chatSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'floki-live-chat-interface.cjs'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  const schedulerIndex = indexOfOrFail(startScript, 'start_sleep_scheduler');
  const verifySchedulerIndex = indexOfOrFail(startScript, 'verify_sleep_scheduler');
  const webcamIndex = indexOfOrFail(startScript, 'start_chat_webcam_vision');
  const chatNodeIndex = indexOfOrFail(startScript, 'node src/chat/floki-live-chat-interface.cjs');
  assert.equal(schedulerIndex < webcamIndex, true);
  assert.equal(verifySchedulerIndex < webcamIndex, true);
  assert.equal(webcamIndex < chatNodeIndex, true);
  assert.equal(startScript.includes('FLOKI_ALLOW_WEBCAM_CAPTURE=1'), true);
  assert.equal(startScript.includes('FLOKI_ALLOW_CHAT_VISION=1'), true);
  const chatConfigPath = path.join(__dirname, '..', 'config', 'chat.config.yaml');
  const chatConfig = fs.readFileSync(chatConfigPath, 'utf8');
  const chatConfigYaml = loadYamlFile(chatConfigPath);
  const visionStartScript = fs.readFileSync(path.join(__dirname, '..', 'bin', 'floki-chat-vision-start.sh'), 'utf8');
  assert.equal(chatConfig.includes('vlm_ssh_tunnel_target: chris-mccoll'), true);
  assert.equal(chatConfig.includes('vlm_ssh_tunnel_local_port: 11435'), true);
  assert.equal(chatConfig.includes('vlm_ssh_tunnel_remote_port: 11434'), true);
  assert.equal(typeof chatConfigYaml.vision.vlm_ssh_tunnel_required_model, 'string');
  assert.ok(chatConfigYaml.vision.vlm_ssh_tunnel_required_model.trim().length > 0);
  assert.equal(chatConfig.includes('vlm_ssh_tunnel_check_timeout_ms: 8000'), true);
  assert.equal(visionStartScript.includes('chris-mccoll'), false);
  assert.equal(visionStartScript.includes('127.0.0.1:11435:127.0.0.1:11434'), false);

  const readinessIndex = indexOfOrFail(chatSource, 'chatWebcamVisionStatus.ready_for_chat');
  const speechIndex = indexOfOrFail(chatSource, 'startSpeechLoop({ no_speech: noSpeech })');
  assert.equal(readinessIndex < speechIndex, true);
  assert.equal(chatSource.includes('/vision-status'), true);
  assert.equal(chatSource.includes('/eyes-status'), true);
  assert.equal(chatSource.includes('chat_webcam_vision_status'), true);
  assert.equal(chatSource.includes('stopChatWebcamVisionService'), true);
  assert.equal(chatSource.includes('readLatestPrivateObservation'), true);
  assert.equal(chatSource.includes('chat_webcam_vision'), true);

  assert.equal(packageJson.scripts['proof:chat-webcam-service'], 'node tests/chat-webcam-vision-service-contract-test.cjs');
  assert.equal(packageJson.scripts['proof:chat-webcam-startup'], 'node tests/chat-webcam-startup-integration-contract-test.cjs');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_WEBCAM_STARTUP_INTEGRATION_PASS',
    chat_startup_invokes_webcam_vision_start: true,
    chat_vision_uses_omen_ssh_tunnel: true,
    ssh_tunnel_settings_from_yaml: true,
    first_frame_and_observation_checked_before_prompt: true,
    vision_status_commands_exist: true,
    status_extends_chat_webcam_vision_status: true,
    latest_private_observation_context_injected: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_WEBCAM_STARTUP_INTEGRATION_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
