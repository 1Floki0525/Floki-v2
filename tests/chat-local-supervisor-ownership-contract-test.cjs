"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

assert.equal(
  Number(process.versions.node.split('.')[0]) >= 24,
  true,
  'Node 24 or newer is required'
);

const ROOT = path.resolve(__dirname, '..');
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), 'utf8');

const retiredLauncherName = 'floki-' + 'start.sh';
const retiredLauncherPath = path.join(ROOT, 'bin', retiredLauncherName);
const retiredLeasePath = path.join(
  ROOT,
  'src/runtime/chat-local-supervisor-lease.cjs'
);

assert.equal(
  fs.existsSync(retiredLauncherPath),
  false,
  'the retired multi-mode launcher must not exist'
);
assert.equal(
  fs.existsSync(retiredLeasePath),
  false,
  'the retired launcher-owned supervisor lease must not exist'
);

const runtime = read('bin/floki-runtime.sh');
const app = read('bin/floki-app.sh');
const cleanup = read('bin/floki-chat-local-cleanup.sh');
const template = read('config/chat.config.yaml.temp');
const promoter = read('src/self-improvement/promoter.cjs');

assert.match(runtime, /ACTION="\$\{1:-status\}"/);
assert.match(runtime, /  start\)/);
assert.match(runtime, /  stop\)/);
assert.match(runtime, /  restart\|reset\)/);
assert.match(runtime, /  status\)/);
assert.match(
  runtime,
  /usage: floki-runtime\.sh start\|stop\|reset\|restart\|status/
);

const resetBlock = runtime.match(
  /  restart\|reset\)[\s\S]*?\n    ;;/m
);
assert.ok(resetBlock, 'reset/restart action block must exist');
assert.ok(
  resetBlock[0].indexOf('"$0" stop') <
    resetBlock[0].indexOf('"$0" start'),
  'reset must complete stop before start'
);
assert.match(resetBlock[0], /FLOKI_RUNTIME_RESET_PASS/);
assert.match(resetBlock[0], /runtime_authority=bin\/floki-runtime\.sh/);

const startBlock = runtime.slice(
  runtime.indexOf('  start)'),
  runtime.indexOf('  stop)')
);
for (const required of [
  'start_runtime_owner',
  'floki-sleep-scheduler-start.sh',
  'floki-self-improvement-start.sh',
  'runtime_ready'
]) {
  assert.ok(startBlock.includes(required), 'missing runtime start stage: ' + required);
}

const stopBlock = runtime.slice(
  runtime.indexOf('  stop)'),
  runtime.indexOf('  restart|reset)')
);
for (const required of [
  'stop_app',
  'floki-chat-stop.sh',
  'floki-self-improvement-stop.sh',
  'floki-sleep-scheduler-stop.sh',
  'floki-chat-vision-stop.sh',
  'stop_project_processes',
  'stop_configured_model_containers',
  'unload_configured_models',
  'release_gpu_owner',
  'verify_shutdown_quiescence'
]) {
  assert.ok(stopBlock.includes(required), 'missing runtime stop stage: ' + required);
}
assert.match(stopBlock, /chat-local-supervisor-session\.json/);
assert.match(stopBlock, /chat-local-supervisor\.lock/);

assert.match(app, /runtime_autostart=false/);
assert.match(app, /runtime_ready \|\| fail/);
assert.match(app, /runtime_autostart=false/);
assert.doesNotMatch(
  app,
  /^\s*(?:exec\s+)?(?:bash\s+)?(?:"?\$ROOT\/bin\/floki-runtime\.sh"?|(?:\.\/)?bin\/floki-runtime\.sh)\s+start\b/m,
  'floki.app must not execute the shared runtime start command'
);

assert.match(cleanup, /FLOKI_CHAT_LOCAL_CLEANUP_DELEGATED/);
assert.match(cleanup, /exec bash "\$ROOT\/bin\/floki-runtime\.sh" stop/);
assert.doesNotMatch(cleanup, /chat-local-supervisor-lease/);

assert.match(
  template,
  /promotion_cleanup_command: "bash bin\/floki-runtime\.sh stop"/
);
assert.match(
  template,
  /promotion_restart_command: "bash bin\/floki-runtime\.sh start"/
);
assert.doesNotMatch(template, /floki-start\.sh/);

assert.match(promoter, /async function restartFlokiRuntime\(config\)/);
assert.doesNotMatch(promoter, /restartChatLocal/);

const tracked = spawnSync('git', ['ls-files', '-z'], {
  cwd: ROOT,
  encoding: 'utf8'
});
assert.equal(tracked.status, 0, tracked.stderr || 'git ls-files failed');
const forbiddenReferences = [];
for (const relative of tracked.stdout.split('\0').filter(Boolean)) {
  if (relative.endsWith('.txt')) continue;
  let source;
  try {
    source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  } catch (_error) {
    continue;
  }
  if (source.includes(retiredLauncherName)) {
    forbiddenReferences.push(relative);
  }
}
assert.deepEqual(
  forbiddenReferences,
  [],
  'tracked operational references to the retired launcher remain'
);

const dryRun = spawnSync(
  'bash',
  ['bin/floki-runtime.sh', 'reset'],
  {
    cwd: ROOT,
    env: { ...process.env, FLOKI_COMMANDS_DRY_RUN: '1' },
    encoding: 'utf8',
    timeout: 30000
  }
);
assert.equal(
  dryRun.status,
  0,
  dryRun.stdout + '\n' + dryRun.stderr
);
const dryOutput = String(dryRun.stdout || '') + String(dryRun.stderr || '');
assert.match(dryOutput, /FLOKI_RUNTIME_STOP_DRY_RUN/);
assert.match(dryOutput, /FLOKI_RUNTIME_START_DRY_RUN/);
assert.match(dryOutput, /FLOKI_RUNTIME_RESET_PASS/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RUNTIME_SINGLE_AUTHORITY_CONTRACT_PASS',
  sole_runtime_authority: 'bin/floki-runtime.sh',
  reset_command_verified: true,
  reset_order: 'stop_then_start',
  floki_app_client_only: true,
  retired_launcher_absent: true,
  retired_lease_absent: true,
  promotion_uses_runtime_authority: true,
  live_runtime_started_by_test: false
}, null, 2));
