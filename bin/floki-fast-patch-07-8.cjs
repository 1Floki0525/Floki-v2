'use strict';

/**
 * Floki-v2 fast patch 07.8
 *
 * Based on the current foundation test shape:
 * - models.getCognitionConfig()
 * - models.getVisionConfig()
 *
 * Final required state:
 * - cognition: qwen3.5:9b
 * - vision: qwen3-vl:4b
 * - cognition still disabled until Batch 08
 * - vision still disabled until eyes stage
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';

function projectPath() {
  return path.join.apply(path, [ROOT].concat(Array.from(arguments)));
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function backup(filePath) {
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, filePath + '.bak.' + timestamp());
  }
}

function writeFile(relativePath, content) {
  const fullPath = projectPath(relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  backup(fullPath);
  fs.writeFileSync(fullPath, content);
  console.log('patched ' + relativePath);
}

function patchModelConfig() {
  const lines = [
    "'use strict';",
    "",
    "/**",
    " * Floki-v2 model config.",
    " *",
    " * Current honest stage:",
    " * - qwen3.5:9b is selected for future cognition.",
    " * - qwen3-vl:4b is selected for future vision.",
    " * - cognition calls are still disabled until Batch 08.",
    " * - vision calls are still disabled until the eyes stage.",
    " */",
    "",
    "const MODEL_CONFIG = Object.freeze({",
    "  stage: 'stage_07_affect_scaffold_no_cognition_calls',",
    "",
    "  cognition: Object.freeze({",
    "    provider: 'ollama',",
    "    model: process.env.FLOKI_COGNITION_MODEL || 'qwen3.5:9b',",
    "    endpoint: process.env.FLOKI_COGNITION_ENDPOINT || 'http://127.0.0.1:11434',",
    "    enabled_in_current_stage: false,",
    "    wire_in_batch: 'stage_08_frontal_temporal_qwen_cognition',",
    "    allow_thinking: true,",
    "    expose_private_reasoning: false,",
    "    store_raw_private_reasoning: false,",
    "    store_safe_reasoning_summary: true,",
    "    temperature: Number(process.env.FLOKI_COGNITION_TEMPERATURE || 0.55),",
    "    top_p: Number(process.env.FLOKI_COGNITION_TOP_P || 0.9),",
    "    timeout_ms: Number(process.env.FLOKI_COGNITION_TIMEOUT_MS || 120000),",
    "    keep_alive: process.env.FLOKI_COGNITION_KEEP_ALIVE || '24h'",
    "  }),",
    "",
    "  vision: Object.freeze({",
    "    provider: 'ollama',",
    "    model: process.env.FLOKI_VISION_MODEL || 'qwen3-vl:4b',",
    "    endpoint: process.env.FLOKI_VISION_ENDPOINT || 'http://127.0.0.1:11435',",
    "    enabled_in_current_stage: false,",
    "    wire_in_batch: 'future_static_png_then_live_minecraft_eyes',",
    "    allow_thinking: false,",
    "    reject_think_tags: true,",
    "    expose_private_reasoning: false,",
    "    store_raw_private_reasoning: false,",
    "    store_safe_observation_summary: true,",
    "    temperature: Number(process.env.FLOKI_VISION_TEMPERATURE || 0.2),",
    "    top_p: Number(process.env.FLOKI_VISION_TOP_P || 0.8),",
    "    timeout_ms: Number(process.env.FLOKI_VISION_TIMEOUT_MS || 120000),",
    "    keep_alive: process.env.FLOKI_VISION_KEEP_ALIVE || '24h'",
    "  }),",
    "",
    "  stage_flags: Object.freeze({",
    "    affect_scaffold_enabled_now: true,",
    "    reflective_emotion_enabled_now: false,",
    "    cognition_enabled_now: false,",
    "    broca_enabled_now: false,",
    "    minecraft_enabled_now: false,",
    "    body_enabled_now: false,",
    "    eyes_enabled_now: false",
    "  }),",
    "",
    "  forbidden: Object.freeze({",
    "    minecraft_in_current_stage: true,",
    "    mineflayer: true,",
    "    pathfinding_libraries: true,",
    "    rcon_body_control: true,",
    "    desktop_automation: true,",
    "    host_screenshot_vision: true,",
    "    fake_success: true,",
    "    raw_private_reasoning_storage: true",
    "  })",
    "});",
    "",
    "function assertNonEmptyString(value, fieldName) {",
    "  if (typeof value !== 'string' || value.trim() === '') {",
    "    throw new TypeError(fieldName + ' must be a non-empty string');",
    "  }",
    "}",
    "",
    "function assertBoolean(value, fieldName) {",
    "  if (typeof value !== 'boolean') {",
    "    throw new TypeError(fieldName + ' must be boolean');",
    "  }",
    "}",
    "",
    "function assertFiniteNumber(value, fieldName) {",
    "  if (typeof value !== 'number' || !Number.isFinite(value)) {",
    "    throw new TypeError(fieldName + ' must be a finite number');",
    "  }",
    "}",
    "",
    "function validateModelConfig(config) {",
    "  const selected = config || MODEL_CONFIG;",
    "",
    "  if (selected === null || typeof selected !== 'object' || Array.isArray(selected)) {",
    "    throw new TypeError('model config must be a plain object');",
    "  }",
    "",
    "  assertNonEmptyString(selected.stage, 'model config stage');",
    "  assertNonEmptyString(selected.cognition.provider, 'cognition provider');",
    "  assertNonEmptyString(selected.cognition.model, 'cognition model');",
    "  assertNonEmptyString(selected.cognition.endpoint, 'cognition endpoint');",
    "  assertBoolean(selected.cognition.enabled_in_current_stage, 'cognition.enabled_in_current_stage');",
    "  assertBoolean(selected.cognition.allow_thinking, 'cognition.allow_thinking');",
    "  assertBoolean(selected.cognition.expose_private_reasoning, 'cognition.expose_private_reasoning');",
    "  assertBoolean(selected.cognition.store_raw_private_reasoning, 'cognition.store_raw_private_reasoning');",
    "  assertBoolean(selected.cognition.store_safe_reasoning_summary, 'cognition.store_safe_reasoning_summary');",
    "  assertFiniteNumber(selected.cognition.temperature, 'cognition temperature');",
    "  assertFiniteNumber(selected.cognition.top_p, 'cognition top_p');",
    "  assertFiniteNumber(selected.cognition.timeout_ms, 'cognition timeout_ms');",
    "",
    "  assertNonEmptyString(selected.vision.provider, 'vision provider');",
    "  assertNonEmptyString(selected.vision.model, 'vision model');",
    "  assertNonEmptyString(selected.vision.endpoint, 'vision endpoint');",
    "  assertBoolean(selected.vision.enabled_in_current_stage, 'vision.enabled_in_current_stage');",
    "  assertBoolean(selected.vision.allow_thinking, 'vision.allow_thinking');",
    "  assertBoolean(selected.vision.reject_think_tags, 'vision.reject_think_tags');",
    "  assertBoolean(selected.vision.expose_private_reasoning, 'vision.expose_private_reasoning');",
    "  assertBoolean(selected.vision.store_raw_private_reasoning, 'vision.store_raw_private_reasoning');",
    "  assertBoolean(selected.vision.store_safe_observation_summary, 'vision.store_safe_observation_summary');",
    "  assertFiniteNumber(selected.vision.temperature, 'vision temperature');",
    "  assertFiniteNumber(selected.vision.top_p, 'vision top_p');",
    "  assertFiniteNumber(selected.vision.timeout_ms, 'vision timeout_ms');",
    "",
    "  if (selected.cognition.model !== 'qwen3.5:9b') {",
    "    throw new Error('cognition model must be qwen3.5:9b, got ' + selected.cognition.model);",
    "  }",
    "",
    "  if (selected.vision.model !== 'qwen3-vl:4b') {",
    "    throw new Error('vision model must be qwen3-vl:4b, got ' + selected.vision.model);",
    "  }",
    "",
    "  if (selected.cognition.enabled_in_current_stage !== false) {",
    "    throw new Error('cognition calls must remain disabled until Batch 08');",
    "  }",
    "",
    "  if (selected.vision.enabled_in_current_stage !== false) {",
    "    throw new Error('vision calls must remain disabled until the eyes stage');",
    "  }",
    "",
    "  if (selected.vision.allow_thinking !== false) {",
    "    throw new Error('vision thinking must stay disabled');",
    "  }",
    "",
    "  return true;",
    "}",
    "",
    "function getModelConfig() {",
    "  validateModelConfig(MODEL_CONFIG);",
    "  return MODEL_CONFIG;",
    "}",
    "",
    "function getCognitionConfig() {",
    "  validateModelConfig(MODEL_CONFIG);",
    "  return MODEL_CONFIG.cognition;",
    "}",
    "",
    "function getVisionConfig() {",
    "  validateModelConfig(MODEL_CONFIG);",
    "  return MODEL_CONFIG.vision;",
    "}",
    "",
    "function getStageFlags() {",
    "  validateModelConfig(MODEL_CONFIG);",
    "  return MODEL_CONFIG.stage_flags;",
    "}",
    "",
    "module.exports = {",
    "  stage: MODEL_CONFIG.stage,",
    "  cognition: MODEL_CONFIG.cognition,",
    "  vision: MODEL_CONFIG.vision,",
    "  stage_flags: MODEL_CONFIG.stage_flags,",
    "  forbidden: MODEL_CONFIG.forbidden,",
    "  MODEL_CONFIG,",
    "  getModelConfig,",
    "  getCognitionConfig,",
    "  getVisionConfig,",
    "  getStageFlags,",
    "  validateModelConfig",
    "};",
    ""
  ];

  writeFile('src/config/model-config.cjs', lines.join('\n'));
}

