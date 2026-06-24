'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadSelfImprovementConfig } = require('./config.cjs');
const {
  appendAudit,
  ensureLayout,
  importOutbox,
  listCandidates,
  nowIso,
  paths,
  readStatus,
  safeJson,
  updateStatus
} = require('./store.cjs');
const { createSourceSnapshot } = require('./snapshot.cjs');
const { runSandbox, stopCurrentContainer } = require('./sandbox.cjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRuntimeStatus(config) {
  return safeJson(
    path.join(config.chat_runtime_root, 'chat-local-runtime.status.json'),
    null
  );
}

function memoryAvailableMb() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = text.match(/^MemAvailable:\s+(\d+)\s+kB/im);
    return match ? Math.floor(Number(match[1]) / 1024) : Infinity;
  } catch (_error) {
    return Infinity;
  }
}

function idleEligibility(runtime, status, config, force = false) {
  if (!runtime || runtime.api_ready !== true) {
    return { eligible: false, reason: 'chat_runtime_not_ready' };
  }
  if (runtime.lifecycle?.is_awake !== true) {
    return { eligible: false, reason: 'sleep_or_rem_priority' };
  }
  if (runtime.lifecycle?.is_dreaming === true) {
    return { eligible: false, reason: 'dream_priority' };
  }
  if (runtime.lifecycle?.manual_nap_active === true) {
    return { eligible: false, reason: 'manual_nap_priority' };
  }
  if (runtime.active_turn === true) {
    return { eligible: false, reason: 'foreground_turn_active' };
  }
  if (runtime.hearing?.speaking === true) {
    return { eligible: false, reason: 'speech_output_active' };
  }
  if (status.paused === true) {
    return { eligible: false, reason: 'paused' };
  }
  if (memoryAvailableMb() < config.minimum_available_memory_mb) {
    return { eligible: false, reason: 'memory_pressure' };
  }

  const lastActivity = Math.max(
    Date.parse(runtime.last_turn_completed_at || '') || 0,
    Date.parse(runtime.last_turn_started_at || '') || 0,
    Date.parse(runtime.client_ready_at || '') || 0,
    Date.parse(runtime.started_at || '') || 0
  );
  if (!force && Date.now() - lastActivity < config.idle_seconds * 1000) {
    return { eligible: false, reason: 'idle_threshold_not_reached' };
  }
  return {
    eligible: true,
    reason: force ? 'manual_force' : 'idle_threshold_reached'
  };
}

function pendingCandidateExists(config) {
  return listCandidates(config).some((candidate) =>
    ['pending_review', 'approved', 'validating', 'deploying'].includes(
      candidate.status
    )
  );
}

function readRunRequest(config) {
  return safeJson(paths(config).runRequestFile, null);
}

function clearRunRequest(config) {
  fs.rmSync(paths(config).runRequestFile, { force: true });
}

