'use strict';

/**
 * Floki-v2 fast patch 07.6
 *
 * Hard-replaces src/config/model-config.cjs with a stable known-good config.
 *
 * Required:
 * - cognition default: qwen3.5:9b
 * - vision default: qwen3-vl:4b
 * - cognition calls still disabled until Batch 08
 * - vision calls still disabled until eyes stage
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';

function projectPath(...parts) {
  return path.join(ROOT, ...parts);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function backupAndWrite(relativePath, content) {
  const fullPath = projectPath(relativePath);

  if (fs.existsSync(fullPath)) {
    fs.copyFileSync(fullPath, `${fullPath}.bak.${timestamp()}`);
  }

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  console.log(`patched ${relativePath}`);
}

function patchModelConfig() {
  const content = `'use strict';

/**
 * Floki-v2 model config.
 *
 * Current stage:
 * - qwen3.5:9b is selected as the future cognition model.
 * - qwen3-vl:4b remains selected as the future vision model.
 * - No model calls are enabled yet.
 *
 * This file intentionally exports both:
 * - root-level config fields for older tests
 * - MODEL_CONFIG/getModelConfig() for newer code
 */

const MODEL_CONFIG = Object.freeze({
  stage: 'stage_07_affect_scaffold_no_cognition_calls',

  cognition: Object.freeze({
    provider: 'ollama',
    model: process.env.FLOKI_COGNITION_MODEL || 'qwen3.5:9b',
    endpoint: process.env.FLOKI_COGNITION_ENDPOINT || 'http://127.0.0.1:11434',
    enabled_in_current_stage: false,
    wire_in_batch: 'stage_08_frontal_temporal_qwen_cognition',
    allow_thinking: true,
    expose_hidden_reasoning: false,
    store_raw_hidden_reasoning: false,
    store_safe_reasoning_summary: true,
    temperature: Number(process.env.FLOKI_COGNITION_TEMPERATURE || 0.55),
    top_p: Number(process.env.FLOKI_COGNITION_TOP_P || 0.9),
    timeout_ms: Number(process.env.FLOKI_COGNITION_TIMEOUT_MS || 120000),
    keep_alive: process.env.FLOKI_COGNITION_KEEP_ALIVE || '24h'
  }),

  vision: Object.freeze({
    provider: 'ollama',
    model: process.env.FLOKI_VISION_MODEL || 'qwen3-vl:4b',
    endpoint: process.env.FLOKI_VISION_ENDPOINT || 'http://127.0.0.1:11435',
    enabled_in_current_stage: false,
    wire_in_batch: 'future_static_png_then_live_minecraft_eyes',
    allow_thinking: false,
    reject_think_tags: true,
    expose_hidden_reasoning: false,
    store_raw_hidden_reasoning: false,
    store_safe_observation_summary: true,
    temperature: Number(process.env.FLOKI_VISION_TEMPERATURE || 0.2),
    top_p: Number(process.env.FLOKI_VISION_TOP_P || 0.8),
    timeout_ms: Number(process.env.FLOKI_VISION_TIMEOUT_MS || 120000),
    keep_alive: process.env.FLOKI_VISION_KEEP_ALIVE || '24h'
  }),

  stage_flags: Object.freeze({
    affect_scaffold_enabled_now: true,
    reflective_emotion_enabled_now: false,
    cognition_enabled_now: false,
    broca_enabled_now: false,
    minecraft_enabled_now: false,
    body_enabled_now: false,
    eyes_enabled_now: false
  }),

  forbidden: Object.freeze({
    minecraft_in_current_stage: true,
    mineflayer: true,
    pathfinding_libraries: true,
    rcon_body_control: true,
    desktop_automation: true,
    host_screenshot_vision: true,
    fake_success: true,
    raw_chain_of_thought_storage: true,
    raw_hidden_reasoning_storage: true
  })
});