function patchFoundationTest() {
  const testPath = projectPath('tests/foundation-contract-test.cjs');

  if (!fs.existsSync(testPath)) {
    return { skipped: true };
  }

  let content = fs.readFileSync(testPath, 'utf8');
  backup(testPath);

  content = content.replace(/models\.getCognitionConfig\(\)\.model,\s*'[^']+'/g, "models.getCognitionConfig().model, 'qwen3.5:9b'");
  content = content.replace(/models\.getVisionConfig\(\)\.model,\s*'[^']+'/g, "models.getVisionConfig().model, 'qwen3-vl:4b'");
  content = content.replace(/cognition_model:\s*[^,\n]+/g, "cognition_model: models.getCognitionConfig().model");
  content = content.replace(/vision_model:\s*[^,\n]+/g, "vision_model: models.getVisionConfig().model");

  fs.writeFileSync(testPath, content);

  return { skipped: false };
}

function patchEnv() {
  const envPath = projectPath('.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  if (fs.existsSync(envPath)) {
    backup(envPath);
  }

  content = upsertEnv(content, 'FLOKI_COGNITION_MODEL', 'qwen3.5:9b');
  content = upsertEnv(content, 'FLOKI_VISION_MODEL', 'qwen3-vl:4b');
  content = upsertEnv(content, 'FLOKI_COGNITION_ENABLED', '0');
  content = upsertEnv(content, 'FLOKI_REFLECTIVE_EMOTION_ENABLED', '0');
  content = upsertEnv(content, 'FLOKI_AFFECT_SCAFFOLD_ENABLED', '1');

  fs.writeFileSync(envPath, content);

  return {
    cognition_model: 'qwen3.5:9b',
    vision_model: 'qwen3-vl:4b'
  };
}

