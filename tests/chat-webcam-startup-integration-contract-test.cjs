"use strict";

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
  assert.equal(Number(process.versions.node.split('.')[0]) >= 24, true);

  const root = path.join(__dirname, '..');
  const runtimeCommand = fs.readFileSync(path.join(root, 'bin/floki-runtime.sh'), 'utf8');
  const runtimeSource = fs.readFileSync(path.join(root, 'src/runtime/chat-local-runtime.cjs'), 'utf8');
  const chatSource = fs.readFileSync(path.join(root, 'src/chat/floki-live-chat-interface.cjs'), 'utf8');
  const visionServiceSource = fs.readFileSync(path.join(root, 'src/vision/chat-webcam-vision-service.cjs'), 'utf8');
  const chatConfigPath = path.join(root, 'config/chat.config.yaml');
  const chatConfig = fs.readFileSync(chatConfigPath, 'utf8');
  const chatConfigYaml = loadYamlFile(chatConfigPath);
  const visionStartScript = fs.readFileSync(path.join(root, 'bin/floki-chat-vision-start.sh'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  const removedRemoteVisionSshHost = ['chris', 'mccoll'].join('-');
  const removedRemoteVisionForward = ['127.0.0.1', '11435', '127.0.0.1', '11434'].join(':');
  const staleTunnelKey = /(?:vlm_ssh_tunnel_|local_hf_vision_)/;

  const removedCompactModelTag = ['qwen3.5', '4b'].join(':');
  const removedVisionModelTag = ['qwen3-vl', '4b'].join(':');

  const runtimeOwnerIndex = indexOfOrFail(runtimeCommand, 'start_runtime_owner');
  const schedulerIndex = indexOfOrFail(runtimeCommand, 'floki-sleep-scheduler-start.sh');
  assert.ok(runtimeOwnerIndex < schedulerIndex);

  assert.match(runtimeSource, /createVisionReconciler/);
  assert.match(runtimeSource, /applyLifecycle/);
  assert.match(runtimeSource, /startChatWebcamVisionService/);
  assert.match(runtimeSource, /stopChatWebcamVisionService/);
  assert.match(runtimeSource, /waitForFreshVision/);

  assert.equal(typeof chatConfigYaml.models.vision.model, 'string');
  assert.ok(chatConfigYaml.models.vision.model.trim().length > 0);

  assert.equal(staleTunnelKey.test(chatConfig), false, 'chat YAML must not contain old or renamed webHost tunnel keys');
  assert.equal(chatConfig.includes(removedRemoteVisionSshHost), false, 'chat YAML must not contain old webHost SSH host');
  assert.equal(chatConfig.includes(removedRemoteVisionForward), false, 'chat YAML must not contain old webHost SSH forward');

  const vision = chatConfigYaml.vision || {};
  for (const key of Object.keys(vision)) {
    assert.equal(
      staleTunnelKey.test(key),
      false,
      'vision config must not contain stale tunnel key: ' + key
    );
  }

  assert.equal(visionStartScript.includes(removedRemoteVisionSshHost), false);
  assert.equal(visionStartScript.includes(removedRemoteVisionForward), false);
  assert.equal(visionStartScript.includes(removedCompactModelTag), false);
  assert.equal(visionStartScript.includes(removedVisionModelTag), false);

  assert.match(visionServiceSource, /FLOKI_V2_CHAT_VISION_LOCAL_HF_READY/);
  assert.match(visionServiceSource, /web_host_only/);
  assert.match(visionServiceSource, /local_only/);
  assert.equal(visionServiceSource.includes("spawnSync('ssh'"), false);
  assert.equal(visionServiceSource.includes('chat-vision-ssh-tunnel.sock'), false);
  assert.equal(visionServiceSource.includes('vlm_ssh_tunnel_'), false);
  assert.equal(visionServiceSource.includes('local_hf_vision_'), false);

  const readinessIndex = indexOfOrFail(chatSource, 'chatWebcamVisionStatus.ready_for_chat');
  const speechIndex = indexOfOrFail(chatSource, 'startSpeechLoop({ no_speech: noSpeech })');
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
    chat_vision_uses_local_hf_model_path: true,
    web_host_only: true,
    ssh_tunnel_removed: true,
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
    stack: error.stack,
    live_runtime_started_by_test: false
  }, null, 2));
  process.exit(1);
}
