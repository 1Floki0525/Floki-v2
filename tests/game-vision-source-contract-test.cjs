'use strict';

const assert = require('node:assert/strict');

const { buildGameVisionSourceStatus } = require('../src/vision/game-vision-source.cjs');

function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );
  const status = buildGameVisionSourceStatus();

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_GAME_VISION_SOURCE_CONTRACT_PASS');
  assert.equal(status.source, 'minecraft_first_person');
  assert.equal(status.enabled_now, false);
  assert.equal(status.game_mode_started, false);
  assert.equal(status.minecraft_started_now, false);
  assert.equal(status.papermc_started_now, false);
  assert.equal(status.webcam_used, false);
  assert.equal(status.desktop_automation_used_for_sight, false);
  assert.equal(status.mineflayer_used, false);
  assert.equal(status.pathfinding_used, false);
  assert.equal(status.rcon_body_control_used, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_GAME_VISION_SOURCE_CONTRACT_PASS',
    source: status.source,
    enabled_now: status.enabled_now,
    webcam_used: false,
    desktop_automation_used_for_sight: false,
    mineflayer_used: false,
    pathfinding_used: false,
    rcon_body_control_used: false,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_GAME_VISION_SOURCE_CONTRACT_FAIL',
    error: error.message,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
