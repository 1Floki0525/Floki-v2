'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadYamlFile } = require('../src/config/yaml-lite.cjs');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const RUNNER_TEMP = path.resolve(process.env.RUNNER_TEMP || os.tmpdir());
const CI_ROOT = path.join(RUNNER_TEMP, 'floki-v2-ci');

const CHAT_TEMPLATE = path.join(CONFIG_DIR, 'chat.config.yaml.temp');
const GAME_TEMPLATE = path.join(CONFIG_DIR, 'game.config.yaml.temp');
const CHAT_CONFIG = path.join(CONFIG_DIR, 'chat.config.yaml');
const GAME_CONFIG = path.join(CONFIG_DIR, 'game.config.yaml');

const DREAM_ROOT = path.join(CI_ROOT, 'Floki-memory-bank', 'dreams');
const MEDIA_ROOT = path.join(CI_ROOT, 'Floki-media');
const YOUTUBE_ROOT = path.join(MEDIA_ROOT, 'text', 'youtube');
const COOKIE_FILE = path.join(CI_ROOT, 'secrets', 'cookies.txt');

function fail(message) {
  console.error('FLOKI_V2_CI_CONFIG_PREPARE_FAIL: ' + message);
  process.exit(1);
}

function requireFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail('required file is missing: ' + filePath);
  }
}

function replaceScalar(source, key, value) {
  const lines = String(source).split(/\r?\n/);
  let replacements = 0;

  const output = lines.map((line) => {
    const match = line.match(new RegExp('^(\\s*)' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:'));
    if (!match) return line;
    replacements += 1;
    return match[1] + key + ': ' + value;
  });

  if (replacements !== 1) {
    fail('expected exactly one YAML key named ' + key + ', found ' + replacements);
  }

  return output.join('\n');
}

function prepareConfig(templateFile, outputFile, values) {
  requireFile(templateFile);
  let source = fs.readFileSync(templateFile, 'utf8');

  for (const [key, value] of Object.entries(values)) {
    source = replaceScalar(source, key, value);
  }

  if (source.includes('/absolute/path/')) {
    fail('public placeholder path remains in ' + path.basename(outputFile));
  }

  fs.writeFileSync(outputFile, source.replace(/\s*$/, '\n'), 'utf8');
}

function ensureRunnerPaths() {
  for (const directory of [DREAM_ROOT, MEDIA_ROOT, YOUTUBE_ROOT, path.dirname(COOKIE_FILE)]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(COOKIE_FILE)) {
    fs.writeFileSync(COOKIE_FILE, '', 'utf8');
  }
}

function validatePreparedConfig(filePath, expectedMode, includeCookie) {
  const config = loadYamlFile(filePath);
  if (config.mode !== expectedMode) {
    fail(path.basename(filePath) + ' mode mismatch');
  }

  const paths = config.paths || {};
  const required = ['dream_root', 'media_root', 'youtube_transcript_root'];
  if (includeCookie) required.push('youtube_cookies_file');

  for (const key of required) {
    const value = paths[key];
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      fail(path.basename(filePath) + ' paths.' + key + ' must be an absolute runner path');
    }
    if (!path.resolve(value).startsWith(CI_ROOT + path.sep)) {
      fail(path.basename(filePath) + ' paths.' + key + ' escaped the runner temp root');
    }
  }
}

function main() {
  ensureRunnerPaths();

  prepareConfig(CHAT_TEMPLATE, CHAT_CONFIG, {
    dream_root: DREAM_ROOT,
    media_root: MEDIA_ROOT,
    youtube_transcript_root: YOUTUBE_ROOT,
    youtube_cookies_file: COOKIE_FILE
  });

  prepareConfig(GAME_TEMPLATE, GAME_CONFIG, {
    dream_root: DREAM_ROOT,
    media_root: MEDIA_ROOT,
    youtube_transcript_root: YOUTUBE_ROOT
  });

  validatePreparedConfig(CHAT_CONFIG, 'chat', true);
  validatePreparedConfig(GAME_CONFIG, 'game', false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CI_CONFIG_PREPARED',
    runner_temp_root: CI_ROOT,
    chat_config: CHAT_CONFIG,
    game_config: GAME_CONFIG,
    private_host_paths_used: false,
    public_placeholder_paths_used: false
  }, null, 2));
}

try {
  main();
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}
