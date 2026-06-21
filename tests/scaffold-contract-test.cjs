'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function run() {
  const requiredDirectories = [
    'docs',
    'bin',
    'src',
    'src/brain',
    'src/config',
    'src/util',
    'brain',
    'tests',
    'state',
    'state/floki',
    'state/floki/memories',
    'logs'
  ];

  for (const relativePath of requiredDirectories) {
    assert.equal(
      exists(relativePath),
      true,
      'Required directory is missing: ' + relativePath
    );
  }

  const requiredFiles = [
    'README.md',
    'AGENTS.md',
    'package.json',
    '.env.example',
    '.gitignore',
    'docs/ARCHITECTURE.md',
    'docs/STAGE_STATUS.md',
    'bin/floki-brain-proof.sh'
  ];

  for (const relativePath of requiredFiles) {
    assert.equal(
      exists(relativePath),
      true,
      'Required file is missing: ' + relativePath
    );
  }

  const brainModules = [
    'amygdala',
    'broca',
    'cerebellum',
    'emotions_base',
    'frontal',
    'hippocampus',
    'occipital',
    'temporal',
    'thalamus',
    'personality',
    'pineal'
  ];

  for (const moduleName of brainModules) {
    const moduleRoot = path.join('brain', moduleName);
    const readmePath = path.join(moduleRoot, 'README.md');
    const indexPath = path.join(moduleRoot, 'index.cjs');

    assert.equal(
      exists(readmePath),
      true,
      'README.md missing in ' + moduleRoot
    );
    assert.equal(
      exists(indexPath),
      true,
      'index.cjs missing in ' + moduleRoot
    );

    const source = fs.readFileSync(
      path.join(root, indexPath),
      'utf8'
    );

    assert.equal(
      source.trim().length > 0,
      true,
      'Brain module is empty: ' + indexPath
    );
  }

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_BRAIN_MODULE_STRUCTURE_CONTRACT_PASS',
    legacy_scaffold_only_marker_required: false,
    brain_module_count: brainModules.length,
    thalamus_path_correct: true
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_BRAIN_MODULE_STRUCTURE_CONTRACT_FAIL',
    error: error.message
  }, null, 2));
  process.exit(1);
}
