'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'vendor',
  'state',
  'reports',
  '.floki-tools'
]);
const BACKUP_FILE = /(?:\.bak(?:\.|$)|\.backup(?:\.|$)|~$|\.orig$|\.rej$)/i;
const MODEL_TAG = /\b(?:floki-)?qwen[\w.-]*:[\w.-]+\b/gi;

function walk(directory, callback) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, callback);
    else callback(full, entry.name);
  }
}

function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );

  for (const name of ['chat.config.yaml', 'game.config.yaml']) {
    const file = path.join(CONFIG_DIR, name);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^\s*model:\s*\S+/m, name + ' must declare models with model:');
    assert.doesNotMatch(text, /^\s*model_env:/m, name + ' must not declare model_env');
    assert.doesNotMatch(text, /^\s*model_default:/m, name + ' must not declare model_default');
    assert.doesNotMatch(text, /^\s*vision_model_env:/m, name + ' must not declare vision_model_env');
    assert.doesNotMatch(text, /^\s*vlm_ssh_tunnel_required_model:/m, name + ' must not duplicate the vision model');
  }

  const cfg = require('../src/config/floki-config.cjs');
  cfg.clearConfigCache();
  const originalChat = cfg.loadFlokiConfig('chat');
  const cognitionModel = originalChat.models.cognition.model;
  const visionModel = originalChat.models.vision.model;

  const oldCognition = process.env.FLOKI_COGNITION_MODEL;
  const oldVision = process.env.FLOKI_VISION_MODEL;
  process.env.FLOKI_COGNITION_MODEL = 'environment-must-not-select-a-model';
  process.env.FLOKI_VISION_MODEL = 'environment-must-not-select-a-model';
  cfg.clearConfigCache();
  const overridden = cfg.loadFlokiConfig('chat');
  assert.equal(overridden.models.cognition.model, cognitionModel, 'cognition model must remain YAML-authoritative');
  assert.equal(overridden.models.vision.model, visionModel, 'vision model must remain YAML-authoritative');
  if (oldCognition === undefined) delete process.env.FLOKI_COGNITION_MODEL;
  else process.env.FLOKI_COGNITION_MODEL = oldCognition;
  if (oldVision === undefined) delete process.env.FLOKI_VISION_MODEL;
  else process.env.FLOKI_VISION_MODEL = oldVision;
  cfg.clearConfigCache();

  const sourceChecks = [
    path.join(ROOT, 'src', 'config', 'floki-config.cjs'),
    path.join(ROOT, 'brain', 'core_brain', 'index.cjs')
  ];
  for (const file of sourceChecks) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /resolveEnvOrDefault\(section,\s*['"]model_env['"]/, path.relative(ROOT, file) + ' must not resolve a model from the environment');
    assert.doesNotMatch(text, /section\.model_default/, path.relative(ROOT, file) + ' must not read model_default');
  }

  const hardcoded = [];
  walk(ROOT, (file) => {
    if (file.startsWith(CONFIG_DIR + path.sep)) return;
    if (!/\.(?:cjs|mjs|js|jsx|ts|tsx|md|json|html|css|sh)$/i.test(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    const matches = text.match(MODEL_TAG) || [];
    if (matches.length) hardcoded.push(path.relative(ROOT, file) + ': ' + Array.from(new Set(matches)).join(', '));
  });
  assert.deepEqual(hardcoded, [], 'model tags must exist only in config/*.yaml:\n' + hardcoded.join('\n'));

  const backupFiles = [];
  function walkBackups(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === 'vendor' ||
        entry.name === 'state' ||
        entry.name === 'reports' ||
        entry.name === '.floki-tools'
      ) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (/^backups?$/i.test(entry.name)) backupFiles.push(path.relative(ROOT, full) + '/');
        else walkBackups(full);
      } else if (BACKUP_FILE.test(entry.name)) {
        backupFiles.push(path.relative(ROOT, full));
      }
    }
  }
  walkBackups(ROOT);
  assert.deepEqual(backupFiles, [], 'backup debris remains:\n' + backupFiles.join('\n'));

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_YAML_MODEL_AUTHORITY_PASS',
    cognition_model_source: 'config/chat.config.yaml',
    vision_model_source: 'config/chat.config.yaml',
    environment_model_override_blocked: true,
    model_tags_outside_yaml: 0,
    backup_files_remaining: 0,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_YAML_MODEL_AUTHORITY_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
