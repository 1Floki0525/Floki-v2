
'use strict';

/**
 * Chat-only control-plane configuration contract.
 *
 * Uses project-local SSD validation files and removes them after the test.
 * It never reads or writes private key material.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const validationRoot = path.join(
  ROOT,
  'state',
  'floki',
  'test-control-plane-config',
  'run-' + String(process.pid) + '-' + Date.now().toString(36)
);

const configModule = require('../src/config/floki-config.cjs');
const {
  loadFlokiConfig,
  getControlPlaneConfig,
  clearConfigCache
} = configModule;

function withoutControlPlane(yaml) {
  const removed = String(yaml).replace(
    /\ncontrol_plane:\n(?:  [^\n]*(?:\n|$))+/,
    '\n'
  );
  assert.notEqual(removed, yaml, 'chat template must contain control_plane');
  return removed;
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

function run() {
  fs.mkdirSync(validationRoot, { recursive: true });

  const chatTemplatePath = path.join(ROOT, 'config', 'chat.config.yaml.temp');
  const gameConfigPath = path.join(ROOT, 'config', 'game.config.yaml');
  const chatTemplate = fs.readFileSync(chatTemplatePath, 'utf8');
  const gameConfigText = fs.readFileSync(gameConfigPath, 'utf8');

  assert.match(chatTemplate, /\ncontrol_plane:\n/);
  assert.doesNotMatch(chatTemplate, /supervisor_private_key_path\s*:/);
  assert.match(chatTemplate, /supervisor_public_key_path\s*:/);

  const validChatPath = path.join(validationRoot, 'chat-valid.yaml');
  const missingChatPath = path.join(validationRoot, 'chat-missing-control-plane.yaml');
  const gameCopyPath = path.join(validationRoot, 'game.yaml');

  write(validChatPath, chatTemplate);
  write(missingChatPath, withoutControlPlane(chatTemplate));
  write(gameCopyPath, gameConfigText);

  process.env.FLOKI_CHAT_CONFIG_PATH = validChatPath;
  clearConfigCache();
  const chat = loadFlokiConfig('chat');
  assert.ok(chat.control_plane);
  assert.equal(chat.control_plane.supervisor_host, '127.0.0.1');
  assert.equal(chat.control_plane.supervisor_port, 7710);
  assert.equal(Object.hasOwn(chat.control_plane, 'supervisor_private_key_path'), false);
  assert.equal(getControlPlaneConfig('chat'), chat.control_plane);

  process.env.FLOKI_CHAT_CONFIG_PATH = missingChatPath;
  clearConfigCache();
  assert.throws(
    () => loadFlokiConfig('chat'),
    /Missing required YAML key.*control_plane|control_plane/i
  );

  process.env.FLOKI_GAME_CONFIG_PATH = gameCopyPath;
  clearConfigCache();
  const game = loadFlokiConfig('game');
  assert.equal(Object.hasOwn(game, 'control_plane'), false);
  assert.throws(() => getControlPlaneConfig('game'), /chat-mode only/i);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CONTROL_PLANE_CONFIG_CONTRACT_PASS',
    tests: [
      'chat_control_plane_required',
      'chat_control_plane_strictly_loaded',
      'public_template_has_no_private_key_path',
      'game_mode_does_not_require_or_load_control_plane',
      'accessor_is_chat_only'
    ]
  }, null, 2));
}

try {
  run();
} finally {
  delete process.env.FLOKI_CHAT_CONFIG_PATH;
  delete process.env.FLOKI_GAME_CONFIG_PATH;
  clearConfigCache();
  fs.rmSync(validationRoot, { recursive: true, force: true });
}
