'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PROJECT_ROOT: ROOT } = require('../src/config/floki-config.cjs');
const { buildChatModeStatus } = require('../src/chat/chat-mode-status.cjs');
const {
  buildFlokiLifecycleStatus,
  formatLifecycleHumanSummary
} = require('../src/chat/floki-lifecycle-status.cjs');

function run() {
  const liveSource = fs.readFileSync(path.join(ROOT, 'src', 'chat', 'floki-live-chat-interface.cjs'), 'utf8');
  assert.equal(liveSource.includes('formatLifecycleStateLine'), true);
  assert.equal(liveSource.includes('Floki state:'), false);
  assert.equal(liveSource.includes('/state'), true);
  assert.equal(liveSource.includes('/sleep-status'), true);
  assert.equal(liveSource.includes('lifecycle_status'), true);
  assert.equal(liveSource.includes("appendChatTranscriptTurn({ role: 'floki', text: formatLifecycleStateLine"), false);
  assert.equal(liveSource.includes('lifecycle_transition_notifications_enabled'), true);
  assert.equal(liveSource.includes('lifecycle_status_poll_ms'), true);

  const startScript = fs.readFileSync(path.join(ROOT, 'bin', 'floki-start.sh'), 'utf8');
  assert.equal(startScript.includes('life-status'), true);
  assert.equal(startScript.includes('src/chat/floki-lifecycle-status.cjs'), true);
  assert.equal(startScript.includes('nvm use 24'), true);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=24 <25');
  assert.equal(pkg.scripts['status:lifecycle'], 'node src/chat/floki-lifecycle-status.cjs');
  assert.equal(Boolean(pkg.scripts['proof:lifecycle-status']), true);

  const status = buildChatModeStatus();
  assert.equal(status.lifecycle_status.marker, 'FLOKI_V2_LIFECYCLE_STATUS_PASS');
  assert.equal(typeof status.lifecycle_status.state, 'string');
  assert.equal(typeof status.lifecycle_status.display_label, 'string');
  assert.equal(typeof status.lifecycle_status.is_awake, 'boolean');
  assert.equal(typeof status.lifecycle_status.is_asleep, 'boolean');
  assert.equal(typeof status.lifecycle_status.is_rem_dreaming, 'boolean');

  const lifecycle = buildFlokiLifecycleStatus({ now: '2026-06-18T16:00:00.000Z' });
  const human = formatLifecycleHumanSummary(lifecycle);
  for (const forbidden of [
    '<think>',
    'chain-of-thought',
    'private_reasoning',
    'reasoning_trace',
    'internal_thought',
    'hidden_thought',
    'safe_thought_summary',
    'thought_summary',
    'dream body text',
    'pineal imagery',
    'private memory content'
  ]) {
    assert.equal(human.includes(forbidden), false);
    assert.equal(JSON.stringify(lifecycle).includes(forbidden), false);
  }

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_LIVE_CHAT_LIFECYCLE_DISPLAY_PASS',
    lifecycle_startup_display_present: true,
    lifecycle_commands_present: true,
    status_contains_lifecycle_status: true,
    lifecycle_output_private_safe: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_LIVE_CHAT_LIFECYCLE_DISPLAY_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
