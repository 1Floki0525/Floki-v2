'use strict';

// Behavioral contract for valid empty-root dependency caching.
//
// Replaces an earlier source-text artifact. It executes the REAL extracted
// predicate the agent uses to decide whether a project's package.json requires
// an installed node_modules tree — so an empty root manifest is treated as a
// valid cached empty tree rather than a failed install.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  dependencyManifestRequiresNodeModules
} = require(path.join(ROOT, 'src/self-improvement/dependency-manifest.cjs'));

function withManifest(manifest, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-dep-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(manifest));
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 1. An empty / packageless manifest does NOT require node_modules — a valid
//    empty tree that must be cached, not treated as a failed install.
withManifest({ name: 'root', private: true }, (dir) => {
  assert.equal(dependencyManifestRequiresNodeModules(dir), false, 'empty manifest is a valid empty tree');
});

// 2. Empty dependency objects are still an empty tree.
withManifest(
  { name: 'root', dependencies: {}, devDependencies: {}, optionalDependencies: {}, peerDependencies: {} },
  (dir) => {
    assert.equal(dependencyManifestRequiresNodeModules(dir), false, 'empty dependency objects are an empty tree');
  }
);

// 3. Any populated dependency group requires node_modules.
for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  withManifest({ name: 'root', [key]: { left: '1.0.0' } }, (dir) => {
    assert.equal(dependencyManifestRequiresNodeModules(dir), true, key + ' requires node_modules');
  });
}

// 4. Workspaces (array or object form) require node_modules.
withManifest({ name: 'root', workspaces: ['packages/*'] }, (dir) => {
  assert.equal(dependencyManifestRequiresNodeModules(dir), true, 'array workspaces require node_modules');
});
withManifest({ name: 'root', workspaces: { packages: ['apps/*'] } }, (dir) => {
  assert.equal(dependencyManifestRequiresNodeModules(dir), true, 'object workspaces require node_modules');
});
withManifest({ name: 'root', workspaces: [] }, (dir) => {
  assert.equal(dependencyManifestRequiresNodeModules(dir), false, 'empty workspaces stay an empty tree');
});

// 5. The real repository root is a valid empty dependency tree.
assert.equal(
  dependencyManifestRequiresNodeModules(ROOT),
  false,
  'real repository root is a valid empty dependency tree'
);

// 6. An unreadable manifest fails loudly (never silently treated as empty).
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-dep-bad-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ not json');
    assert.throws(() => dependencyManifestRequiresNodeModules(tmp), /unreadable/, 'invalid manifest throws');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_EMPTY_ROOT_DEPENDENCY_CACHE_CONTRACT_PASS',
  real_root_empty_tree: true
}, null, 2));
