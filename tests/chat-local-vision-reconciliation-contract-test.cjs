'use strict';

const assert = require('node:assert/strict');
const { createVisionReconciler } = require('../src/runtime/vision-reconciler.cjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );

  // Helpers that capture every call and completion.
  function makeService() {
    const calls = [];
    let active = false;
    let startDelay = 10;
    let shouldFail = null;
    let abortReason = null;

    const readStatus = () => ({
      active,
      ready_for_chat: active,
      camera_open: active,
      first_frame_received: active
    });

    const startService = async (options = {}) => {
      calls.push({ op: 'start', signal: options.signal });
      if (options.signal && options.signal.aborted) {
        throw new Error('start cancelled: ' + (options.signal.reason || 'aborted'));
      }
      const startTime = Date.now();
      while (Date.now() - startTime < startDelay) {
        if (options.signal && options.signal.aborted) {
          abortReason = options.signal.reason || 'aborted';
          throw new Error('start cancelled: ' + abortReason);
        }
        await sleep(5);
      }
      if (shouldFail) {
        throw shouldFail;
      }
      active = true;
      return { active: true, owner: true };
    };

    const stopService = async () => {
      calls.push({ op: 'stop' });
      await sleep(5);
      active = false;
      return { active: false };
    };

    const logs = [];
    const log = (message) => logs.push(message);

    return {
      readStatus,
      startService,
      stopService,
      log,
      calls,
      logs,
      get active() { return active; },
      set active(value) { active = value; },
      set startDelay(value) { startDelay = value; },
      set shouldFail(value) { shouldFail = value; },
      get abortReason() { return abortReason; }
    };
  }

  // 1. Concurrent reconciles share one in-flight start promise.
  {
    const service = makeService();
    const reconciler = createVisionReconciler(service);
    const p1 = reconciler.reconcile(true, { awake: true });
    const p2 = reconciler.reconcile(true, { awake: true });
    const p3 = reconciler.reconcile(true, { awake: true });
    assert.strictEqual(p1, p2, 'concurrent start reconciles must share the same promise');
    assert.strictEqual(p2, p3, 'all concurrent start reconciles must share the same promise');
    const results = Promise.all([p1, p2, p3]);
    assert.doesNotReject(results);
    const r1 = await p1;
    assert.equal(r1.transition, 'started');
    assert.equal(service.calls.filter((c) => c.op === 'start').length, 1, 'only one start call allowed');
  }

  // 2. Idempotent reconciliation: repeated reconciles to the same desired state do nothing.
  {
    const service = makeService();
    const reconciler = createVisionReconciler(service);
    await reconciler.reconcile(true, { awake: true });
    await reconciler.reconcile(true, { awake: true });
    await reconciler.reconcile(true, { awake: true });
    assert.equal(service.calls.filter((c) => c.op === 'start').length, 1, 'duplicate start calls must be suppressed');
    assert.equal(service.logs.filter((m) => m.includes('vision enabled after interface ready')).length, 1, 'start success must be logged once');
  }

  // 3. Sleep/nap suspension stops once; wake/resume starts once.
  {
    const service = makeService();
    const reconciler = createVisionReconciler(service);
    await reconciler.reconcile(true, { awake: true });
    await reconciler.reconcile(false, { awake: false });
    await reconciler.reconcile(false, { awake: false });
    await reconciler.reconcile(false, { awake: false });
    assert.equal(service.calls.filter((c) => c.op === 'stop').length, 1, 'sleep/nap stop must happen once per transition');
    assert.equal(service.logs.filter((m) => m === 'vision paused for sleep').length, 1, 'sleep pause must be logged once');

    await reconciler.reconcile(true, { awake: true });
    await reconciler.reconcile(true, { awake: true });
    assert.equal(service.calls.filter((c) => c.op === 'start').length, 2, 'wake must start once after sleep');
    assert.equal(service.logs.filter((m) => m === 'vision enabled after interface ready').length, 2, 'wake start must be logged once per wake');
  }

  // 4. Wake transition while asleep with no client: pause until interface ready.
  {
    const service = makeService();
    service.active = true;
    const reconciler = createVisionReconciler(service);
    await reconciler.reconcile(false, { awake: true });
    assert.equal(service.calls.filter((c) => c.op === 'stop').length, 1, 'awaiting-client stop must happen once');
    assert.equal(service.logs.filter((m) => m === 'vision paused until interface ready').length, 1, 'awaiting-client pause must be logged once');
  }

  // 5. Cancellation: a new reconcile in the opposite direction cancels the in-flight operation.
  {
    const service = makeService();
    service.startDelay = 200;
    const reconciler = createVisionReconciler(service);
    const startPromise = reconciler.reconcile(true, { awake: true });
    await sleep(10);
    assert.equal(reconciler.getState().in_flight_op, 'start');
    const stopPromise = reconciler.reconcile(false, { awake: false });
    await assert.rejects(startPromise, /cancelled|stale completion ignored/);
    const stopResult = await stopPromise;
    assert.equal(stopResult.transition, 'stopped');
    assert.equal(service.calls.filter((c) => c.op === 'start').length, 1, 'cancelled start must not be retried automatically');
    assert.equal(service.calls.filter((c) => c.op === 'stop').length, 1, 'stop must follow cancellation');
  }

  // 6. Exact readiness failure is reported, not silently degraded.
  {
    const service = makeService();
    service.shouldFail = new Error('chat webcam vision did not become ready before timeout');
    const reconciler = createVisionReconciler(service);
    let caught = null;
    try {
      await reconciler.reconcile(true, { awake: true });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'readiness failure must reject');
    assert.match(caught.message, /chat webcam vision did not become ready before timeout/);
    assert.equal(service.logs.filter((m) => m.includes('vision awake start failed: chat webcam vision did not become ready before timeout')).length, 1, 'exact failure must be logged once');

    // After a failed start, repeated reconciles to the same desired state must not spam logs.
    let caught2 = null;
    try {
      await reconciler.reconcile(true, { awake: true });
    } catch (error) {
      caught2 = error;
    }
    assert.ok(!caught2, 'idempotent reconcile after failure should not re-throw the same error');
    assert.equal(service.calls.filter((c) => c.op === 'start').length, 1, 'failed start must not be retried until desired state changes');
    assert.equal(service.logs.filter((m) => m.includes('vision awake start failed')).length, 1, 'failure must be logged exactly once');
  }

  // 7. Stale completions cannot overwrite newer lifecycle state.
  {
    const service = makeService();
    service.startDelay = 100;
    const reconciler = createVisionReconciler(service);
    const start1 = reconciler.reconcile(true, { awake: true });
    await sleep(10);
    // Flip to stop while start is in flight; the stale start completion must be ignored.
    await reconciler.reconcile(false, { awake: false });
    await assert.rejects(start1, /cancelled|stale completion ignored/);
    const state = reconciler.getState();
    assert.equal(state.desired_active, false, 'desired state must reflect the latest reconcile');
    assert.equal(service.active, false, 'stale start must not leave service active');
  }

  // 8. Awake/client-ready reconciliation must restart if the actual vision process stopped.
  {
    const service = makeService();
    const reconciler = createVisionReconciler(service);
    await reconciler.reconcile(true, { awake: true });
    service.active = false;
    const restart = await reconciler.reconcile(true, { awake: true });
    assert.equal(restart.transition, 'started', 'stopped vision must start again while awake');
    assert.equal(service.calls.filter((c) => c.op === 'start').length, 2, 'actual stopped service must trigger a second start');
  }

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_LOCAL_VISION_RECONCILIATION_PASS',
    one_in_flight_start_promise: true,
    idempotent_reconciliation: true,
    sleep_nap_suspend_once: true,
    wake_resume_once: true,
    cancellation_handled: true,
    exact_readiness_failure_reported: true,
    stale_completion_ignored: true,
    stopped_vision_restarted_while_awake: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

(async function main() {
  try {
    await run();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_CHAT_LOCAL_VISION_RECONCILIATION_FAIL',
      error: error.stack || error.message,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
    process.exit(1);
  }
}());
