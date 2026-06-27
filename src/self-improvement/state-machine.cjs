'use strict';

// Explicit engineering state machine for the RSI harness.
//
// Drives an autonomous cycle through ordered phases, giving each phase only the
// tools of its owning role (Stage 1 roles). Verification and independent review
// cannot be skipped, repair runs in a bounded loop (not one enormous turn), and
// all defaults come from chat YAML. The machine itself is deterministic; the
// model decisions feed in as phase outcomes.

const { loadSelfImprovementConfig } = require('./config.cjs');
const rolesModule = require('./roles.cjs');

const PHASE = Object.freeze({
  SELF_REFLECTION: 'SELF_REFLECTION',
  GOAL_PROPOSALS: 'GOAL_PROPOSALS',
  GOAL_SELECTION: 'GOAL_SELECTION',
  INVESTIGATION: 'INVESTIGATION',
  RESEARCH: 'RESEARCH',
  EXPERIMENT_SPECIFICATION: 'EXPERIMENT_SPECIFICATION',
  IMPLEMENTATION: 'IMPLEMENTATION',
  FOCUSED_VERIFICATION: 'FOCUSED_VERIFICATION',
  TARGETED_REPAIR: 'TARGETED_REPAIR',
  FULL_VERIFICATION: 'FULL_VERIFICATION',
  INDEPENDENT_REVIEW: 'INDEPENDENT_REVIEW',
  CANDIDATE_FINALIZATION: 'CANDIDATE_FINALIZATION',
  MEMORY_AND_EVAL: 'MEMORY_AND_EVAL'
});

function splitPipeList(value) {
  if (typeof value !== 'string') return [];
  return value.split('|').map((s) => s.trim()).filter(Boolean);
}

function parsePhaseRoles(value) {
  const map = {};
  for (const pair of splitPipeList(value)) {
    const [phase, role] = pair.split('=');
    if (phase && role) map[phase.trim()] = role.trim();
  }
  return map;
}

