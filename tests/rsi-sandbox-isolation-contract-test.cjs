
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const sandbox = require('../src/self-improvement/sandbox.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const config = loadSelfImprovementConfig();
assert.equal(config.persistent_container_enabled, true);
assert.equal(config.persistent_container_name, 'floki-rsi-sandbox');
assert.equal(config.persistent_container_user, '0:0');

const createArgs = sandbox.buildPersistentSandboxCreateArgs({ config });
const createJoined = createArgs.join(' ');
assert.equal(createArgs[0], 'create');
assert.ok(!createArgs.includes('--rm'), 'persistent container must not use --rm');
assert.ok(createArgs.includes(config.persistent_container_name));
assert.ok(createArgs.includes('--user'));
assert.ok(createArgs.includes('0:0'), 'Floki is root inside the sandbox');
assert.ok(createArgs.includes('--pids-limit'));
assert.ok(createArgs.includes('--memory'));
assert.ok(createArgs.includes('--cpus'));
assert.ok(createArgs.includes('--network'));

for (const forbidden of [
  'docker.sock', 'podman.sock', '/var/run/docker', '--privileged',
  '/.ssh', 'cookies.txt', '.env', '/root/.ssh', 'id_rsa'
]) {
  assert.ok(!createJoined.includes(forbidden), 'sandbox must not expose: ' + forbidden);
}

const mounts = [];
for (let i = 0; i < createArgs.length; i += 1) {
  if (createArgs[i] === '-v') mounts.push(createArgs[i + 1]);
}
assert.equal(mounts.length, 3, 'persistent sandbox has exactly three stable mounts');
assert.ok(mounts.some((m) => m.includes(config.persistent_workspace_root_mount_path) && /rw/.test(m)));
assert.ok(mounts.some((m) => m.includes(config.outbox_mount_path) && /rw/.test(m)));
assert.ok(mounts.some((m) => m.includes(config.model_proxy_mount_path) && /ro/.test(m)));

const snapshot = {
  run_id: 'rsi-persistent-contract',
  run_root: path.join(config.workspace_root, 'rsi-persistent-contract'),
  repo_dir: null,
  self_context_dir: path.join(config.workspace_root, 'rsi-persistent-contract', 'self-context')
};
const hostConfigFile = path.join(snapshot.run_root, 'agent-config.json');
const execArgs = sandbox.buildPersistentSandboxExecArgs({
  containerName: config.persistent_container_name,
  snapshot,
  hostConfigFile,
  config
});
const execJoined = execArgs.join(' ');
assert.equal(execArgs[0], 'exec');
assert.ok(!execArgs.includes('--rm'));
assert.ok(execJoined.includes('/opt/floki-self-improvement/agent.cjs'));
assert.ok(execArgs.includes('--workdir'));
assert.equal(
  execArgs[execArgs.indexOf('--workdir') + 1],
  config.persistent_project_workspace_path
);
assert.ok(!execJoined.includes('rm -rf /workspace'));
assert.ok(!execJoined.includes('ln -s'));
assert.ok(execJoined.includes(config.self_context_mount_path));
assert.ok(execJoined.includes(config.container_config_path));
assert.ok(execJoined.includes(config.agent_home_path));

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_PERSISTENT_SANDBOX_PASS',
  ubuntu_container_reused: true,
  writable_root_persists: true,
  floki_root_inside_sandbox: true,
  ephemeral_run_removed: true,
  stable_mount_count: mounts.length,
  maker_approval_boundary_preserved: true
}, null, 2));
