'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';

function parseJsonOutput(stdout, label) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');

  if (start < 0) {
    throw new Error(label + ' did not print JSON. stdout=' + text);
  }

  return JSON.parse(text.slice(start));
}

function runCommand(args, label) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000
  });

  if (result.status !== 0) {
    console.error('--- ' + label + ' stdout ---');
    console.error(result.stdout || '');
    console.error('--- ' + label + ' stderr ---');
    console.error(result.stderr || '');
    throw new Error(label + ' exited with status ' + result.status);
  }

  return parseJsonOutput(result.stdout, label);
}

function assertGameGuard(json) {
  assert.equal(json.core_brain_enabled_now, true);
  assert.equal(json.config_path.endsWith('/config/game.config.yaml'), true);
  assert.equal(json.cognition_model, 'qwen3.5:9b');
  assert.equal(json.vision_model, 'qwen3-vl:4b');
  assert.equal(json.vision_mode_scope, 'game_world_first_person_only');
  assert.equal(json.game_world_eyes_source, 'minecraft_first_person_view');
  assert.equal(json.chat_world_camera_scope, 'not_loaded_in_game');
  assert.equal(json.usb_camera_as_game_world_eyes, false);
  assert.equal(json.minecraft_enabled_now, false);
  assert.equal(json.body_movement_enabled_now, false);
  assert.equal(json.game_world_eyes_enabled_now, false);
  assert.equal(Array.isArray(json.enabled_modules), true);
  assert.equal(json.enabled_modules.includes('chat_world_senses'), false);
  assert.equal(json.enabled_modules.includes('game_world_eyes'), false);
  assert.equal(json.enabled_modules.includes('game_world_body'), false);
}

function run() {
  const smoke = runCommand(['bash', 'bin/floki-start.sh', 'game-smoke'], 'game-smoke');
  assert.equal(smoke.marker, 'FLOKI_V2_GAME_ENTRYPOINT_CONTRACT_PASS');
  assert.equal(smoke.game_command_exists, true);
  assert.equal(smoke.game_mode_guarded_now, true);
  assertGameGuard(smoke);

  const status = runCommand(['bash', 'bin/floki-start.sh', 'status'], 'game-status');
  assert.equal(status.marker, 'FLOKI_V2_GAME_MODE_CORE_BRAIN_GUARDED');
  assert.equal(status.mode, 'game');
  assert.equal(status.allowed_now, false);
  assertGameGuard(status);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_GAME_CORE_BRAIN_ENTRYPOINT_PASS',
    game_smoke_marker: smoke.marker,
    game_status_marker: status.marker,
    config_path: status.config_path,
    enabled_modules: status.enabled_modules,
    cognition_model: status.cognition_model,
    vision_model: status.vision_model,
    vision_mode_scope: status.vision_mode_scope,
    game_world_eyes_source: status.game_world_eyes_source,
    chat_world_camera_scope: status.chat_world_camera_scope,
    usb_camera_as_game_world_eyes: status.usb_camera_as_game_world_eyes,
    minecraft_enabled_now: status.minecraft_enabled_now,
    body_movement_enabled_now: status.body_movement_enabled_now,
    game_world_eyes_enabled_now: status.game_world_eyes_enabled_now
  }, null, 2));
}

run();
