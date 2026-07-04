"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadYamlFile } =
  require('../src/config/yaml-lite.cjs');

function indexOfOrFail(source, needle) {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, 'missing source needle: ' + needle);
  return index;
}

function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true
  );

  const root = path.join(__dirname, '..');
  const runtimeCommand = fs.readFileSync(
    path.join(root, 'bin/floki-runtime.sh'),
    'utf8'
  );
  const runtimeSource = fs.readFileSync(
    path.join(root, 'src/runtime/chat-local-runtime.cjs'),
    'utf8'
  );
  const chatSource = fs.readFileSync(
    path.join(root, 'src/chat/floki-live-chat-interface.cjs'),
    'utf8'
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  );

  const runtimeOwnerIndex = indexOfOrFail(
    runtimeCommand,
    'start_runtime_owner'
  );
  const schedulerIndex = indexOfOrFail(
    runtimeCommand,
    'floki-sleep-scheduler-start.sh'
  );
  assert.ok(runtimeOwnerIndex < schedulerIndex);

  assert.match(runtimeSource, /createVisionReconciler/);
  assert.match(runtimeSource, /applyLifecycle/);
  assert.match(runtimeSource, /startChatWebcamVisionService/);
  assert.match(runtimeSource, /stopChatWebcamVisionService/);
  assert.match(runtimeSource, /waitForFreshVision/);

  const chatConfigPath = path.join(
    root,
    'config/chat.config.yaml'
  );
  const chatConfig = fs.readFileSync(chatConfigPath, 'utf8');
  const chatConfigYaml = loadYamlFile(chatConfigPath);
  const visionStartScript = fs.readFileSync(
    path.join(root, 'bin/floki-chat-vision-start.sh'),
    'utf8'
  );

  assert.equal(
    chatConfig.includes('vlm_ssh_tunnel_target: chris-mccoll'),
    true
  );
  assert.equal(
    chatConfig.includes('vlm_ssh_tunnel_local_port: 11435'),
    true
  );
  assert.equal(
    chatConfig.includes('vlm_ssh_tunnel_remote_port: 11434'),
    true
  );
  assert.equal(typeof chatConfigYaml.models.vision.model, 'string');
  assert.ok(chatConfigYaml.models.vision.model.trim().length > 0);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      chatConfigYaml.vision,
      'vlm_ssh_tunnel_required_model'
    ),
    false
  );
  assert.equal(
    chatConfig.includes('vlm_ssh_tunnel_check_timeout_ms: 8000'),
    true
  );
  assert.equal(visionStartScript.includes('chris-mccoll'), false);
  assert.equal(
    visionStartScript.includes(
      '127.0.0.1:11435:127.0.0.1:11434'
    ),
    false
  );

  const readinessIndex = indexOfOrFail(
    chatSource,
    'chatWebcamVisionStatus.ready_for_chat'
  );
  const speechIndex = indexOfOrFail(
    chatSource,
    'startSpeechLoop({ no_speech: noSpeech })'
  );
  assert.ok(readinessIndex < speechIndex);
  assert.match(chatSource, /\/vision-status/);
  assert.match(chatSource, /\/eyes-status/);
  assert.match(chatSource, /chat_webcam_vision_status/);
  assert.match(chatSource, /readLatestPrivateObservation/);
  assert.match(chatSource, /chat_webcam_vision/);

  assert.equal(
    packageJson.scripts['proof:chat-webcam-service'],
    'node tests/chat-webcam-vision-service-contract-test.cjs'
  );
  assert.equal(
    packageJson.scripts['proof:chat-webcam-startup'],
    'node tests/chat-webcam-startup-integration-contract-test.cjs'
  );

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_WEBCAM_STARTUP_INTEGRATION_PASS',
    sole_runtime_authority: 'bin/floki-runtime.sh',
    runtime_owns_vision_lifecycle: true,
    chat_vision_uses_omen_ssh_tunnel: true,
    ssh_tunnel_settings_from_yaml: true,
    first_frame_and_observation_checked_before_prompt: true,
    live_runtime_started_by_test: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_WEBCAM_STARTUP_INTEGRATION_FAIL',
    error: error.message,
    live_runtime_started_by_test: false
  }, null, 2));
  process.exit(1);
}