function assertFiniteNumber(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(\`\${fieldName} must be a finite number\`);
  }
}

function assertBoolean(value, fieldName) {
  if (typeof value !== 'boolean') {
    throw new TypeError(\`\${fieldName} must be boolean\`);
  }
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(\`\${fieldName} must be a non-empty string\`);
  }
}

function rejectUnsafeMarkers(value, fieldName = 'model config') {
  const lower = JSON.stringify(value).toLowerCase();

  const bannedMarkers = [
    '<think>',
    '</think>',
    'chain_of_thought',
    'hidden_reasoning',
    'raw_reasoning',
    'scratchpad'
  ];

  for (const marker of bannedMarkers) {
    if (lower.includes(marker) && !lower.includes('raw_hidden_reasoning_storage')) {
      throw new Error(\`\${fieldName} contains banned private-reasoning marker: \${marker}\`);
    }
  }

  return true;
}

function validateModelConfig(config = MODEL_CONFIG) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('model config must be a plain object');
  }

  assertNonEmptyString(config.stage, 'model config stage');

  if (!config.cognition || typeof config.cognition !== 'object') {
    throw new TypeError('model config cognition must be an object');
  }

  if (!config.vision || typeof config.vision !== 'object') {
    throw new TypeError('model config vision must be an object');
  }

  assertNonEmptyString(config.cognition.provider, 'cognition provider');
  assertNonEmptyString(config.cognition.model, 'cognition model');
  assertNonEmptyString(config.cognition.endpoint, 'cognition endpoint');
  assertBoolean(config.cognition.enabled_in_current_stage, 'cognition.enabled_in_current_stage');
  assertBoolean(config.cognition.expose_hidden_reasoning, 'cognition.expose_hidden_reasoning');
  assertBoolean(config.cognition.store_raw_hidden_reasoning, 'cognition.store_raw_hidden_reasoning');
  assertBoolean(config.cognition.store_safe_reasoning_summary, 'cognition.store_safe_reasoning_summary');
  assertFiniteNumber(config.cognition.temperature, 'cognition temperature');
  assertFiniteNumber(config.cognition.top_p, 'cognition top_p');
  assertFiniteNumber(config.cognition.timeout_ms, 'cognition timeout_ms');

  assertNonEmptyString(config.vision.provider, 'vision provider');
  assertNonEmptyString(config.vision.model, 'vision model');
  assertNonEmptyString(config.vision.endpoint, 'vision endpoint');
  assertBoolean(config.vision.enabled_in_current_stage, 'vision.enabled_in_current_stage');
  assertBoolean(config.vision.allow_thinking, 'vision allow_thinking');
  assertBoolean(config.vision.reject_think_tags, 'vision reject_think_tags');
  assertBoolean(config.vision.expose_hidden_reasoning, 'vision.expose_hidden_reasoning');
  assertBoolean(config.vision.store_raw_hidden_reasoning, 'vision.store_raw_hidden_reasoning');
  assertFiniteNumber(config.vision.temperature, 'vision temperature');
  assertFiniteNumber(config.vision.top_p, 'vision top_p');
  assertFiniteNumber(config.vision.timeout_ms, 'vision timeout_ms');

  if (config.cognition.model !== 'qwen3.5:9b') {
    throw new Error(\`cognition model must be qwen3.5:9b, got \${config.cognition.model}\`);
  }

  if (config.vision.model !== 'qwen3-vl:4b') {
    throw new Error(\`vision model must be qwen3-vl:4b, got \${config.vision.model}\`);
  }

  if (config.cognition.enabled_in_current_stage !== false) {
    throw new Error('cognition calls must remain disabled until Batch 08');
  }

  if (config.vision.enabled_in_current_stage !== false) {
    throw new Error('vision calls must remain disabled until the eyes stage');
  }

  if (config.cognition.expose_hidden_reasoning !== false) {
    throw new Error('cognition hidden reasoning must never be exposed');
  }

  if (config.cognition.store_raw_hidden_reasoning !== false) {
    throw new Error('cognition raw hidden reasoning must never be stored');
  }

  if (config.vision.allow_thinking !== false) {
    throw new Error('vision model thinking must stay disabled');
  }

  rejectUnsafeMarkers({
    stage: config.stage,
    cognition_model: config.cognition.model,
    vision_model: config.vision.model,
    stage_flags: config.stage_flags
  }, 'model config public fields');

  return true;
}

function getModelConfig() {
  validateModelConfig(MODEL_CONFIG);
  return MODEL_CONFIG;
}

module.exports = {
  ...MODEL_CONFIG,
  MODEL_CONFIG,
  getModelConfig,
  validateModelConfig
};
`;

  backupAndWrite('src/config/model-config.cjs', content);
}

function patchFoundationTest() {
  const testPath = projectPath('tests/foundation-contract-test.cjs');

  if (!fs.existsSync(testPath)) {
    return {
      skipped: true,
      reason: 'tests/foundation-contract-test.cjs not found'
    };
  }

  let content = fs.readFileSync(testPath, 'utf8');

  content = content.replaceAll('qwen3.5:4b', 'qwen3.5:9b');

  content = content.replace(
    /assert\.equal\(modelConfig\.vision\.model,\s*['"][^'"]+['"]\);/,
    "assert.equal(modelConfig.vision.model, 'qwen3-vl:4b');"
  );

  content = content.replace(
    /assert\.equal\(modelConfig\.cognition\.model,\s*['"][^'"]+['"]\);/,
    "assert.equal(modelConfig.cognition.model, 'qwen3.5:9b');"
  );

  fs.copyFileSync(testPath, `${testPath}.bak.${timestamp()}`);
  fs.writeFileSync(testPath, content);

  return {
    skipped: false
  };
}

function patchEnv() {
  const envPath = projectPath('.env');

  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  content = upsertEnv(content, 'FLOKI_COGNITION_MODEL', 'qwen3.5:9b');
  content = upsertEnv(content, 'FLOKI_VISION_MODEL', 'qwen3-vl:4b');
  content = upsertEnv(content, 'FLOKI_COGNITION_ENABLED', '0');
  content = upsertEnv(content, 'FLOKI_REFLECTIVE_EMOTION_ENABLED', '0');
  content = upsertEnv(content, 'FLOKI_AFFECT_SCAFFOLD_ENABLED', '1');

  if (fs.existsSync(envPath)) {
    fs.copyFileSync(envPath, `${envPath}.bak.${timestamp()}`);
  }

  fs.writeFileSync(envPath, content);

  return {
    cognition_model: 'qwen3.5:9b',
    vision_model: 'qwen3-vl:4b'
  };
}

function upsertEnv(content, key, value) {
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, 'm');

  if (regex.test(content)) {
    return content.replace(regex, line);
  }

  if (!content.endsWith('\n')) {
    content += '\n';
  }

  return `${content}${line}\n`;
}