function createStateMachine(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const registry = options.roles || rolesModule.loadRoles(config);

  const sequence = splitPipeList(config.state_machine_phase_sequence);
  const phaseRoles = parsePhaseRoles(config.state_machine_phase_roles);
  const mandatory = splitPipeList(config.state_machine_mandatory_phases);
  const maxRepair = config.state_machine_max_repair_iterations;
  const maxTransitions = config.state_machine_max_phase_transitions;

  // Validate config integrity up front.
  for (const phase of sequence) {
    if (!PHASE[phase]) throw new Error('unknown phase in sequence: ' + phase);
    const role = phaseRoles[phase];
    if (!role) throw new Error('no role mapped for phase ' + phase);
    if (!registry.roles[role]) throw new Error('phase ' + phase + ' maps to unknown role ' + role);
  }
  for (const required of Object.keys(PHASE)) {
    if (!sequence.includes(required)) throw new Error('phase sequence missing required phase: ' + required);
  }
  for (const m of mandatory) {
    if (!sequence.includes(m)) throw new Error('mandatory phase not in sequence: ' + m);
  }

  let phase = sequence[0];
  let transitions = 0;
  let repairIterations = 0;
  let terminal = null;
  let candidateProduced = false;
  const visited = new Set([phase]);
  const passed = new Set();

  function role() {
    return phaseRoles[phase];
  }
  function roleDef() {
    return registry.roles[role()];
  }

  function repairBudgetRemaining() {
    return repairIterations < maxRepair;
  }

  function nextPhase(outcome) {
    switch (phase) {
      case PHASE.SELF_REFLECTION:
        return PHASE.GOAL_PROPOSALS;
      case PHASE.GOAL_PROPOSALS:
        return outcome === 'no_goal' ? PHASE.MEMORY_AND_EVAL : PHASE.GOAL_SELECTION;
      case PHASE.GOAL_SELECTION:
        // Controller rejection sends Floki back to re-propose; otherwise proceed.
        return outcome === 'reject' ? PHASE.GOAL_PROPOSALS : PHASE.INVESTIGATION;
      case PHASE.INVESTIGATION:
        return PHASE.RESEARCH;
      case PHASE.RESEARCH:
        return PHASE.EXPERIMENT_SPECIFICATION;
      case PHASE.EXPERIMENT_SPECIFICATION:
        return PHASE.IMPLEMENTATION;
      case PHASE.IMPLEMENTATION:
        return PHASE.FOCUSED_VERIFICATION;
      case PHASE.FOCUSED_VERIFICATION:
        if (outcome === 'pass') {
          passed.add(PHASE.FOCUSED_VERIFICATION);
          return PHASE.FULL_VERIFICATION;
        }
        return repairBudgetRemaining() ? PHASE.TARGETED_REPAIR : PHASE.MEMORY_AND_EVAL;
      case PHASE.TARGETED_REPAIR:
        repairIterations += 1;
        return PHASE.FOCUSED_VERIFICATION;
      case PHASE.FULL_VERIFICATION:
        if (outcome === 'pass') {
          passed.add(PHASE.FULL_VERIFICATION);
          return PHASE.INDEPENDENT_REVIEW;
        }
        return repairBudgetRemaining() ? PHASE.TARGETED_REPAIR : PHASE.MEMORY_AND_EVAL;
      case PHASE.INDEPENDENT_REVIEW:
        if (outcome === 'approve') {
          passed.add(PHASE.INDEPENDENT_REVIEW);
          return PHASE.CANDIDATE_FINALIZATION;
        }
        return PHASE.MEMORY_AND_EVAL;
      case PHASE.CANDIDATE_FINALIZATION:
        candidateProduced = true;
        return PHASE.MEMORY_AND_EVAL;
      case PHASE.MEMORY_AND_EVAL:
        return null; // terminal
      default:
        throw new Error('unhandled phase: ' + phase);
    }
  }

  return Object.freeze({
    PHASE,
    sequence: Object.freeze([...sequence]),
    mandatory_phases: Object.freeze([...mandatory]),
    current() {
      return phase;
    },
    role,
    tools() {
      return roleDef().tools;
    },
    modelParams() {
      return roleDef().model;
    },
    contextBudget() {
      return roleDef().context_budget_chars;
    },
    canWrite() {
      return roleDef().can_write;
    },
    isTerminal() {
      return terminal !== null;
    },
    terminalState() {
      return terminal;
    },
    repairIterations() {
      return repairIterations;
    },
    candidateProduced() {
      return candidateProduced;
    },
    // The only path to candidate finalization runs through all mandatory phases.
    assertCanFinalize() {
      for (const m of mandatory) {
        if (!passed.has(m)) {
          throw new Error('cannot finalize candidate: mandatory phase not passed: ' + m);
        }
      }
      return true;
    },
    advance(outcome) {
      if (terminal) throw new Error('state machine already terminal: ' + terminal);
      transitions += 1;
      if (transitions > maxTransitions) {
        terminal = 'max_transitions_exceeded';
        return { phase, terminal };
      }
      const next = nextPhase(outcome);
      if (next === null) {
        terminal = candidateProduced ? 'complete_with_candidate' : 'complete_no_candidate';
        return { phase, terminal };
      }
      // No-skip guard: finalization requires every mandatory phase passed.
      if (next === PHASE.CANDIDATE_FINALIZATION) {
        for (const m of mandatory) {
          if (!passed.has(m)) {
            throw new Error('illegal transition to CANDIDATE_FINALIZATION: ' + m + ' not passed');
          }
        }
      }
      phase = next;
      visited.add(phase);
      return { phase, terminal: null };
    },
    snapshot() {
      return Object.freeze({
        phase,
        role: role(),
        transitions,
        repair_iterations: repairIterations,
        visited: Object.freeze([...visited]),
        passed: Object.freeze([...passed]),
        terminal,
        candidate_produced: candidateProduced
      });
    }
  });
}

module.exports = {
  PHASE,
  parsePhaseRoles,
  splitPipeList,
  createStateMachine
};
