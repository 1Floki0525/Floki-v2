'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  createServiceWakeController,
  idleEligibility,
  resolveManualRunRequest,
  serviceLoop
} = require('../src/self-improvement/worker.cjs');
const {
  runNow
} = require('../src/self-improvement/promotion.cjs');
const {
  ensureApprovalToken,
  paths,
  readStatus,
  updateStatus
} = require('../src/self-improvement/store.cjs');
const {
  loadSelfImprovementConfig
} = require('../src/self-improvement/config.cjs');
const {
  dependencySeedFingerprint,
  inspectPersistentContainer,
  stopActiveRunProcess,
  stopWorkstationContainer
} = require('../src/self-improvement/sandbox.cjs');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, pollMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    last = await predicate();
    if (last) return last;
    await wait(pollMs);
  }
  throw new Error('timed out waiting for ' + label);
}

function writeJson(file, value, spacing = 2) {
  fs.writeFileSync(file, JSON.stringify(value, null, spacing) + '\n');
}

function verifyDependencyCacheIdentity() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'floki-dependency-cache-identity-')
  );
  try {
    const packageFile = path.join(root, 'package.json');
    const lockFile = path.join(root, 'package-lock.json');
    const manifest = {
      name: 'cache-contract',
      description: 'metadata must not control dependency cache identity',
      scripts: { test: 'node first.js' },
      packageManager: 'npm@11.0.0',
      dependencies: { alpha: '1.0.0' },
      devDependencies: { beta: '2.0.0' }
    };
    const lock = {
      name: 'cache-contract',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'cache-contract',
          version: '1.0.0',
          dependencies: { alpha: '1.0.0' },
          devDependencies: { beta: '2.0.0' }
        },
        'node_modules/alpha': {
          version: '1.0.0',
          resolved: 'https://registry.invalid/alpha-1.0.0.tgz',
          integrity: 'sha512-alpha'
        },
        'node_modules/beta': {
          version: '2.0.0',
          resolved: 'https://registry.invalid/beta-2.0.0.tgz',
          integrity: 'sha512-beta',
          dev: true
        }
      }
    };
    writeJson(packageFile, manifest);
    writeJson(lockFile, lock);
    const base = dependencySeedFingerprint(root, 'sha256');

    manifest.description = 'changed unrelated metadata';
    manifest.scripts.test = 'node second.js';
    writeJson(packageFile, manifest, 4);
    const unrelated = dependencySeedFingerprint(root, 'sha256');
    assert.equal(
      unrelated,
      base,
      'unrelated package.json metadata and script changes must preserve cache identity'
    );

    manifest.dependencies.alpha = '1.0.1';
    writeJson(packageFile, manifest);
    const dependencyChanged = dependencySeedFingerprint(root, 'sha256');
    assert.notEqual(
      dependencyChanged,
      base,
      'a real dependency change must invalidate cache identity'
    );

    manifest.dependencies.alpha = '1.0.0';
    writeJson(packageFile, manifest);
    lock.packages['node_modules/alpha'].version = '1.0.1';
    writeJson(lockFile, lock);
    const lockChanged = dependencySeedFingerprint(root, 'sha256');
    assert.notEqual(
      lockChanged,
      base,
      'a package-lock dependency resolution change must invalidate cache identity'
    );

    return Object.freeze({
      base,
      unrelated,
      dependency_changed: dependencyChanged,
      lock_changed: lockChanged
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readAuditRows(config) {
  const file = paths(config).auditFile;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function podmanInspect(config, container) {
  const result = spawnSync(config.sandbox_engine, [
    'inspect',
    '--format',
    '{{.Id}} {{.Name}} {{.State.Running}} {{.State.StartedAt}}',
    container
  ], {
    encoding: 'utf8',
    timeout: config.container_stop_command_timeout_ms,
    maxBuffer: config.podman_output_buffer_bytes
  });
  return Object.freeze({
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim()
  });
}

function isCiRunner() {
  return process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
}

function modelEndpointReady(config) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(config.model_proxy_health_path, config.model.endpoint);
    } catch (_error) {
      resolve(false);
      return;
    }

    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: 'GET',
      timeout: Math.min(3000, config.model_proxy_start_timeout_ms)
    }, (response) => {
      response.resume();
      response.once('end', () => {
        resolve(response.statusCode >= 200 && response.statusCode < 300);
      });
    });

    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.once('error', () => resolve(false));
    request.end();
  });
}