function upsertEnv(content, key, value) {
  const line = key + '=' + value;
  const regex = new RegExp('^' + key + '=.*$', 'm');

  if (regex.test(content)) {
    return content.replace(regex, line);
  }

  if (!content.endsWith('\n')) {
    content += '\n';
  }

  return content + line + '\n';
}

function patchPackage() {
  const packagePath = projectPath('package.json');

  if (!fs.existsSync(packagePath)) {
    return { skipped: true };
  }

  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  backup(packagePath);
  pkg.version = '0.7.8';
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

  return {
    skipped: false,
    version: pkg.version
  };
}

function verify() {
  const configPath = projectPath('src/config/model-config.cjs');

  delete require.cache[require.resolve(configPath)];

  const models = require(configPath);
  models.validateModelConfig();

  const cognition = models.getCognitionConfig();
  const vision = models.getVisionConfig();

  if (cognition.model !== 'qwen3.5:9b') {
    throw new Error('bad cognition model: ' + cognition.model);
  }

  if (vision.model !== 'qwen3-vl:4b') {
    throw new Error('bad vision model: ' + vision.model);
  }

  if (typeof models.getCognitionConfig !== 'function') {
    throw new Error('getCognitionConfig missing');
  }

  if (typeof models.getVisionConfig !== 'function') {
    throw new Error('getVisionConfig missing');
  }

  return {
    cognition_model: cognition.model,
    vision_model: vision.model,
    getCognitionConfig: typeof models.getCognitionConfig,
    getVisionConfig: typeof models.getVisionConfig
  };
}

function main() {
  if (process.cwd() !== ROOT) {
    throw new Error('Run this from ' + ROOT);
  }

  patchModelConfig();
  const foundationTest = patchFoundationTest();
  const env = patchEnv();
  const pkg = patchPackage();
  const verified = verify();

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FAST_PATCH_07_8_PASS',
    verified,
    foundation_test: foundationTest,
    env,
    package: pkg
  }, null, 2));
}

main();
