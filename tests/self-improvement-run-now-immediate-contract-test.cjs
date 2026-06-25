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
  stopCurrentContainer
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

function podmanInspect(config, container) {
  const result = spawnSync(config.sandbox_engine, [
    'inspect',
    '--format',
    '{{.Name}} {{.State.Running}} {{.State.StartedAt}}',
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

function removeContainer(config, container) {
  if (!container) return;
  spawnSync(config.sandbox_engine, ['rm', '-f', container], {
    encoding: 'utf8',
    timeout: config.container_stop_command_timeout_ms,
    maxBuffer: config.podman_output_buffer_bytes
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
  assert.equal(process.version, 'v24.17.0');

  const configured = loadSelfImprovementConfig();
  assert.equal(
    spawnSync(configured.sandbox_engine, ['--version'], {
      encoding: 'utf8',
      timeout: configured.container_stop_command_timeout_ms
    }).status,
    0,
    'real Podman sandbox engine must be available'
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
    workspace_root: path.join(root, 'workspaces'),
    candidate_root: path.join(root, 'candidates'),
    outbox_root: path.join(root, 'outbox'),
    runtime_root: runtimeRoot,
    model_proxy_root: path.join(root, 'model-proxy'),
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
      config
    );

    assert.equal(result.ok, true);
    assert.equal(result.verified, true);
    assert.equal(result.wake_signal_sent, true);
    assert.equal(result.bypass_idle_timer, true);
    assert.equal(result.sandbox_started, true);
    assert.match(result.run_id, /^rsi-\d{8}-\d{6}-[a-f0-9]+$/);
    assert.ok(
      result.container.startsWith(config.container_name_prefix + '-'),
      'container name must use the YAML-configured prefix'
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
  } finally {
    if (result?.container) {
      stopCurrentContainer('run_now_contract_cleanup', config);
      removeContainer(config, result.container);
    }
    abortController.abort();
    if (workerPromise) {
      await Promise.race([
        workerPromise,
        wait(config.run_now_ack_timeout_ms).then(() => {
          throw new Error('worker did not stop after test abort');
        })
      ]);
    }
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
    podman_inspect: inspected.stdout
  }, null, 2));
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
