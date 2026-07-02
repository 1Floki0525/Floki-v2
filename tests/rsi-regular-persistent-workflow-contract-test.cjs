'use strict';

// Behavioral regression contract for the preserved persistent-RSI workflow.
//
// Replaces an earlier source-text artifact. Every assertion executes real
// production code: the self-improvement config loader, the extracted dependency
// manifest predicate, the extracted workspace containment guard, and a read-only
// pass over the live candidate store. No agent.cjs source-text assertions.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { loadSelfImprovementConfig } = require(path.join(ROOT, 'src/self-improvement/config.cjs'));
const { dependencyManifestRequiresNodeModules } = require(path.join(ROOT, 'src/self-improvement/dependency-manifest.cjs'));
const { assertRealPathInsideRoot } = require(path.join(ROOT, 'src/self-improvement/workspace-guard.cjs'));
const { classifyExperimentAgainstPriors } = require(path.join(ROOT, 'src/self-improvement/candidate-dedup.cjs'));

const config = loadSelfImprovementConfig();

// 1 + 2. Root and interface dependency caching remain configured. The persistent
//        container, the on-disk dependency cache root, its marker file, and the
//        sha256 fingerprint that drives cache-hit detection are all intact.
{
  assert.equal(config.persistent_container_enabled, true, 'persistent container stays enabled');
  assert.equal(config.persistent_container_name, 'floki-rsi-sandbox');
  assert.ok(config.persistent_dependency_cache_root, 'dependency cache root configured');
  assert.ok(config.persistent_dependency_cache_marker_file, 'dependency cache marker configured');
  assert.equal(config.dependency_fingerprint_algorithm, 'sha256', 'cache fingerprint stays sha256');
  assert.equal(config.interface_project_path, 'apps/floki-neural-interface');
  // The interface project declares installable packages, so its cache covers a
  // real node_modules tree.
  assert.equal(
    dependencyManifestRequiresNodeModules(path.join(ROOT, config.interface_project_path)),
    true,
    'interface manifest requires node_modules (cache covers a real tree)'
  );
}

// 3. A valid EMPTY root dependency tree remains accepted: the real root manifest
//    declares no installable packages, and a synthesized empty manifest is the
//    same — both must report "no node_modules required" rather than failing.
{
  assert.equal(
    dependencyManifestRequiresNodeModules(ROOT),
    false,
    'real repo root is a valid empty dependency tree'
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-empty-tree-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'root', private: true }));
    assert.equal(dependencyManifestRequiresNodeModules(tmp), false, 'empty manifest accepted as valid empty tree');
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ dependencies: { left: '1.0.0' } }));
    assert.equal(dependencyManifestRequiresNodeModules(tmp), true, 'populated manifest requires install');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 4 + 5. Real workspace containment still permits valid project files and still
//        rejects an escape through a real symlink that resolves outside the
//        workspace.
{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-ws-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-out-'));
  try {
    const workspaceReal = fs.realpathSync.native(workspace);
    const validFile = path.join(workspace, 'src', 'real.cjs');
    fs.mkdirSync(path.dirname(validFile), { recursive: true });
    fs.writeFileSync(validFile, 'module.exports = {};');
    // A valid project file resolves inside the workspace and is accepted.
    assert.equal(
      assertRealPathInsideRoot(workspaceReal, validFile, 'target'),
      fs.realpathSync.native(validFile),
      'valid project file permitted'
    );

    // A symlink inside the workspace pointing outside it must be rejected.
    const secret = path.join(outside, 'secret.cjs');
    fs.writeFileSync(secret, 'leak');
    const escape = path.join(workspace, 'escape.cjs');
    fs.symlinkSync(secret, escape);
    assert.throws(
      () => assertRealPathInsideRoot(workspaceReal, escape, 'target'),
      /escapes workspace/,
      'symlink escape rejected'
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

// 6. The existing candidate store is read only. We capture each manifest's status
//    and mtime, run the production dedup classifier over the candidates (the same
//    read the agent performs), and assert nothing in the store changed.
{
  const candidateRoot = config.candidate_root;
  const before = [];
  if (fs.existsSync(candidateRoot)) {
    for (const name of fs.readdirSync(candidateRoot)) {
      const manifestFile = path.join(candidateRoot, name, 'manifest.json');
      if (!fs.existsSync(manifestFile)) continue;
      const stat = fs.statSync(manifestFile);
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (_) { continue; }
      before.push({ id: manifest.id, status: manifest.status, mtimeMs: stat.mtimeMs, file: manifestFile });
    }
  }

  // Exercise the read path the agent uses; it must not mutate candidate state.
  const priors = before.map((b) => {
    const manifest = JSON.parse(fs.readFileSync(b.file, 'utf8'));
    return { id: manifest.id, status: manifest.status, experiment: manifest.experiment || {} };
  });
  classifyExperimentAgainstPriors(
    { objective: 'unrelated probe', hypothesis: 'none', target_files: ['src/none.cjs'], focused_test: 'node tests/none.cjs' },
    priors,
    { occupied_candidate_statuses: config.occupied_candidate_statuses }
  );

  for (const b of before) {
    const stat = fs.statSync(b.file);
    const manifest = JSON.parse(fs.readFileSync(b.file, 'utf8'));
    assert.equal(stat.mtimeMs, b.mtimeMs, 'candidate manifest must not be rewritten: ' + b.id);
    assert.equal(manifest.status, b.status, 'candidate status must be unchanged: ' + b.id);
  }

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_RSI_REGULAR_PERSISTENT_WORKFLOW_CONTRACT_PASS',
    persistent_container: config.persistent_container_name,
    root_empty_tree_accepted: true,
    candidate_count_read_only: before.length
  }, null, 2));
}