async function runCycle(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  if (pendingCandidateExists(config)) {
    updateStatus({
      state: 'pending_review',
      phase: 'awaiting_maker_decision'
    }, config);
    return {
      ok: false,
      skipped: true,
      reason: 'candidate_pending_review'
    };
  }

  const snapshot = createSourceSnapshot({ config });
  updateStatus({
    state: 'researching',
    phase: 'snapshot_ready',
    current_run_id: snapshot.run_id,
    current_objective: options.objective || null,
    last_cycle_started_at: nowIso(),
    last_error: null
  }, config);

  const execution = runSandbox(snapshot, {
    config,
    objective: options.objective
  });
  let preemptReason = null;
  const preemptTimer = setInterval(() => {
    const status = readStatus(config);
    const runtime = readRuntimeStatus(config);
    const eligibility = idleEligibility(
      runtime,
      status,
      config,
      options.force === true
    );
    if (!eligibility.eligible && eligibility.reason !== 'paused') {
      preemptReason = eligibility.reason;
      stopCurrentContainer(eligibility.reason, config);
    }
    if (status.paused === true) {
      preemptReason = 'paused';
      stopCurrentContainer('paused', config);
    }
  }, config.worker_preemption_poll_ms);

  const exit = await new Promise((resolve) => {
    execution.child.once(
      'exit',
      (code, signal) => resolve({ code, signal })
    );
    execution.child.once(
      'error',
      (error) => resolve({ code: -1, signal: null, error })
    );
  });
  clearInterval(preemptTimer);
  execution.cleanup();

  if (preemptReason) {
    updateStatus({
      state: 'waiting_for_idle',
      phase: 'preempted',
      current_run_id: null,
      current_container: null,
      last_error: null
    }, config);
    appendAudit(
      'cycle_preempted',
      { run_id: snapshot.run_id, reason: preemptReason },
      config
    );
    return {
      ok: false,
      preempted: true,
      reason: preemptReason
    };
  }

  if (exit.code !== 0) {
    const message = exit.error
      ? exit.error.message
      : 'sandbox exited with status ' + exit.code +
        (exit.signal ? ' signal ' + exit.signal : '');
    updateStatus({
      state: 'failed',
      phase: 'sandbox_failed',
      current_run_id: null,
      current_container: null,
      last_error: message,
      last_cycle_completed_at: nowIso()
    }, config);
    appendAudit(
      'cycle_failed',
      { run_id: snapshot.run_id, error: message },
      config
    );
    return { ok: false, error: message };
  }

  const candidate = importOutbox(snapshot.run_id, config);
  return { ok: true, candidate_id: candidate.id };
}

async function serviceLoop() {
  const config = loadSelfImprovementConfig();
  const p = ensureLayout(config);
  fs.writeFileSync(p.pidFile, String(process.pid) + '\n', { mode: 0o600 });
  process.once('exit', () => fs.rmSync(p.pidFile, { force: true }));

  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      stopping = true;
      stopCurrentContainer('worker_shutdown', config);
    });
  }

  updateStatus({
    state: config.enabled ? 'waiting_for_idle' : 'disabled',
    phase: null,
    worker_running: true,
    started_at: nowIso(),
    last_error: null
  }, config);
  appendAudit('worker_started', { pid: process.pid }, config);

  while (!stopping) {
    const status = readStatus(config);
    if (!config.enabled) {
      updateStatus({ state: 'disabled', phase: null }, config);
      await sleep(config.poll_ms);
      continue;
    }
    if (status.paused) {
      updateStatus({ state: 'paused', phase: null }, config);
      await sleep(config.poll_ms);
      continue;
    }
    if (pendingCandidateExists(config)) {
      updateStatus({
        state: 'pending_review',
        phase: 'awaiting_maker_decision'
      }, config);
      await sleep(config.poll_ms);
      continue;
    }

    const request = readRunRequest(config);
    const runtime = readRuntimeStatus(config);
    const eligibility = idleEligibility(
      runtime,
      status,
      config,
      request?.force === true
    );
    if (!eligibility.eligible) {
      updateStatus({
        state: 'waiting_for_idle',
        phase: eligibility.reason,
        current_objective: request?.objective || null
      }, config);
      await sleep(config.poll_ms);
      continue;
    }

    clearRunRequest(config);
    try {
      await runCycle({
        config,
        force: request?.force === true,
        objective: request?.objective || ''
      });
    } catch (error) {
      updateStatus({
        state: 'failed',
        phase: 'worker_exception',
        current_run_id: null,
        current_container: null,
        last_error: error.stack || error.message,
        last_cycle_completed_at: nowIso()
      }, config);
      appendAudit(
        'worker_exception',
        { error: error.stack || error.message },
        config
      );
    }
    await sleep(config.cooldown_seconds * 1000);
  }

  updateStatus({
    state: 'stopped',
    phase: null,
    worker_running: false
  }, config);
  appendAudit('worker_stopped', { pid: process.pid }, config);
  fs.rmSync(p.pidFile, { force: true });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--once')) {
    const result = await runCycle({ force: args.has('--force') });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  await serviceLoop();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_SELF_IMPROVEMENT_WORKER_FAIL',
      error: error.stack || error.message
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  idleEligibility,
  memoryAvailableMb,
  pendingCandidateExists,
  readRuntimeStatus,
  runCycle,
  serviceLoop
};
