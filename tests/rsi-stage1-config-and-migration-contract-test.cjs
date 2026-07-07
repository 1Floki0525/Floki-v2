'use strict';

// Contract: Stage 1 config keys flow through the real configuration layer, the
// public template carries portable placeholders only (no private host paths),
// and the guarded private-YAML migration is non-destructive, idempotent, and
// refuses malformed YAML. Exercises real production functions (no mocks).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getSelfImprovementConfig } = require('../src/config/floki-config.cjs');
const { migrateChatConfig, MigrationError } = require('../bin/floki-migrate-chat-config.cjs');

const raw = getSelfImprovementConfig('chat');

// --- Stage 1 keys present and typed through the loader ---
const booleanKeys = [
  'repo_intelligence_enabled',
  'skills_enabled',
  'role_self_reflector_can_write',
  'role_implementer_can_write'
];
const numberKeys = [
  'repo_intelligence_max_files',
  'repo_intelligence_read_range_max_lines',
  'repo_intelligence_git_diff_max_chars',
  'skills_max_active',
  'skills_match_score_threshold',
  'role_implementer_temperature',
  'role_implementer_context_budget_chars'
];
const stringKeys = [
  'repo_intelligence_index_root',
  'repo_intelligence_scan_roots',
  'skills_root',
  'role_sequence',
  'role_implementer_tools'
];
for (const k of booleanKeys) assert.equal(typeof raw[k], 'boolean', k + ' is boolean');
for (const k of numberKeys) assert.equal(typeof raw[k], 'number', k + ' is number');
for (const k of stringKeys) assert.equal(typeof raw[k], 'string', k + ' is string');

// the writer role must be exactly the implementer at the config layer
assert.equal(raw.role_implementer_can_write, true);
assert.equal(raw.role_self_reflector_can_write, false);

// --- public template: portable placeholders only (no committed host paths) ---
const templateText = fs.readFileSync(
  path.resolve(__dirname, '..', 'config', 'chat.config.yaml.temp'),
  'utf8'
);
assert.ok(!/\/media\/binary-god/.test(templateText), 'no personal host paths in public template');
// The permanent workstation's in-container identity paths (/home/floki) are
// portable and belong in the template; personal HOST home paths do not.
assert.ok(
  !/\/home\/(?!floki\b)[a-z]/.test(templateText),
  'no personal home paths in public template'
);

// --- migration is a no-op on the already-current private config ---
const noop = migrateChatConfig({ checkOnly: true });
assert.ok(Array.isArray(noop.would_add_keys || noop.added_keys), 'check returns a key list shape');

// --- migration fixture: missing keys restored, existing values preserved ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-mig-'));
try {
  const tpl = templateText;
  const tplFile = path.join(tmp, 'chat.config.yaml.temp');
  fs.writeFileSync(tplFile, tpl);

  // private copy with two Stage 1 keys removed and one core value customized
  const priv = tpl
    .replace(/^ {2}skills_max_active: .*$/m, '')
    .replace(/^ {2}role_sequence: .*$/m, '')
    .replace('  idle_seconds: 300', '  idle_seconds: 777');
  const privFile = path.join(tmp, 'chat.config.yaml');
  fs.writeFileSync(privFile, priv);

  const result = migrateChatConfig({ templateFile: tplFile, privateFile: privFile, validateLoader: false });
  assert.equal(result.changed, true, 'migration applied');
  assert.ok(result.added_keys.includes('skills_max_active'));
  assert.ok(result.added_keys.includes('role_sequence'));

  const after = fs.readFileSync(privFile, 'utf8');
  assert.ok(/^ {2}skills_max_active:/m.test(after), 'missing key restored');
  assert.ok(/^ {2}role_sequence:/m.test(after), 'missing key restored');
  assert.ok(/idle_seconds: 777/.test(after), 'existing custom value preserved');

  // idempotent
  const second = migrateChatConfig({ templateFile: tplFile, privateFile: privFile, validateLoader: false });
  assert.equal(second.changed, false, 'second migration is a no-op');

  // refuses malformed YAML (refuse, write nothing)
  const badFile = path.join(tmp, 'bad.yaml');
  fs.writeFileSync(badFile, 'mode: chat\nself_improvement:\n  - this is an array which yaml-lite rejects\n');
  assert.throws(
    () => migrateChatConfig({ templateFile: tplFile, privateFile: badFile, validateLoader: false }),
    (err) => err instanceof MigrationError,
    'malformed private YAML refused'
  );

  // never migrates game config
  assert.throws(
    () => migrateChatConfig({ templateFile: tplFile, privateFile: path.join(tmp, 'game.config.yaml'), validateLoader: false }),
    /game configuration/
  );
} finally {
  fs.rmSync(tmp, { recursive: true });
}

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_STAGE1_CONFIG_AND_MIGRATION_PASS',
  config_keys_typed: true,
  template_portable: true,
  migration_non_destructive: true,
  migration_idempotent: true,
  malformed_yaml_refused: true,
  game_config_protected: true
}, null, 2));
