'use strict';

/**
 * Floki-v2 fast patch 07.4
 *
 * Fixes the too-broad 07.3 model replacement:
 * - cognition must be qwen3.5:9b
 * - vision must remain qwen3-vl:4b
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

function read(relativePath) {
  return fs.readFileSync(projectPath(relativePath), 'utf8');
}

function write(relativePath, content) {
  const fullPath = projectPath(relativePath);
  fs.copyFileSync(fullPath, `${fullPath}.bak.${timestamp()}`);
  fs.writeFileSync(fullPath, content);
  console.log(`patched ${relativePath}`);
}

function replaceOrFail(content, regex, replacement, label) {
  if (!regex.test(content)) {
    throw new Error(`Could not patch ${label}`);
  }

  return content.replace(regex, replacement);
}

function patchModelConfig() {
  let content = read('src/config/model-config.cjs');

  content = replaceOrFail(
    content,
    /(cognition:\s*Object\.freeze\(\{[\s\S]*?model:\s*process\.env\.FLOKI_COGNITION_MODEL\s*\|\|\s*)['"][^'"]+['"]/,
    "$1'qwen3.5:9b'",
    'cognition model'
  );

  content = replaceOrFail(
    content,
    /(vision:\s*Object\.freeze\(\{[\s\S]*?model:\s*process\.env\.FLOKI_VISION_MODEL\s*\|\|\s*)['"][^'"]+['"]/,
    "$1'qwen3-vl:4b'",
    'vision model'
  );

  content = content.replace(
    "stage: 'stage_01_foundation_no_model_calls'",
    "stage: 'stage_07_affect_scaffold_no_cognition_calls'"
  );

  write('src/config/model-config.cjs', content);
}

function patchFoundationTest() {
  let content = read('tests/foundation-contract-test.cjs');

  content = content.replace(
    /assert\.equal\(modelConfig\.cognition\.model,\s*['"][^'"]+['"]\);/,
    "assert.equal(modelConfig.cognition.model, 'qwen3.5:9b');"
  );

  content = content.replace(
    /assert\.equal\(modelConfig\.vision\.model,\s*['"][^'"]+['"]\);/,
    "assert.equal(modelConfig.vision.model, 'qwen3-vl:4b');"
  );

  write('tests/foundation-contract-test.cjs', content);
}

function patchPackageVersion() {
  const pkgPath = 'package.json';
  const pkg = JSON.parse(read(pkgPath));
  pkg.version = '0.7.4';
  write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function main() {
  if (process.cwd() !== ROOT) {
    throw new Error(`Run this from ${ROOT}`);
  }

  patchModelConfig();
  patchFoundationTest();
  patchPackageVersion();

  const modelConfig = require(projectPath('src/config/model-config.cjs'));

  if (modelConfig.MODEL_CONFIG) {
    if (modelConfig.MODEL_CONFIG.cognition.model !== 'qwen3.5:9b') {
      throw new Error(`cognition model is wrong: ${modelConfig.MODEL_CONFIG.cognition.model}`);
    }

    if (modelConfig.MODEL_CONFIG.vision.model !== 'qwen3-vl:4b') {
      throw new Error(`vision model is wrong: ${modelConfig.MODEL_CONFIG.vision.model}`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FAST_PATCH_07_4_PASS',
    cognition_model: 'qwen3.5:9b',
    vision_model: 'qwen3-vl:4b',
    cause_fixed: '07.3 broad replacement accidentally touched vision config'
  }, null, 2));
}

main();
