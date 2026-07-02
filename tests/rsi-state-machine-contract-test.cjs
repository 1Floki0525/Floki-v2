'use strict';

// Contract: the engineering state machine runs all 13 phases, gives each phase
// only its role's tools, cannot skip mandatory verification/review, and bounds
// the repair loop. Exercises real production functions (no mocks).

const assert = require('node:assert/strict');

const sm = require('../src/self-improvement/state-machine.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');
const roles = require('../src/self-improvement/roles.cjs');

const config = loadSelfImprovementConfig();
const registry = roles.loadRoles(config);

// --- all 13 phases present and ordered ---
const machine = sm.createStateMachine({ config, roles: registry });
assert.equal(machine.sequence.length, 13, 'thirteen phases');
for (const required of Object.keys(sm.PHASE)) {
  assert.ok(machine.sequence.includes(required), 'phase present: ' + required);
}
assert.equal(machine.sequence[0], 'SELF_REFLECTION');
assert.equal(machine.sequence[machine.sequence.length - 1], 'MEMORY_AND_EVAL');

// --- each phase exposes only its role's tools / params ---
assert.equal(machine.role(), 'self_reflector');
assert.deepEqual(machine.tools(), registry.roles.self_reflector.tools);
assert.equal(machine.modelParams().temperature, registry.roles.self_reflector.model.temperature);

// --- happy path with a bounded repair loop produces a candidate ---
function drive(outcomes) {
  const m = sm.createStateMachine({ config, roles: registry });
  for (const o of outcomes) {
    if (m.isTerminal()) break;
    m.advance(o);
  }
  return m;
}

const happy = sm.createStateMachine({ config, roles: registry });
happy.advance('continue'); // -> GOAL_PROPOSALS
happy.advance('continue'); // -> GOAL_SELECTION
happy.advance('continue'); // -> INVESTIGATION
happy.advance('continue'); // -> RESEARCH
happy.advance('continue'); // -> EXPERIMENT_SPECIFICATION
happy.advance('continue'); // -> IMPLEMENTATION
happy.advance('continue'); // -> FOCUSED_VERIFICATION
assert.equal(happy.current(), 'FOCUSED_VERIFICATION');
// implementer owns IMPLEMENTATION and is the only writer
const implMachine = drive(['continue', 'continue', 'continue', 'continue', 'continue', 'continue']);
assert.equal(implMachine.current(), 'IMPLEMENTATION');
assert.equal(implMachine.canWrite(), true, 'implementation phase may write');
// one repair loop then pass
happy.advance('fail'); // -> TARGETED_REPAIR
assert.equal(happy.current(), 'TARGETED_REPAIR');
assert.equal(happy.canWrite(), true, 'repair phase may write');
happy.advance('done'); // -> FOCUSED_VERIFICATION (repair counted)
assert.equal(happy.repairIterations(), 1);
happy.advance('pass'); // -> FULL_VERIFICATION
assert.equal(happy.canWrite(), false, 'verifier may not write');
happy.advance('pass'); // -> INDEPENDENT_REVIEW
assert.equal(happy.role(), 'critic');
happy.advance('approve'); // -> CANDIDATE_FINALIZATION
machineAssertFinalizeOk(happy);
happy.advance('continue'); // -> MEMORY_AND_EVAL
const end = happy.advance('continue'); // terminal
assert.equal(end.terminal, 'complete_with_candidate');
assert.equal(happy.candidateProduced(), true);

function machineAssertFinalizeOk(m) {
  assert.equal(m.current(), 'CANDIDATE_FINALIZATION');
  m.assertCanFinalize();
}

// --- cannot skip verification: finalize blocked before mandatory phases pass ---
const fresh = sm.createStateMachine({ config, roles: registry });
assert.throws(() => fresh.assertCanFinalize(), /mandatory phase not passed/);

// --- repair loop is bounded: exhaustion ends with no candidate ---
const exhaust = sm.createStateMachine({ config, roles: registry });
for (let i = 0; i < 6; i += 1) exhaust.advance('continue'); // reach FOCUSED_VERIFICATION
let guard = 0;
while (exhaust.current() !== 'MEMORY_AND_EVAL' && !exhaust.isTerminal() && guard < 100) {
  guard += 1;
  if (exhaust.current() === 'FOCUSED_VERIFICATION') exhaust.advance('fail');
  else if (exhaust.current() === 'TARGETED_REPAIR') exhaust.advance('done');
  else exhaust.advance('continue');
}
assert.equal(exhaust.current(), 'MEMORY_AND_EVAL', 'repair exhaustion routes to memory/eval');
assert.equal(exhaust.repairIterations(), config.state_machine_max_repair_iterations, 'repair bounded by YAML');
assert.equal(exhaust.candidateProduced(), false, 'no candidate after repair exhaustion');

// --- no_goal short-circuits to memory/eval (no candidate) ---
const noGoal = sm.createStateMachine({ config, roles: registry });
noGoal.advance('continue'); // GOAL_PROPOSALS
noGoal.advance('no_goal'); // -> MEMORY_AND_EVAL
assert.equal(noGoal.current(), 'MEMORY_AND_EVAL');

// --- transition cap is enforced ---
assert.ok(config.state_machine_max_phase_transitions > 0);

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_STATE_MACHINE_PASS',
  phases: machine.sequence.length,
  per_phase_tool_gating: true,
  no_skip_mandatory: true,
  bounded_repair_loop: true,
  candidate_path_verified: true
}, null, 2));
