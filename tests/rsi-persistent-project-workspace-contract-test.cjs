'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sandbox = require('../src/self-improvement/sandbox.cjs');
const { createSourceSnapshot } = require('../src/self-improvement/snapshot.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(command + ' failed: ' + String(result.stderr || result.stdout || ''));
  }
  return result.stdout;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-rsi-persistent-workspace-'));

try {
  const production = path.join(temp, 'production');
  fs.mkdirSync(path.join(production, 'src'), { recursive: true });
  fs.mkdirSync(path.join(production, 'node_modules', 'host-only'), { recursive: true });
  fs.mkdirSync(path.join(production, 'state', 'private'), { recursive: true });
  fs.mkdirSync(path.join(production, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(production, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(production, 'src', 'a.cjs'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(production, 'node_modules', 'host-only', 'index.js'), 'host\n');
  fs.writeFileSync(path.join(production, 'state', 'private', 'memory.json'), '{}\n');
  fs.writeFileSync(path.join(production, 'secrets', 'key.pem'), 'secret\n');
  fs.writeFileSync(path.join(production, '.env'), 'SECRET=1\n');
  run('git', ['init', '-q'], production);
  run('git', ['config', 'user.name', 'Fixture'], production);
  run('git', ['config', 'user.email', 'fixture@example.invalid'], production);
  run('git', ['add', '-A', '--', '.'], production);
  run('git', ['commit', '-q', '-m', 'baseline'], production);

  const baseConfig = loadSelfImprovementConfig();
  const config = {
    ...baseConfig,
    project_root: production,
    workspace_root: path.join(temp, 'workspaces'),
    candidate_root: path.join(temp, 'candidates'),
    outbox_root: path.join(temp, 'outbox'),
    runtime_root: path.join(temp, 'runtime'),
    chat_runtime_root: path.join(temp, 'chat-runtime'),
    model_proxy_root: path.join(temp, 'model-proxy'),
    persistent_source_mirror_directory_name: '_persistent-source-mirror-contract',
    persistent_project_workspace_path: '/opt/floki-rsi/workspace/Floki-v2-contract'
  };
  fs.mkdirSync(config.chat_runtime_root, { recursive: true });
  fs.writeFileSync(
    path.join(config.chat_runtime_root, 'chat-local-runtime.status.json'),
    '{"state":"idle","ready":true}\n'
  );

  const snapA = createSourceSnapshot({ config, run_id: 'rsi-contract-a' });
  const snapB = createSourceSnapshot({ config, run_id: 'rsi-contract-b' });
  assert.equal(snapA.persistent_project_workspace_path, config.persistent_project_workspace_path);
  assert.equal(snapB.persistent_project_workspace_path, config.persistent_project_workspace_path);
  assert.equal(fs.existsSync(path.join(snapA.run_root, 'repo')), false);
  assert.equal(fs.existsSync(path.join(snapB.run_root, 'repo')), false);

  const mirrorA = sandbox.syncProductionSourceMirror(config);
  const mirrorRoot = mirrorA.host_path;
  assert.equal(fs.existsSync(path.join(mirrorRoot, 'src', 'a.cjs')), true);
  assert.equal(fs.existsSync(path.join(mirrorRoot, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(mirrorRoot, 'state')), false);
  assert.equal(fs.existsSync(path.join(mirrorRoot, 'secrets')), false);
  assert.equal(fs.existsSync(path.join(mirrorRoot, '.env')), false);

  const persistentCache = path.join(config.workspace_root, 'dependency-cache-proof');
  fs.mkdirSync(persistentCache, { recursive: true });
  fs.writeFileSync(path.join(persistentCache, 'cache-hit'), 'preserve\n');
  fs.writeFileSync(path.join(mirrorRoot, 'src', 'rejected-edit.cjs'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(production, 'src', 'a.cjs'), 'module.exports = 3;\n');
  fs.writeFileSync(path.join(production, 'src', 'b.cjs'), 'module.exports = 4;\n');
  const mirrorB = sandbox.syncProductionSourceMirror(config);
  assert.equal(mirrorB.host_path, mirrorRoot);
  assert.equal(fs.existsSync(path.join(mirrorRoot, 'src', 'rejected-edit.cjs')), false);
  assert.equal(fs.readFileSync(path.join(mirrorRoot, 'src', 'a.cjs'), 'utf8'), 'module.exports = 3;\n');
  assert.equal(fs.existsSync(path.join(mirrorRoot, 'src', 'b.cjs')), true);
  assert.equal(fs.existsSync(path.join(persistentCache, 'cache-hit')), true);

  const execA = sandbox.buildPersistentSandboxExecArgs({
    containerName: config.persistent_container_name,
    snapshot: snapA,
    hostConfigFile: path.join(snapA.run_root, 'agent-config.json'),
    config
  });
  const execB = sandbox.buildPersistentSandboxExecArgs({
    containerName: config.persistent_container_name,
    snapshot: snapB,
    hostConfigFile: path.join(snapB.run_root, 'agent-config.json'),
    config
  });
  // The agent runs inside a run-scoped transient systemd unit; the working
  // directory travels on systemd-run instead of podman exec --workdir.
  const workdirOf = (args) => {
    const entry = args.find((value) =>
      String(value).startsWith('--working-directory='));
    return entry ? entry.slice('--working-directory='.length) : null;
  };
  const workdirA = workdirOf(execA);
  const workdirB = workdirOf(execB);
  assert.ok(execA.includes('systemd-run'), 'agent exec must run inside a transient unit');
  assert.ok(
    execA.some((value) => String(value).startsWith('--unit=floki-rsi-agent-')),
    'run unit must be run-scoped'
  );
  assert.equal(workdirA, config.persistent_project_workspace_path);
  assert.equal(workdirB, config.persistent_project_workspace_path);
  assert.equal(
    sandbox.agentConfig(snapA, { workspace_path: workdirA }, config).workspace_path,
    workdirA
  );
  assert.equal(
    sandbox.agentConfig(snapB, { workspace_path: workdirB }, config).workspace_path,
    workdirB
  );
  assert.equal(
    sandbox.agentConfig(snapA, {}, config).workspace_path,
    config.workspace_mount_path
  );
  assert.notEqual(snapA.run_root, snapB.run_root);
  assert.notEqual(
    path.join(config.outbox_root, snapA.run_id),
    path.join(config.outbox_root, snapB.run_id)
  );

  const execShell = execA.join(' ');
  assert.doesNotMatch(execShell, /rm -rf\s+['"]?\/workspace\b/);
  assert.doesNotMatch(execShell, /ln -s\s+[^;]*\s+['"]?\/workspace\b/);
  assert.equal(fs.readFileSync(path.join(production, 'src', 'a.cjs'), 'utf8'), 'module.exports = 3;\n');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_RSI_SINGLE_PERSISTENT_PROJECT_WORKSPACE_CONTRACT_PASS',
    persistent_workspace_path: config.persistent_project_workspace_path,
    run_a_workspace: workdirA,
    run_b_workspace: workdirB,
    run_roots_are_metadata_only: true,
    no_run_specific_repo: true,
    rejected_edit_removed_by_sync: true,
    dependency_cache_preserved: true,
    mirror_changed_items_second_sync: mirrorB.changed_items
  }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
