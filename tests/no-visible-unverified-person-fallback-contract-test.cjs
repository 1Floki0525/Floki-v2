'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runtimeRoots = [
  path.join(root, 'src'),
  path.join(root, 'apps'),
];

const forbiddenPhrase = 'unverified person candidate';
const forbiddenRuntimeFiles = [];

function walk(directory) {
  if (!fs.existsSync(directory)) return;

  for (const entry of fs.readdirSync(directory, {
    withFileTypes: true,
  })) {
    if (
      entry.name === '.git' ||
      entry.name === 'node_modules' ||
      entry.name === 'dist'
    ) {
      continue;
    }

    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (!/\.(cjs|mjs|js|jsx|ts|tsx|json|yaml|yml|html|css)$/i.test(
      entry.name
    )) {
      continue;
    }

    const text = fs.readFileSync(fullPath, 'utf8');

    if (text.includes(forbiddenPhrase)) {
      forbiddenRuntimeFiles.push(
        path.relative(root, fullPath)
      );
    }
  }
}

for (const runtimeRoot of runtimeRoots) {
  walk(runtimeRoot);
}

assert.deepEqual(
  forbiddenRuntimeFiles,
  [],
  'prohibited visible unverified-person fallback remains in runtime source: ' +
    forbiddenRuntimeFiles.join(', ')
);

const verifierPath = path.join(
  root,
  'src/vision/person-presence-verifier.cjs'
);

assert.equal(
  fs.existsSync(verifierPath),
  true,
  'person presence verifier must exist'
);

const verifier = fs.readFileSync(verifierPath, 'utf8');

assert.match(
  verifier,
  /bucket:\s*['"]suppressed['"]/,
  'unverified person candidates must be suppressed'
);

assert.match(
  verifier,
  /sources\.includes\('yolo'\).*sources\.includes\('grounding_dino'\)/s,
  'provisional person visibility must require detector consensus'
);

assert.match(
  verifier,
  /personConsensusDisplayMinConfidence/,
  'provisional person visibility must require a configured confidence threshold'
);

assert.doesNotMatch(
  verifier,
  /label:\s*['"]unverified person candidate['"]/,
  'the removed fallback label must never be emitted'
);

console.log(JSON.stringify({
  ok: true,
  marker:
    'FLOKI_NO_VISIBLE_UNVERIFIED_PERSON_FALLBACK_CONTRACT_PASS',
  runtime_source_scanned: [
    'src',
    'apps',
  ],
  test_assertion_text_allowed: true,
  raw_yolo_only_person_candidates_visible: false,
  consensus_person_candidates_visible: true,
  failed_or_uncertain_nonconsensus_visible: false,
  live_services_started_by_test: false,
}, null, 2));
