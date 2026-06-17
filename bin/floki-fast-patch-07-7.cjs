'use strict';

/**
 * Floki-v2 fast patch 07.7
 *
 * Restores legacy model-config helper exports required by foundation tests:
 * - getCognitionConfig()
 * - getVisionConfig()
 *
 * Keeps:
 * - cognition: qwen3.5:9b
 * - vision: qwen3-vl:4b
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const CONFIG_PATH = path.join(ROOT, 'src/config/model-config.cjs');

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function main() {
  if (process.cwd() !== ROOT) {
    throw new Error(`Run this from ${ROOT}`);
  }

  let content = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak.${timestamp()}`);

  if (!content.includes('function getCognitionConfig()')) {
    content = content.replace(
      `function getModelConfig() {
  validateModelConfig(MODEL_CONFIG);
  return MODEL_CONFIG;
}

module.exports = {`,
      `function getModelConfig() {
  validateModelConfig(MODEL_CONFIG);
  return MODEL_CONFIG;
}

function getCognitionConfig() {
  validateModelConfig(MODEL_CONFIG);
  return MODEL_CONFIG.cognition;
}

function getVisionConfig() {
  validateModelConfig(MODEL_CONFIG);
  return MODEL_CONFIG.vision;
}

function getStageFlags() {
  validateModelConfig(MODEL_CONFIG);
  return MODEL_CONFIG.stage_flags;
}

module.exports = {`
    );
  }

  content = content.replace(
    /module\.exports = \{[\s\S]*?\n\};/,
    `module.exports = {
  ...MODEL_CONFIG,
  MODEL_CONFIG,
  getModelConfig,
  getCognitionConfig,
  getVisionConfig,
  getStageFlags,
  validateModelConfig
};`
  );

  fs.writeFileSync(CONFIG_PATH, content);

  delete require.cache[require.resolve(CONFIG_PATH)];
  const models = require(CONFIG_PATH);

  models.validateModelConfig();

  if (models.getCognitionConfig().model !== 'qwen3.5:9b') {
    throw new Error(\`bad cognition model: \${models.getCognitionConfig().model}\`);
  }

  if (models.getVisionConfig().model !== 'qwen3-vl:4b') {
    throw new Error(\`bad vision model: \${models.getVisionConfig().model}\`);
  }

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FAST_PATCH_07_7_PASS',
    cognition_model: models.getCognitionConfig().model,
    vision_model: models.getVisionConfig().model,
    compatibility_helpers_restored: [
      'getCognitionConfig',
      'getVisionConfig',
      'getStageFlags'
    ]
  }, null, 2));
}

main();
