'use strict';

// Contract: role-separated agent contexts load from YAML, enforce per-role tool
// allowlists, and guarantee exactly one writer with a one-writer lock. Exercises
// real production functions (no mocks).

const assert = require('node:assert/strict');

const roles = require('../src/self-improvement/roles.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const config = loadSelfImprovementConfig();
const registry = roles.loadRoles(config);

// --- all 8 roles present and ordered ---
assert.equal(registry.sequence.length, 8, 'eight role contexts');
for (const name of roles.ROLE_KEYS) {
  assert.ok(registry.roles[name], 'role present: ' + name);
}

// --- exactly one writer (the implementer) ---
assert.equal(registry.writer_role, 'implementer', 'implementer is the sole writer');
const writers = Object.values(registry.roles).filter((r) => r.can_write);
assert.equal(writers.length, 1, 'exactly one role may write');

// --- phase-specific model params come from YAML and differ per role ---
assert.equal(registry.roles.implementer.model.temperature, config.role_implementer_temperature);
assert.notEqual(
  registry.roles.self_reflector.model.temperature,
  registry.roles.verifier.model.temperature,
  'roles carry distinct phase-specific temperatures'
);
for (const name of roles.ROLE_KEYS) {
  assert.equal(typeof registry.roles[name].context_budget_chars, 'number');
  assert.ok(registry.roles[name].context_budget_chars > 0, name + ' has a context budget');
  assert.ok(registry.roles[name].tools.length > 0, name + ' has a tool allowlist');
}

// --- tool allowlist enforcement ---
assert.throws(() => roles.assertToolAllowed('researcher', 'write_file', registry), /not allowed/);
assert.throws(() => roles.assertToolAllowed('verifier', 'apply_patch', registry), /not allowed|may not/);
roles.assertToolAllowed('implementer', 'apply_patch', registry); // allowed
roles.assertToolAllowed('repo_investigator', 'find_callers', registry); // allowed

// --- non-writer roles must not list write tools (config integrity) ---
for (const name of roles.ROLE_KEYS) {
  if (name === registry.writer_role) continue;
  for (const tool of roles.WRITE_TOOLS) {
    assert.ok(!registry.roles[name].tools.includes(tool), name + ' must not have write tool ' + tool);
  }
}

// --- one-writer lock ---
const lock = roles.createWriterLock(registry);
assert.equal(lock.holder(), null, 'lock initially free');
const release = lock.acquire('implementer');
assert.equal(lock.holder(), 'implementer');
// concurrent different writer rejected (none other can_write, but the lock must
// reject any second holder regardless)
assert.throws(() => lock.acquire('verifier'), /may not acquire|already held/);
// write tool requires holding the lock
lock.assertCanWrite('implementer', 'apply_patch');
release();
assert.equal(lock.holder(), null, 'lock released');
// after release, a write tool use without the lock must be rejected
assert.throws(() => lock.assertCanWrite('implementer', 'apply_patch'), /must hold the writer lock/);

// --- buildRoleContext returns a clean, focused context ---
const ctx = roles.buildRoleContext('goal_selector', registry);
assert.equal(ctx.role, 'goal_selector');
assert.equal(ctx.can_write, false);
assert.equal(ctx.is_writer, false);
assert.ok(Array.isArray(ctx.tools) && ctx.tools.length > 0);

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_ROLE_SEPARATION_PASS',
  role_count: registry.sequence.length,
  writer_role: registry.writer_role,
  one_writer_enforced: true,
  tool_allowlists_enforced: true,
  phase_specific_params: true
}, null, 2));
