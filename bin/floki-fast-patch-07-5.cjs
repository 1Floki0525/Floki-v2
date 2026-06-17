'use strict';

/**
 * Floki-v2 fast patch 07.5
 *
 * Robust repair for model-config.cjs after 07.3 touched too much.
 *
 * Required final state:
 * - cognition default: qwen3.5:9b
 * - vision default: qwen3-vl:4b
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

  if (fs.existsSync(fullPath)) {
    fs.copyFileSync(fullPath, `${fullPath}.bak.${timestamp()}`);
  }

  fs.writeFileSync(fullPath, content);
  console.log(`patched ${relativePath}`);
}

function patchModelConfig() {
  let content = read('src/config/model-config.cjs');

  const before = {
    cognition_line: findLine(content, 'FLOKI_COGNITION_MODEL'),
    vision_line: findLine(content, 'FLOKI_VISION_MODEL')
  };

  content = replaceModelDefault(
    content,
    'FLOKI_COGNITION_MODEL',
    'qwen3.5:9b'
  );

  content = replaceModelDefault(
    content,
    'FLOKI_VISION_MODEL',
    'qwen3-vl:4b'
  );

  content = content.replace(
    "stage: 'stage_01_foundation_no_model_calls'",
    "stage: 'stage_07_affect_scaffold_no_cognition_calls'"
  );

  write('src/config/model-config.cjs', content);

  const after = {
    cognition_line: findLine(content, 'FLOKI_COGNITION_MODEL'),
    vision_line: findLine(content, 'FLOKI_VISION_MODEL')
  };

  return { before, after };
}

function replaceModelDefault(content, envName, modelName) {
  const regex = new RegExp(
    `(model\\s*:\\s*process\\.env\\.${envName}\\s*\\|\\|\\s*)['"][^'"]+['"]`,
    'm'
  );

  if (!regex.test(content)) {
    throw new Error(`Could not find model default for ${envName}`);
  }

  return content.replace(regex, `$1'${modelName}'`);
}

function findLine(content, needle) {
  const line = content
    .split('\n')
    .find((item) => item.includes(needle));

  return line ? line.trim() : null;
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

function patchEnvIfPresent() {
  const envPath = projectPath('.env');

  if (!fs.existsSync(envPath)) {
    return {
      skipped: true,
      reason: '.env not found'
    };
  }

  let content = fs.readFileSync(envPath, 'utf8');

  content = upsertEnv(content, 'FLOKI_COGNITION_MODEL', 'qwen3.5:9b');
  content = upsertEnv(content, 'FLOKI_VISION_MODEL', 'qwen3-vl:4b');

  fs.copyFileSync(envPath, `${envPath}.bak.${timestamp()}`);
  fs.writeFileSync(envPath, content);

  return {
    skipped: false,
    cognition: 'qwen3.5:9b',
    vision: 'qwen3-vl:4b'
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
  const pkg = JSON.parse(read('package.json'));
  pkg.version = '0.7.5';
  write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
}

function verify() {
  delete require.cache[require.resolve(projectPath('src/config/model-config.cjs'))];
  const loaded = require(projectPath('src/config/model-config.cjs'));

  const config = loaded.MODEL_CONFIG || loaded.getModelConfig && loaded.getModelConfig();

  if (!config) {
    throw new Error('Could not load MODEL_CONFIG or getModelConfig()');
  }

  if (config.cognition.model !== 'qwen3.5:9b') {
    throw new Error(`cognition model still wrong: ${config.cognition.model}`);
  }

  if (config.vision.model !== 'qwen3-vl:4b') {
    throw new Error(`vision model still wrong: ${config.vision.model}`);
  }

  if (typeof loaded.validateModelConfig === 'function') {
    loaded.validateModelConfig(config);
  }

  return {
    cognition_model: config.cognition.model,
    vision_model: config.vision.model
  };
}

function main() {
  if (process.cwd() !== ROOT) {
    throw new Error(`Run this from ${ROOT}`);
  }

  const modelPatch = patchModelConfig();
  patchFoundationTest();
  const envPatch = patchEnvIfPresent();
  patchPackageVersion();
  const verified = verify();

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FAST_PATCH_07_5_PASS',
    model_patch: modelPatch,
    env_patch: envPatch,
    verified,
    manual_line_edits_removed: true
  }, null, 2));
}

main();
