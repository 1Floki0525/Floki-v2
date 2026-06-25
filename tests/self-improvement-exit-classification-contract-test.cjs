'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { classifySandboxExit } = require('../src/self-improvement/worker.cjs');

function main() {
  const stoppedNoReason = classifySandboxExit({ code: 0, signal: null }, null, null);
  assert.equal(stoppedNoReason.ok, true, 'exit 0 must be classified as ok');
  assert.equal(stoppedNoReason.phase, 'completed');

  const preEmpty = classifySandboxExit({ code: 0, signal: null }, null, 'manual_nap_priority');
  assert.equal(preEmpty.preempted, true, 'preemption reason must produce preempted=true even with exit 0');

  const killed = classifySandboxExit({ code: 137, signal: 'SIGKILL' }, null, null);
  assert.equal(killed.killed, true, 'exit 137/SIGKILL with no preemption must be classified as killed');

  const killedDuringPreempt = classifySandboxExit({ code: 137, signal: 'SIGKILL' }, null, 'foreground_turn_active');
  assert.equal(killedDuringPreempt.preempted, true, 'preemption must take precedence over 137 classification');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_EXIT_CLASSIFICATION_PASS',
    zero_exit_classified_completed: stoppedNoReason.phase === 'completed',
    preemption_overrides: preEmpty.preempted === true,
    raw_137_only: killed.killed === true,
    preemption_137_overrides: killedDuringPreempt.preempted === true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main();
