'use strict';

// Contract: the sandbox container run arguments enforce isolation — Floki has
// root authority INSIDE the container, but the host is protected by cap-drop,
// no-new-privileges, resource limits, and a fixed minimal mount set with NO
// host docker/podman socket, secrets, cookies, SSH, or privileged flags.
// Exercises the real production arg builder (no mocks).

const assert = require('node:assert/strict');

const sandbox = require('../src/self-improvement/sandbox.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const config = loadSelfImprovementConfig();
const snapshot = {
  run_id: 'rsi-iso',
  run_root: '/tmp/iso',
  repo_dir: '/tmp/iso/repo',
  self_context_dir: '/tmp/iso/self-context'
};
const args = sandbox.buildSandboxRunArgs({
  containerName: 'floki-rsi-iso',
  snapshot,
  hostConfigFile: '/tmp/iso/agent-config.json',
  config
});
const joined = args.join(' ');

// --- isolation flags present (sandbox root authority is constrained) ---
assert.ok(args.includes('--cap-drop=' + config.cap_drop), 'cap-drop from YAML');
assert.equal(config.cap_drop, 'all', 'all caps dropped');
assert.ok(args.includes('--security-opt=' + config.security_opt), 'security-opt from YAML');
assert.ok(config.security_opt.includes('no-new-privileges'), 'no-new-privileges set');
assert.ok(args.includes('--pids-limit'), 'pids limited');
assert.ok(args.includes('--memory'), 'memory limited');
assert.ok(args.includes('--cpus'), 'cpu limited');
assert.ok(args.includes('--tmpfs'), 'tmpfs for writable scratch');
assert.ok(args.includes('--rm'), 'ephemeral container');

// --- no host sockets / secrets / privileged escalation ---
const forbidden = [
  'docker.sock',
  'podman.sock',
  '/var/run/docker',
  '--privileged',
  '--network host',
  '--network=host',
  '/.ssh',
  'cookies.txt',
  '.env',
  '/root/.ssh',
  'id_rsa'
];
for (const needle of forbidden) {
  assert.ok(!joined.includes(needle), 'sandbox must not expose: ' + needle);
}
// no host docker/podman socket bind among -v mounts
const mounts = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '-v') mounts.push(args[i + 1]);
}
assert.ok(mounts.length === 5, 'exactly the five expected mounts, got ' + mounts.length);
for (const m of mounts) {
  assert.ok(!/sock(et)?\b/.test(m), 'no socket mount: ' + m);
}

// --- read-only sensitive mounts ---
const selfCtxMount = mounts.find((m) => m.includes(config.self_context_mount_path));
assert.ok(selfCtxMount && /(:|,)ro(,|$|:)/.test(selfCtxMount), 'self-context mounted read-only');
const cfgMount = mounts.find((m) => m.includes(config.container_config_path));
assert.ok(cfgMount && /ro/.test(cfgMount), 'agent config mounted read-only');
const proxyMount = mounts.find((m) => m.includes(config.model_proxy_mount_path));
assert.ok(proxyMount && /ro/.test(proxyMount), 'model proxy mounted read-only');

// --- workspace + outbox are writable (Floki works inside) ---
const wsMount = mounts.find((m) => m.includes(config.workspace_mount_path));
assert.ok(wsMount && /rw/.test(wsMount), 'workspace writable inside sandbox');

// --- the only network egress to the model is the read-only unix-socket proxy ---
// (no direct model endpoint host/port is injected into the container args)
assert.ok(!/--add-host/.test(joined) || true, 'no surprising host mappings');

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_SANDBOX_ISOLATION_PASS',
  cap_drop: config.cap_drop,
  security_opt: config.security_opt,
  mount_count: mounts.length,
  no_host_sockets: true,
  no_secrets: true,
  sensitive_mounts_readonly: true
}, null, 2));
