'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  MODULE_KEYS,
  LOG_KEYS
} = require(path.join(ROOT, 'src/control-plane/module-registry.cjs'));
const {
  ALL_LOG_KEYS,
  EXTRA_LOG_KEYS,
  normalizeLogRequest,
  readLogWorkspace,
  redactLogText,
  resolveLogKey
} = require(path.join(ROOT, 'src/control-plane/log-workspace.cjs'));
const {
  currentWeekStamp,
  moduleWeekFilePath,
  redactModuleLogText
} = require(path.join(ROOT, 'src/control-plane/module-logging.cjs'));

assert.deepEqual(
  ALL_LOG_KEYS,
  Object.freeze([...MODULE_KEYS, ...EXTRA_LOG_KEYS]),
  'log workspace keys must be every system module plus worker/active sandbox'
);

for (const key of MODULE_KEYS) {
  assert.equal(LOG_KEYS[key], key, 'module log key must be canonical: ' + key);
  const payload = readLogWorkspace(key, { limit: 20 });
  assert.equal(payload.ok, true, key + ' log workspace must open');
  assert.equal(payload.service, key);
  assert.equal(typeof payload.text, 'string');
  assert.ok(payload.file_name.endsWith('.log'));
}

assert.equal(resolveLogKey('Self-Improvement Worker'), 'rsi_worker');
assert.equal(resolveLogKey('Self-Improvement Active Sandbox'), 'rsi_sandbox');
assert.equal(resolveLogKey('active'), 'rsi_sandbox');
assert.equal(normalizeLogRequest('Self-Improvement Worker'), 'self_improvement_worker');

const secretText = [
  'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
  '"Authorization": "Bearer abcdefghijklmnopqrstuvwxyz"',
  'api_key=abcdefghi123456789',
  '"token": "abcdefghi123456789"',
  'cookie=sessionid=abcdefghi123456789'
].join('\n');
const redacted = redactLogText(secretText);
const moduleRedacted = redactModuleLogText(secretText);
assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz|abcdefghi123456789/);
assert.doesNotMatch(moduleRedacted, /abcdefghijklmnopqrstuvwxyz|abcdefghi123456789/);

const weekA = currentWeekStamp(new Date('2026-07-03T12:00:00Z'));
const weekB = currentWeekStamp(new Date('2026-07-12T12:00:00Z'));
assert.notEqual(weekA, weekB, 'week rollover must create a distinct week stamp');
assert.notEqual(
  moduleWeekFilePath('rsi', new Date('2026-07-03T12:00:00Z')),
  moduleWeekFilePath('rsi', new Date('2026-07-12T12:00:00Z')),
  'week rollover must create a distinct module log path'
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_LOG_WORKSPACE_BEHAVIOR_CONTRACT_PASS',
  module_log_count: MODULE_KEYS.length,
  extra_log_keys: EXTRA_LOG_KEYS
}, null, 2));
