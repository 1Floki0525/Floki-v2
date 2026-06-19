'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PROJECT_ROOT } = require('../src/config/floki-config.cjs');
const { loadYamlFile } = require('../src/config/yaml-lite.cjs');

const RUNTIME_SOURCE_DIRS = ['src', 'brain'];
const RUNTIME_EXTENSIONS = ['.cjs'];

const FORBIDDEN_ABSOLUTE_PATHS = [
  '/media/binary-god/1tb-ssd/Floki-v2',
  '/media/binary-god/2tb-ssd/Floki-media',
  '/media/binary-god/2tb-ssd/Floki-media/text/youtube',
  '/mnt/firstlight-cold-storage/Floki-memory-bank/dreams'
];

function configuredModelValues() {
  const values = new Set();

  for (const mode of ['chat', 'game']) {
    const raw = loadYamlFile(
      path.join(PROJECT_ROOT, 'config', mode + '.config.yaml')
    );

    for (const section of [
      raw.models && raw.models.cognition,
      raw.models && raw.models.vision
    ]) {
      if (!section || typeof section !== 'object') continue;
      if (typeof section.model === 'string' && section.model.trim()) {
        values.add(section.model.trim());
      }
    }
  }

  return Array.from(values);
}

const FORBIDDEN_MODEL_ASSERTIONS = configuredModelValues();

const FORBIDDEN_RUNTIME_DEFAULTS = [
  'DEFAULT_SLEEP_START_HHMM',
  'DEFAULT_SLEEP_END_HHMM',
  'DEFAULT_TIMEZONE',
  'DEFAULT_DREAM_ROOT',
  'FLOKI_MEDIA_ROOT = "',
  'const ROOT = "/media/',
  "const ROOT = '/media/"
];

const FORBIDDEN_TIMEOUT_PATTERNS = [
  'timeout: 120000',
  'timeout: 60000',
  'timeout: 5000',
  'timeout: 30000',
  'timeout: 20000',
  'timeout: 10000',
  'setTimeout(_, 120000',
  'setTimeout(_, 60000',
  'setTimeout(_, 5000',
  'setTimeout(_, 30000',
  'setTimeout(_, 20000'
];

const FORBIDDEN_AUDIO_DEFAULTS = [
  'mic_rate = 16000',
  'mic_channels = 1',
  "mic_format = 'S16_LE'",
  'mic_format = "S16_LE"',
  "whisper_model_size = 'small'",
  "whisper_model_size = 'tiny'",
  "whisper_model_size = 'base'",
  "whisper_model_size = 'large'"
];

const ALLOWLIST_FILES = ['config/chat.config.yaml', 'config/game.config.yaml'];
const ALLOWLIST_DIRS = ['docs/', 'reports/'];

function gatherRuntimeFiles() {
  const files = [];
  for (const dir of RUNTIME_SOURCE_DIRS) {
    const fullDir = path.join(PROJECT_ROOT, dir);
    if (!fs.existsSync(fullDir)) continue;
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (RUNTIME_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) files.push(full);
      }
    };
    walk(fullDir);
  }
  return files;
}

function isExempt(filePath) {
  const rel = path.relative(PROJECT_ROOT, filePath);
  if (rel.startsWith(path.join('src', 'config', 'floki-config.cjs'))) return true;
  if (rel.startsWith(path.join('src', 'config', 'yaml-lite.cjs'))) return true;
  if (rel.startsWith(path.join('tests', ''))) return true;
  for (const dir of ALLOWLIST_DIRS) if (rel.startsWith(dir)) return true;
  for (const file of ALLOWLIST_FILES) if (rel === file) return true;
  return false;
}

function scanFile(filePath) {
  const rel = path.relative(PROJECT_ROOT, filePath);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const violations = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNum = index + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    for (const forbidden of FORBIDDEN_ABSOLUTE_PATHS) {
      if (line.includes(forbidden)) violations.push({ file: rel, line: lineNum, pattern: 'absolute_path', value: forbidden });
    }
    for (const forbidden of FORBIDDEN_MODEL_ASSERTIONS) {
      if (line.includes(forbidden)) violations.push({ file: rel, line: lineNum, pattern: 'model_assertion', value: forbidden });
    }
    for (const forbidden of FORBIDDEN_RUNTIME_DEFAULTS) {
      if (line.includes(forbidden)) violations.push({ file: rel, line: lineNum, pattern: 'runtime_default', value: forbidden });
    }
    for (const forbidden of FORBIDDEN_TIMEOUT_PATTERNS) {
      if (line.includes(forbidden)) violations.push({ file: rel, line: lineNum, pattern: 'hardcoded_timeout', value: forbidden });
    }
    for (const forbidden of FORBIDDEN_AUDIO_DEFAULTS) {
      if (line.includes(forbidden)) violations.push({ file: rel, line: lineNum, pattern: 'hardcoded_audio_default', value: forbidden });
    }
  }

  return violations;
}

function run() {
  const files = gatherRuntimeFiles();
  assert.ok(files.length > 0, 'must find runtime source files to scan');

  const allViolations = [];
  for (const file of files) {
    if (!isExempt(file)) allViolations.push(...scanFile(file));
  }

  if (allViolations.length > 0) {
    const summary = allViolations.map((violation) =>
      violation.file + ':' + violation.line + ' [' + violation.pattern + '] ' + violation.value
    ).join('\n');
    assert.fail('Found ' + allViolations.length + ' hardcoded runtime config violation(s):\n' + summary);
  }

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_NO_HARDCODED_RUNTIME_CONFIG_PASS',
    files_scanned: files.length,
    files_exempt: files.filter((file) => isExempt(file)).length,
    files_checked: files.filter((file) => !isExempt(file)).length,
    violations_found: 0,
    forbidden_absolute_paths_checked: FORBIDDEN_ABSOLUTE_PATHS.length,
    forbidden_model_assertions_checked: FORBIDDEN_MODEL_ASSERTIONS.length,
    forbidden_runtime_defaults_checked: FORBIDDEN_RUNTIME_DEFAULTS.length,
    forbidden_timeout_patterns_checked: FORBIDDEN_TIMEOUT_PATTERNS.length,
    forbidden_audio_defaults_checked: FORBIDDEN_AUDIO_DEFAULTS.length,
    model_values_sourced_only_from_yaml: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_NO_HARDCODED_RUNTIME_CONFIG_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
