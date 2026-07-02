'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PROJECT_ROOT, getVisionConfig, getChatWorldVisionConfig, getGameWorldVisionConfig } = require('../src/config/floki-config.cjs');
const { resolveVisionSource } = require('../src/vision/vision-source-router.cjs');

function assertNoRuntimeHardcoding() {
  const visionDir = path.join(PROJECT_ROOT, 'src', 'vision');
  const files = fs.readdirSync(visionDir).filter((name) => name.endsWith('.cjs'));
  const forbidden = [
    'qwen3',
    '/dev/video0',
    'require(\'mineflayer',
    'require("mineflayer',
    'from \'mineflayer',
    'from "mineflayer',
    'pathfinding_libraries: true',
    'rcon_body_control_used: true'
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(visionDir, file), 'utf8').toLowerCase();
    for (const value of forbidden) {
      assert.equal(text.includes(value.toLowerCase()), false, file + ' must not contain hardcoded forbidden value ' + value);
    }
  }
}

function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );

  const vision = getVisionConfig('chat');
  assert.equal(vision.target_capture_fps, 40);
  assert.equal(vision.external_eyes_source, 'webcam');
  assert.throws(() => getGameWorldVisionConfig('chat'), /game-mode only/);
  assert.throws(() => getChatWorldVisionConfig('game'), /chat-mode only/);

  const chat = resolveVisionSource({ mode: 'chat' });
  assert.equal(chat.marker, 'FLOKI_V2_VISION_SOURCE_ROUTER_PASS');
  assert.equal(chat.current_source, 'webcam');
  assert.equal(chat.external_world_observation, true);
  assert.equal(chat.webcam_used_as_game_world_eyes, false);

  const game = resolveVisionSource({ mode: 'game' });
  assert.equal(game.current_source, 'minecraft_first_person');
  assert.equal(game.external_world_observation, true);
  assert.equal(game.minecraft_first_person_used_as_chat_webcam_eyes, false);
  assert.equal(getGameWorldVisionConfig('game').source, 'minecraft_first_person');

  for (const mode of ['sleep', 'dream', 'reflection', 'thinking']) {
    const routed = resolveVisionSource({ mode });
    assert.equal(routed.current_source, 'pineal_mind_eye');
    assert.equal(routed.internal_reality, true);
    assert.equal(routed.external_world_observation, false);
    assert.equal(routed.pineal_mind_eye_treated_as_external_reality, false);
    assert.equal(routed.public_transcript_visible, false);
  }

  assertNoRuntimeHardcoding();

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_VISION_SOURCE_ROUTER_PASS',
    chat_mode_uses_webcam_eyes: true,
    game_mode_uses_first_person_game_view: true,
    pineal_mind_eye_used_for_dreams: true,
    webcam_used_as_game_world_eyes: false,
    desktop_automation_used_for_sight: false,
    mineflayer_used: false,
    node24_required: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_VISION_SOURCE_ROUTER_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
