'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadYamlFile } = require('../src/config/yaml-lite.cjs');
const { PROJECT_ROOT } = require('../src/config/floki-config.cjs');

const REQUIRED_EXCLUDES = [
  'Qwen3.5-4B/',
  'models/',
  '*.safetensors'
];

function main() {
  const raw = loadYamlFile(path.join(PROJECT_ROOT, 'config', 'chat.config.yaml'));
  const excludes = String(raw.self_improvement && raw.self_improvement.snapshot_exclude_patterns || '');
  for (const required of REQUIRED_EXCLUDES) {
    if (!excludes.includes(required)) {
      assert.fail('snapshot_exclude_patterns is missing required exclusion: ' + required);
    }
  }
  if (!excludes.includes('data/')) {
    assert.fail('snapshot_exclude_patterns must exclude data/dreams/ or data/transcripts/ or similar data paths');
  }
  if (raw.self_improvement.environment_check_command_timeout_ms !== 60000) {
    assert.fail('environment_check_command_timeout_ms must be 60000 in YAML');
  }
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_SNAPSHOT_EXCLUDES_LARGE_DIRS_PASS',
    required_excludes_checked: REQUIRED_EXCLUDES,
    snapshot_exclude_patterns: excludes,
    environment_check_command_timeout_ms: raw.self_improvement.environment_check_command_timeout_ms,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main();
