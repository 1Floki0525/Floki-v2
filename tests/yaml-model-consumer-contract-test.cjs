'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const cfg = require('../src/config/floki-config.cjs');
const coreBrain = require('../brain/core_brain/index.cjs');
const { chatVisionTunnelConfig } = require('../src/vision/chat-webcam-vision-service.cjs');
const { buildVisionStatus } = require('../src/vision/vision-status.cjs');
const { loadYamlFile } = require('../src/config/yaml-lite.cjs');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'state', '.floki-tools', 'dist', 'build']);
const SOURCE_ROOTS = ['src', 'brain', 'bin'];
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.sh']);

const DEPRECATED_CONSUMER_PATTERNS = [
  [/\bsection\.model_env\b/, 'section.model_env'],
  [/\bsection\.model_default\b/, 'section.model_default'],
  [/\bvision\.vision_model_env\b/, 'vision.vision_model_env'],
  [/\bstatus\.vision_model_env\b/, 'status.vision_model_env'],
  [/\bvision\.vlm_ssh_tunnel_required_model\b/, 'vision.vlm_ssh_tunnel_required_model'],
  [/\bchatConfigYaml\.vision\.vlm_ssh_tunnel_required_model\b/, 'chatConfigYaml.vision.vlm_ssh_tunnel_required_model'],
  [/\bgameConfigYaml\.vision\.vlm_ssh_tunnel_required_model\b/, 'gameConfigYaml.vision.vlm_ssh_tunnel_required_model'],
  [/\bresolveConfiguredModel\s*\(/, 'resolveConfiguredModel()'],
  [/\bresolvedYamlValue\s*\(/, 'resolvedYamlValue()'],
  [/resolveEnvOrDefault\(section,\s*['"]model_env['"]/, 'model environment resolver'],
  [/_resolveEnvOrDefault\(section,\s*['"]model_env['"]/, 'compatibility model environment resolver']
];

function walk(directory, output) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, output);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) output.push(full);
  }
}

function scanDeprecatedConsumers() {
  const files = [];
  for (const root of SOURCE_ROOTS) walk(path.join(ROOT, root), files);
  const violations = [];
  for (const file of files) {
    const relative = path.relative(ROOT, file);
    const source = fs.readFileSync(file, 'utf8');
    for (const [pattern, label] of DEPRECATED_CONSUMER_PATTERNS) {
      if (pattern.test(source)) violations.push(relative + ': ' + label);
    }
  }
  return violations;
}

function assertYamlShape() {
  for (const mode of ['chat', 'game']) {
    const raw = loadYamlFile(path.join(ROOT, 'config', mode + '.config.yaml'));
    for (const [label, section] of Object.entries(raw.models || {})) {
      assert.ok(section && typeof section === 'object', mode + ' models.' + label + ' must exist');
      assert.equal(typeof section.model, 'string', mode + ' models.' + label + '.model must be a YAML string');
      assert.ok(section.model.trim(), mode + ' models.' + label + '.model must be non-empty');
      assert.equal(Object.prototype.hasOwnProperty.call(section, 'model_env'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(section, 'model_default'), false);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(raw.vision || {}, 'vision_model_env'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(raw.vision || {}, 'vlm_ssh_tunnel_required_model'), false);
  }
}

function assertEnvironmentCannotSelectModels() {
  cfg.clearConfigCache();
  const baselineConfig = cfg.loadFlokiConfig('chat');
  const baselinePublic = cfg.getFlokiConfig('chat');
  const baselineCore = coreBrain.loadCoreBrainConfig('chat');
  const oldCog = process.env.FLOKI_COGNITION_MODEL;
  const oldVision = process.env.FLOKI_VISION_MODEL;
  try {
    process.env.FLOKI_COGNITION_MODEL = 'must-not-be-selected';
    process.env.FLOKI_VISION_MODEL = 'must-not-be-selected';
    cfg.clearConfigCache();
    const withEnvironment = cfg.loadFlokiConfig('chat');
    const publicWithEnvironment = cfg.getFlokiConfig('chat');
    const coreWithEnvironment = coreBrain.loadCoreBrainConfig('chat');
    assert.equal(withEnvironment.models.cognition.model, baselineConfig.models.cognition.model);
    assert.equal(withEnvironment.models.vision.model, baselineConfig.models.vision.model);
    assert.equal(publicWithEnvironment.models.cognition.model, baselinePublic.models.cognition.model);
    assert.equal(publicWithEnvironment.models.vision.model, baselinePublic.models.vision.model);
    assert.equal(coreWithEnvironment.models.cognition.model, baselineCore.models.cognition.model);
    assert.equal(coreWithEnvironment.models.vision.model, baselineCore.models.vision.model);
  } finally {
    if (oldCog === undefined) delete process.env.FLOKI_COGNITION_MODEL;
    else process.env.FLOKI_COGNITION_MODEL = oldCog;
    if (oldVision === undefined) delete process.env.FLOKI_VISION_MODEL;
    else process.env.FLOKI_VISION_MODEL = oldVision;
    cfg.clearConfigCache();
  }
}

function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );
  assertYamlShape();
  assertEnvironmentCannotSelectModels();

  const models = cfg.getModelConfig('chat');
  const vision = cfg.getVisionConfig('chat');
  const tunnel = chatVisionTunnelConfig({ runtime_dir: '/tmp/floki-yaml-model-consumer-contract' });
  const status = buildVisionStatus({ active_mode: 'chat' });

  assert.equal(tunnel.required_model, models.vision.model);
  assert.equal(Object.prototype.hasOwnProperty.call(vision, 'vlm_ssh_tunnel_required_model'), false);
  assert.equal(status.vision_model, models.vision.model);
  assert.equal(status.vision_model_source, 'config_yaml');
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'vision_model_env'), false);

  const violations = scanDeprecatedConsumers();
  assert.deepEqual(violations, [], 'deprecated model consumers remain:\n' + violations.join('\n'));

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_YAML_MODEL_CONSUMER_CONTRACT_PASS',
    yaml_is_only_model_selection_authority: true,
    environment_model_selection_blocked: true,
    tunnel_model_comes_from_models_vision_model: true,
    deprecated_model_consumers_found: 0,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_YAML_MODEL_CONSUMER_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
