'use strict';

/**
 * Vision reconciler for chat.local runtime.
 *
 * Enforces a single authoritative sensory reconciliation path:
 * - one desired-state calculation per reconcile call
 * - one shared in-flight start promise; all callers share the same promise
 * - no second start while starting or already ready
 * - sleep/nap stop happens once, wake start happens once
 * - stale completions cannot overwrite newer lifecycle state
 * - cancellation is honoured
 */

function createVisionReconciler(deps) {
  const {
    readStatus,
    startService,
    stopService,
    log
  } = deps;

  let desiredActive = false;
  let desiredGeneration = 0;
  let generation = 0;
  let lastCompletedGeneration = -1;
  let currentTask = null;
  let currentTaskGeneration = 0;
  let currentTaskAbortController = null;
  let currentTaskOp = null;
  let lastAwake = true;
  let lastLoggedKey = null;
  let lastCompletedOk = false;

  function logOnce(key, message) {
    if (lastLoggedKey !== key) {
      lastLoggedKey = key;
      log(message);
    }
  }

  async function runOp(active, gen, opDesiredGen) {
    const abortController = new AbortController();
    currentTaskAbortController = abortController;
    currentTaskOp = active ? 'start' : 'stop';

    const opPromise = active
      ? startService({ signal: abortController.signal })
      : stopService({ stop_tunnel: false });

    try {
      const result = await opPromise;
      if (generation !== gen) {
        throw new Error('stale completion ignored');
      }
      lastCompletedGeneration = opDesiredGen;
      lastCompletedOk = true;
      const stopMessage = lastAwake
        ? 'vision paused until interface ready'
        : 'vision paused for sleep';
      logOnce(active ? 'start-pass' : 'stop-pass', active
        ? 'vision enabled after interface ready'
        : stopMessage);
      return { ok: true, active, transition: active ? 'started' : 'stopped', result };
    } catch (error) {
      if (generation !== gen) {
        throw new Error('stale completion ignored');
      }
      lastCompletedGeneration = opDesiredGen;
      lastCompletedOk = false;
      logOnce(active ? 'start-fail' : 'stop-fail',
        (active ? 'vision awake start failed: ' : 'vision suspension failed: ') + error.message);
      throw error;
    } finally {
      if (currentTaskAbortController === abortController) {
        currentTaskAbortController = null;
      }
    }
  }

  function statusMatchesDesired(active, status) {
    if (!status || typeof status !== 'object') {
      return active === false;
    }
    if (active) {
      return status.ready_for_chat === true &&
        status.active === true &&
        status.service_process_alive !== false;
    }
    return status.active !== true && status.service_process_alive !== true;
  }

  function reconcile(active, context = {}) {
    if (active !== desiredActive) {
      desiredActive = active;
      desiredGeneration += 1;
    }
    if (context.awake !== undefined) {
      lastAwake = context.awake;
    }

    const gen = desiredGeneration;

    // Already reconciled to the desired state and nothing is running. For
    // successful starts, verify the actual service is still alive before no-op.
    if (!currentTask && lastCompletedGeneration >= gen) {
      const status = readStatus();
      if (lastCompletedOk && !statusMatchesDesired(active, status)) {
        lastCompletedGeneration = gen - 1;
      } else {
        return Promise.resolve({
          ok: true,
          transition: 'noop',
          active,
          status
        });
      }
    }

    // All callers that see the same desired generation share one in-flight promise.
    if (currentTask && currentTaskGeneration === gen) {
      return currentTask;
    }

    // Cancel an opposite in-flight operation and re-reconcile to the latest desired state.
    if (currentTask) {
      if (currentTaskAbortController) {
        currentTaskAbortController.abort();
      }
      const afterCancel = currentTask.catch((error) => { logOnce('task-rejected', 'vision reconciliation task rejected: ' + error.message); }).then(() => {
        if (currentTask === afterCancel) {
          currentTask = null;
          currentTaskGeneration = 0;
          currentTaskAbortController = null;
          currentTaskOp = null;
        }
        return reconcile(desiredActive, { awake: lastAwake });
      });
      currentTask = afterCancel;
      currentTaskGeneration = gen;
      currentTaskOp = 'reconcile_after_cancel';
      return afterCancel;
    }

    // Start a new operation toward the desired state.
    generation += 1;
    const taskGen = generation;
    const opDesiredGen = gen;
    const task = runOp(active, taskGen, opDesiredGen).finally(() => {
      if (currentTask === task) {
        currentTask = null;
        currentTaskGeneration = 0;
        currentTaskAbortController = null;
        currentTaskOp = null;
      }
    });
    currentTask = task;
    currentTaskGeneration = gen;
    return task;
  }

  return {
    reconcile,
    readStatus,
    getState: () => ({
      desired_active: desiredActive,
      desired_generation: desiredGeneration,
      in_flight_op: currentTaskOp,
      generation,
      last_completed_generation: lastCompletedGeneration
    })
  };
}

module.exports = { createVisionReconciler };