async function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  assert.equal(
    Number.isInteger(nodeMajor) && nodeMajor >= 24,
    true,
    'Node 24 or newer is required'
  );

  const cacheIdentity = verifyDependencyCacheIdentity();
  const sandboxSource = fs.readFileSync(
    path.join(__dirname, '..', 'src/self-improvement/sandbox.cjs'),
    'utf8'
  );
  for (const phase of [
    'workstation_starting',
    'workstation_ready',
    'dependency_cache_check',
    'dependency_seeding',
    'project_sync',
    'agent_sync',
    'transient_unit_starting',
    'sandbox_starting',
    'sandbox_acknowledged'
  ]) {
    assert.ok(
      sandboxSource.includes("'" + phase + "'"),
      'sandbox preparation phase is missing: ' + phase
    );
  }
  assert.match(
    sandboxSource,
    /persistent_config_host_root/,
    'test-shaped runtime state must be decoupled from the workstation config mount'
  );
  assert.match(
    sandboxSource,
    /failureTailSuffix/,
    'startup failures must include the real sandbox error tail'
  );

  if (process.env.FLOKI_RUN_NOW_STATIC_ONLY === '1') {
    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_RSI_RUN_NOW_STATIC_REPAIR_CONTRACT_PASS',
      dependency_cache_identity: cacheIdentity,
      live_integration_skipped: true
    }, null, 2));
    return;
  }

  const configured = loadSelfImprovementConfig();
  assert.equal(
    spawnSync(configured.sandbox_engine, ['--version'], {
      encoding: 'utf8',
      timeout: configured.container_stop_command_timeout_ms
    }).status,
    0,
    'real Podman sandbox engine must be available'
  );
  const workstationBefore = inspectPersistentContainer(configured);
  const workstationIdentityBefore = podmanInspect(
    configured,
    configured.persistent_container_name
  );
  assert.equal(workstationIdentityBefore.status, 0);
  assert.equal(
    workstationBefore.found,
    true,
    'permanent RSI workstation must already exist'
  );

  if (!(await modelEndpointReady(configured))) {
    if (isCiRunner()) {
      console.log(JSON.stringify({
        ok: true,
        skipped: true,
        marker: 'FLOKI_V2_RSI_RUN_NOW_IMMEDIATE_CI_PREREQ_SKIP',
        reason: 'model_endpoint_unavailable_on_ci_runner',
        real_worker: false,
        real_podman_container: false,
        local_live_proof_required: true
      }, null, 2));
      return;
    }
    throw new Error(
      'real Run-now integration requires the configured model endpoint: ' +
      configured.model.endpoint
    );
  }

  const wakeController = createServiceWakeController();
  const wakeStarted = Date.now();
  const waitPromise = wakeController.wait(configured.poll_ms);
  setTimeout(
    () => wakeController.wake('manual_run_signal'),
    configured.run_now_ack_poll_ms
  );
  const wakeReason = await waitPromise;
  const wakeElapsedMs = Date.now() - wakeStarted;
  assert.equal(wakeReason, 'manual_run_signal');
  assert.ok(
    wakeElapsedMs < configured.poll_ms,
    'worker wake did not interrupt the normal wait'
  );

  const activity = new Date().toISOString();
  const eligibility = idleEligibility(
    {
      api_ready: true,
      active_turn: false,
      hearing: { speaking: false },
      lifecycle: {
        state: 'asleep',
        is_asleep: true,
        manual_nap_active: true
      },
      started_at: activity,
      client_ready_at: activity
    },
    { paused: false, failure_latched_at: null },
    { ...configured, minimum_available_memory_mb: 0 },
    true
  );
  assert.deepEqual(
    eligibility,
    { eligible: true, reason: 'manual_force' }
  );

  const statusFallback = resolveManualRunRequest(
    null,
    {
      state: 'queued',
      phase: 'maker_requested_cycle',
      manual_run_request_id: 'status-request',
      manual_run_requested_at: activity,
      current_objective: 'Status-backed forced run.'
    },
    configured
  );
  assert.equal(statusFallback.force, true);
  assert.equal(statusFallback.request_id, 'status-request');

  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'floki-run-now-real-worker-')
  );
  const chatRuntimeRoot = path.join(root, 'chat-runtime');
  const runtimeRoot = path.join(root, 'rsi-runtime');
  const abortController = new AbortController();
  let workerPromise = null;
  let result = null;
  let inspected = null;

  const config = {
    ...configured,
    idle_seconds: Math.max(3600, configured.idle_seconds),
    poll_ms: Math.max(10000, configured.poll_ms),
    cooldown_seconds: Math.max(3600, configured.cooldown_seconds),
    minimum_available_memory_mb: 0,
    nightly_training_enabled: false,
    // The permanent workstation's bind mounts are immutable container
    // authority. Keep mounted workspace/outbox/model-proxy roots production-
    // accurate while isolating worker status, token, and candidate state.
    workspace_root: configured.workspace_root,
    candidate_root: path.join(root, 'candidates'),
    outbox_root: configured.outbox_root,
    runtime_root: runtimeRoot,
    model_proxy_root: configured.model_proxy_root,
    persistent_self_context_host_root: path.join(
      configured.runtime_root,
      'persistent-self-context'
    ),
    persistent_config_host_root: path.join(
      configured.runtime_root,
      'persistent-config'
    ),
    chat_runtime_root: chatRuntimeRoot
  };

  try {
    fs.mkdirSync(chatRuntimeRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(chatRuntimeRoot, 'chat-local-runtime.status.json'),
      JSON.stringify({
        marker: 'FLOKI_V2_CHAT_LOCAL_RUNTIME_STATUS',
        api_ready: true,
        active_turn: false,
        hearing: { speaking: false },
        lifecycle: {
          state: 'asleep',
          is_asleep: true,
          manual_nap_active: true
        },
        started_at: activity,
        client_ready_at: activity,
        last_turn_completed_at: activity
      }, null, 2) + '\n',
      { mode: 0o600 }
    );

    workerPromise = serviceLoop({
      config,
      stop_signal: abortController.signal,
      process_signal_names: []
    });

    await waitFor(() => {
      const status = readStatus(config);
      return status.worker_running === true &&
        status.model_proxy_ready === true
        ? status
        : null;
    }, config.run_now_ack_timeout_ms, config.run_now_ack_poll_ms, 'real worker readiness');

    const beforeRun = readStatus(config);
    await waitFor(() => {
      const status = readStatus(config);
      return status.phase === 'idle_threshold_not_reached'
        ? status
        : null;
    }, config.run_now_ack_timeout_ms, config.run_now_ack_poll_ms, 'automatic idle gate');
    const normalEligibility = idleEligibility(
      JSON.parse(
        fs.readFileSync(
          path.join(chatRuntimeRoot, 'chat-local-runtime.status.json'),
          'utf8'
        )
      ),
      beforeRun,
      config,
      false
    );
    assert.equal(normalEligibility.eligible, false);
    assert.equal(normalEligibility.reason, 'idle_threshold_not_reached');

    const token = ensureApprovalToken(config);
    result = await runNow(
      token,
      'Prove immediate manual execution through the real worker.',
      undefined,
      config
    );

    assert.equal(result.ok, true);
    assert.equal(result.verified, true);
    assert.equal(result.wake_signal_sent, true);
    assert.equal(result.bypass_idle_timer, true);
    assert.equal(result.sandbox_started, true);
    assert.match(result.run_id, /^rsi-\d{8}-\d{6}-[a-f0-9]+$/);
    assert.equal(
      result.container,
      config.persistent_container_name,
      'Run Now must use the existing permanent RSI workstation'
    );
    assert.notEqual(result.run_id, 'test-run');
    assert.notEqual(result.container, 'test-sandbox');

    inspected = podmanInspect(config, result.container);
    assert.equal(
      inspected.status,
      0,
      'Podman must inspect the real run-now sandbox: ' + inspected.stderr
    );
    assert.match(inspected.stdout, /true/);

    const acknowledged = readStatus(config);
    assert.equal(acknowledged.manual_run_request_id, result.request_id);
    assert.equal(
      typeof acknowledged.manual_run_acknowledged_at,
      'string',
      'acknowledgement must be durable in status'
    );
    assert.equal(acknowledged.current_run_id, result.run_id);
    assert.equal(acknowledged.current_container, result.container);
    assert.equal(fs.existsSync(paths(config).runRequestFile), false);

    const currentRun = JSON.parse(
      fs.readFileSync(paths(config).currentContainerFile, 'utf8')
    );
    assert.equal(currentRun.run_id, result.run_id);
    assert.equal(currentRun.name, result.container);
    assert.match(currentRun.unit, /^floki-rsi-agent-.+\.service$/);
    assert.ok(Number(currentRun.unit_main_pid) > 0);

    const unitInspect = spawnSync(config.sandbox_engine, [
      'exec',
      config.persistent_container_name,
      'systemctl',
      'show',
      currentRun.unit,
      '--property=ActiveState',
      '--property=MainPID'
    ], {
      encoding: 'utf8',
      timeout: config.run_unit_stop_timeout_ms,
      maxBuffer: config.podman_output_buffer_bytes
    });
    assert.equal(
      unitInspect.status,
      0,
      'transient run unit must be inspectable: ' +
        String(unitInspect.stderr || unitInspect.stdout || '').trim()
    );
    assert.match(String(unitInspect.stdout || ''), /ActiveState=active/);
    assert.match(String(unitInspect.stdout || ''), /MainPID=[1-9]\d*/);

    const auditRows = readAuditRows(config);
    const preparationPhases = auditRows
      .filter((row) =>
        row.type === 'sandbox_preparation_phase' &&
        row.detail?.run_id === result.run_id
      )
      .map((row) => row.detail.phase);
    for (const phase of [
      'workstation_starting',
      'workstation_ready',
      'dependency_cache_check',
      'project_sync',
      'agent_sync',
      'transient_unit_starting',
      'sandbox_starting',
      'sandbox_acknowledged'
    ]) {
      assert.ok(
        preparationPhases.includes(phase),
        'live Run Now audit did not record preparation phase: ' + phase
      );
    }
    assert.ok(
      auditRows.some((row) =>
        row.type === 'dependency_cache_summary' &&
        row.detail?.run_id === result.run_id
      ),
      'live Run Now audit must record the dependency cache hit/seed summary'
    );
  } finally {
    stopActiveRunProcess('run_now_contract_cleanup', config);
    abortController.abort();
    if (workerPromise) {
      await Promise.race([
        workerPromise,
        wait(config.run_now_ack_timeout_ms).then(() => {
          throw new Error('worker did not stop after test abort');
        })
      ]);
    }
    if (workstationBefore.found && workstationBefore.running !== true) {
      const stopped = stopWorkstationContainer(
        'run_now_contract_restore_initial_state',
        config
      );
      assert.equal(stopped.ok, true);
    }
    const workstationAfter = inspectPersistentContainer(configured);
    const workstationIdentityAfter = podmanInspect(
      configured,
      configured.persistent_container_name
    );
    assert.equal(workstationIdentityAfter.status, 0);
    assert.equal(
      workstationIdentityAfter.stdout.split(/\s+/)[0],
      workstationIdentityBefore.stdout.split(/\s+/)[0],
      'Run Now contract must preserve the workstation container ID'
    );
    assert.equal(workstationAfter.found, true);
    assert.equal(
      workstationAfter.running,
      workstationBefore.running,
      'Run Now contract must restore the workstation running state'
    );
    fs.rmSync(root, { recursive: true, force: true });
  }

  const workerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src/self-improvement/worker.cjs'),
    'utf8'
  );
  assert.match(workerSource, /process\.on\('SIGUSR1'/);
  assert.match(workerSource, /resolveManualRunRequest/);
  assert.match(workerSource, /request\?\.force === true/);
  assert.match(workerSource, /manual_run_starting/);
  assert.match(workerSource, /wait_for_container_start/);

  const runtimeSource = fs.readFileSync(
    path.join(__dirname, '..', 'src/runtime/chat-local-runtime.cjs'),
    'utf8'
  );
  assert.match(runtimeSource, /await selfImprovementApi\.runNow/);

  const panelSource = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'apps/floki-neural-interface/src/components/system/' +
        'SelfImprovementPanel.jsx'
    ),
    'utf8'
  );
  assert.match(panelSource, /result\?\.sandbox_started === true/);
  assert.match(panelSource, /nextStatus\?\.current_container/);
  assert.doesNotMatch(
    panelSource,
    /window\.prompt\([^)]*improvement objective/
  );
  assert.doesNotMatch(
    panelSource,
    /verifiedStatus\?\.state === 'queued'/
  );

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_RSI_RUN_NOW_IMMEDIATE_CONTRACT_PASS',
    normal_idle_seconds: config.idle_seconds,
    manual_run_bypasses_idle: true,
    sleep_and_nap_do_not_gate_rsi: true,
    worker_poll_interrupted: true,
    real_worker: true,
    real_run_id: result.run_id,
    real_podman_container: result.container,
    durable_acknowledgement: true,
    permanent_workstation_preserved: true,
    workstation_running_state_restored: true,
    workstation_container_id_preserved: true,
    dependency_cache_identity: cacheIdentity,
    podman_inspect: inspected.stdout
  }, null, 2));
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