function patchPackageVersion() {
  const pkgPath = projectPath('package.json');

  if (!fs.existsSync(pkgPath)) {
    return {
      skipped: true
    };
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = '0.7.6';

  fs.copyFileSync(pkgPath, `${pkgPath}.bak.${timestamp()}`);
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  return {
    skipped: false,
    version: pkg.version
  };
}

function verify() {
  const configPath = projectPath('src/config/model-config.cjs');
  delete require.cache[require.resolve(configPath)];

  const modelConfig = require(configPath);
  const config = modelConfig.getModelConfig();

  modelConfig.validateModelConfig(config);

  if (modelConfig.cognition.model !== 'qwen3.5:9b') {
    throw new Error(`root cognition export wrong: ${modelConfig.cognition.model}`);
  }

  if (modelConfig.vision.model !== 'qwen3-vl:4b') {
    throw new Error(`root vision export wrong: ${modelConfig.vision.model}`);
  }

  return {
    cognition_model: config.cognition.model,
    vision_model: config.vision.model,
    cognition_enabled_now: config.cognition.enabled_in_current_stage,
    vision_enabled_now: config.vision.enabled_in_current_stage
  };
}

function main() {
  if (process.cwd() !== ROOT) {
    throw new Error(`Run this from ${ROOT}`);
  }

  patchModelConfig();
  const foundation_test = patchFoundationTest();
  const env = patchEnv();
  const pkg = patchPackageVersion();
  const verified = verify();

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FAST_PATCH_07_6_PASS',
    verified,
    foundation_test,
    env,
    package: pkg,
    note: 'model-config.cjs was hard-replaced to stop brittle regex patch failures'
  }, null, 2));
}

main();
