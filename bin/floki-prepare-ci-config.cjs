'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadYamlFile } = require('../src/config/yaml-lite.cjs');

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');

function requireFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error('required file is missing: ' + filePath);
  }
}

function replaceScalar(source, key, value) {
  const lines = String(source).split(/\r?\n/);
  let replacements = 0;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const output = lines.map((line) => {
    const match = line.match(new RegExp('^(\\s*)' + escapedKey + '\\s*:'));
    if (!match) return line;
    replacements += 1;
    return match[1] + key + ': ' + value;
  });

  if (replacements !== 1) {
    throw new Error(
      'expected exactly one YAML key named ' + key + ', found ' + replacements
    );
  }

  return output.join('\n');
}

function createLayout(options = {}) {
  const projectRoot = path.resolve(
    options.projectRoot ||
    options.project_root ||
    DEFAULT_PROJECT_ROOT
  );
  const configDir = path.join(projectRoot, 'config');
  const externalRoot = path.resolve(
    options.externalRoot ||
    options.external_root ||
    path.join(
      path.resolve(process.env.RUNNER_TEMP || os.tmpdir()),
      'floki-v2-ci'
    )
  );

  const dreamRoot = path.join(externalRoot, 'Floki-memory-bank', 'dreams');
  const mediaRoot = path.join(externalRoot, 'Floki-media');
  const textRoot = path.join(mediaRoot, 'text');
  const youtubeRoot = path.join(textRoot, 'youtube');
  const cookieFile = path.join(externalRoot, 'secrets', 'cookies.txt');

  return Object.freeze({
    projectRoot,
    configDir,
    externalRoot,
    chatTemplate: path.join(configDir, 'chat.config.yaml.temp'),
    gameTemplate: path.join(configDir, 'game.config.yaml.temp'),
    chatConfig: path.join(configDir, 'chat.config.yaml'),
    gameConfig: path.join(configDir, 'game.config.yaml'),
    dreamRoot,
    mediaRoot,
    textRoot,
    youtubeRoot,
    cookieFile
  });
}

function ensureExternalPaths(layout) {
  for (const directory of [
    layout.dreamRoot,
    layout.mediaRoot,
    layout.textRoot,
    layout.youtubeRoot,
    path.dirname(layout.cookieFile)
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(layout.cookieFile)) {
    fs.writeFileSync(layout.cookieFile, '', 'utf8');
  }
}

function prepareConfig(templateFile, outputFile, values) {
  requireFile(templateFile);
  let source = fs.readFileSync(templateFile, 'utf8');

  for (const [key, value] of Object.entries(values)) {
    source = replaceScalar(source, key, value);
  }

  if (source.includes('/absolute/path/')) {
    throw new Error(
      'public placeholder path remains in ' + path.basename(outputFile)
    );
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, source.replace(/\s*$/, '\n'), 'utf8');
}

function assertInsideExternalRoot(value, externalRoot, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(label + ' must be an absolute runner path');
  }

  const resolved = path.resolve(value);
  const root = path.resolve(externalRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(label + ' escaped the runner temp root');
  }
}

function validatePreparedConfig(
  filePath,
  expectedMode,
  includeCookie,
  externalRoot
) {
  const config = loadYamlFile(filePath);
  if (config.mode !== expectedMode) {
    throw new Error(path.basename(filePath) + ' mode mismatch');
  }

  const paths = config.paths || {};
  const required = [
    'dream_root',
    'media_root',
    'youtube_transcript_root'
  ];
  if (expectedMode === 'chat') required.push('text_root');
  if (includeCookie) required.push('youtube_cookies_file');

  for (const key of required) {
    assertInsideExternalRoot(
      paths[key],
      externalRoot,
      path.basename(filePath) + ' paths.' + key
    );
  }

  return config;
}

function prepareCiConfig(options = {}) {
  const layout = createLayout(options);
  const runningInCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const targetsLiveProject = layout.projectRoot === DEFAULT_PROJECT_ROOT;
  if (targetsLiveProject && !runningInCi && options.allow_live_project !== true) {
    throw new Error(
      'HOST_CONFIG_OVERWRITE_BLOCKED: CI fixture generation may not replace the live ignored config/chat.config.yaml outside CI; pass an isolated projectRoot'
    );
  }
  ensureExternalPaths(layout);

  prepareConfig(layout.chatTemplate, layout.chatConfig, {
    dream_root: layout.dreamRoot,
    media_root: layout.mediaRoot,
    text_root: layout.textRoot,
    youtube_transcript_root: layout.youtubeRoot,
    youtube_cookies_file: layout.cookieFile,
    // The HF training master is not present on CI runners; point it at a runner
    // path so the public placeholder is replaced (training preflight tests use
    // deterministic boundary doubles rather than the real checkpoint).
    hf_master_path: path.join(layout.externalRoot, 'Qwen3.5-4B')
  });

  prepareConfig(layout.gameTemplate, layout.gameConfig, {
    dream_root: layout.dreamRoot,
    media_root: layout.mediaRoot,
    youtube_transcript_root: layout.youtubeRoot
  });

  validatePreparedConfig(
    layout.chatConfig,
    'chat',
    true,
    layout.externalRoot
  );
  validatePreparedConfig(
    layout.gameConfig,
    'game',
    false,
    layout.externalRoot
  );

  const result = Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CI_CONFIG_PREPARED',

    project_root: layout.projectRoot,
    projectRoot: layout.projectRoot,

    external_root: layout.externalRoot,
    externalRoot: layout.externalRoot,
    runner_temp_root: layout.externalRoot,
    runnerTempRoot: layout.externalRoot,

    chat_config: layout.chatConfig,
    chatConfig: layout.chatConfig,
    chatConfigPath: layout.chatConfig,

    game_config: layout.gameConfig,
    gameConfig: layout.gameConfig,
    gameConfigPath: layout.gameConfig,

    dream_root: layout.dreamRoot,
    media_root: layout.mediaRoot,
    text_root: layout.textRoot,
    youtube_transcript_root: layout.youtubeRoot,
    youtube_cookies_file: layout.cookieFile,

    paths: Object.freeze({
      chat_config: layout.chatConfig,
      game_config: layout.gameConfig,
      chatConfig: layout.chatConfig,
      gameConfig: layout.gameConfig,
      dream_root: layout.dreamRoot,
      media_root: layout.mediaRoot,
      text_root: layout.textRoot,
      youtube_transcript_root: layout.youtubeRoot,
      youtube_cookies_file: layout.cookieFile
    }),

    private_host_paths_used: false,
    public_placeholder_paths_used: false
  });

  return result;
}

function main() {
  const result = prepareCiConfig();
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      'FLOKI_V2_CI_CONFIG_PREPARE_FAIL: ' +
      (error && error.message ? error.message : String(error))
    );
    process.exit(1);
  }
}

module.exports = {
  prepareCiConfig,
  createLayout,
  replaceScalar,
  prepareConfig,
  validatePreparedConfig
};
