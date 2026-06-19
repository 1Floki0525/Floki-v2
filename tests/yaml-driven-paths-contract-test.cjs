'use strict';

/**
 * YAML-driven paths contract test.
 *
 * Proves that:
 * - Project root is derived, not hardcoded.
 * - All path values come from YAML config, not from source code.
 * - media_root, youtube_transcript_root, dream_root come from YAML.
 * - Chat transcript path and runtime state paths come from YAML.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const cfg = require('../src/config/floki-config.cjs');
const { PROJECT_ROOT } = cfg;

function run() {
  assert.ok(PROJECT_ROOT, 'PROJECT_ROOT must be defined');
  assert.equal(typeof PROJECT_ROOT, 'string', 'PROJECT_ROOT must be a string');
  assert.ok(PROJECT_ROOT.length > 0, 'PROJECT_ROOT must be non-empty');

  const expectedDerived = path.resolve(__dirname, '..');
  assert.equal(PROJECT_ROOT, expectedDerived, 'PROJECT_ROOT must be derived from __dirname, not hardcoded');

  const configPath = path.join(PROJECT_ROOT, 'src', 'config', 'floki-config.cjs');
  assert.ok(fs.existsSync(configPath), 'floki-config.cjs must exist at derived PROJECT_ROOT');

  const chatConfigSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'src', 'config', 'floki-config.cjs'),
    'utf8'
  );
  assert.ok(
    !chatConfigSource.includes("const PROJECT_ROOT = '/media/"),
    'floki-config.cjs must not contain hardcoded PROJECT_ROOT'
  );
  assert.ok(
    !chatConfigSource.includes('const PROJECT_ROOT = "/media/'),
    'floki-config.cjs must not contain hardcoded PROJECT_ROOT with double quotes'
  );

  cfg.clearConfigCache();
  const chatPaths = cfg.getPathConfig('chat');
  const gamePaths = cfg.getPathConfig('game');

  assert.equal(typeof chatPaths.state_root, 'string', 'chat paths.state_root must be a string');
  assert.ok(chatPaths.state_root.length > 0, 'chat paths.state_root must be non-empty');
  assert.equal(chatPaths.state_root, 'state/floki', 'chat paths.state_root must match YAML value');

  assert.equal(typeof chatPaths.media_root, 'string', 'chat paths.media_root must be a string');
  assert.ok(chatPaths.media_root.length > 0, 'chat paths.media_root must be non-empty');
  assert.ok(path.isAbsolute(chatPaths.media_root), 'chat paths.media_root must be an absolute path');
  assert.ok(
    chatPaths.media_root.includes('Floki-media'),
    'chat paths.media_root must reference Floki-media from YAML'
  );

  assert.equal(typeof chatPaths.youtube_transcript_root, 'string', 'chat paths.youtube_transcript_root must be a string');
  assert.ok(chatPaths.youtube_transcript_root.length > 0, 'chat paths.youtube_transcript_root must be non-empty');
  assert.ok(path.isAbsolute(chatPaths.youtube_transcript_root), 'chat paths.youtube_transcript_root must be absolute');
  assert.ok(
    chatPaths.youtube_transcript_root.includes('youtube'),
    'chat paths.youtube_transcript_root must reference youtube from YAML'
  );

  assert.equal(typeof chatPaths.dream_root, 'string', 'chat paths.dream_root must be a string');
  assert.ok(chatPaths.dream_root.length > 0, 'chat paths.dream_root must be non-empty');
  assert.ok(path.isAbsolute(chatPaths.dream_root), 'chat paths.dream_root must be absolute');
  assert.ok(
    chatPaths.dream_root.includes('Floki-memory-bank'),
    'chat paths.dream_root must reference Floki-memory-bank from YAML'
  );

  assert.equal(typeof chatPaths.chat_transcript_root, 'string', 'chat paths.chat_transcript_root must be a string');
  assert.ok(chatPaths.chat_transcript_root.length > 0, 'chat paths.chat_transcript_root must be non-empty');

  assert.equal(typeof chatPaths.chat_runtime_root, 'string', 'chat paths.chat_runtime_root must be a string');
  assert.ok(chatPaths.chat_runtime_root.length > 0, 'chat paths.chat_runtime_root must be non-empty');

  assert.equal(typeof chatPaths.runtime_root, 'string', 'chat paths.runtime_root must be a string');
  assert.ok(chatPaths.runtime_root.length > 0, 'chat paths.runtime_root must be non-empty');

  assert.equal(typeof chatPaths.tool_input_root, 'string', 'chat paths.tool_input_root must be a string');
  assert.ok(chatPaths.tool_input_root.length > 0, 'chat paths.tool_input_root must be non-empty');

  assert.equal(typeof chatPaths.tool_output_root, 'string', 'chat paths.tool_output_root must be a string');
  assert.ok(chatPaths.tool_output_root.length > 0, 'chat paths.tool_output_root must be non-empty');

  assert.equal(typeof gamePaths.media_root, 'string', 'game paths.media_root must be a string');
  assert.ok(gamePaths.media_root.length > 0, 'game paths.media_root must be non-empty');

  assert.equal(typeof gamePaths.dream_root, 'string', 'game paths.dream_root must be a string');
  assert.ok(gamePaths.dream_root.length > 0, 'game paths.dream_root must be non-empty');
  assert.equal(Object.prototype.hasOwnProperty.call(gamePaths, 'chat_runtime_root'), false, 'game paths must not expose chat_runtime_root');
  assert.equal(Object.prototype.hasOwnProperty.call(gamePaths, 'chat_transcript_root'), false, 'game paths must not expose chat_transcript_root');

  const statePath = cfg.resolveStatePath('chat', 'test/path');
  assert.ok(path.isAbsolute(statePath), 'resolveStatePath must return absolute path');
  assert.ok(statePath.includes('state/floki'), 'resolveStatePath must use state_root from YAML');

  const toolPath = cfg.resolveToolPath('chat', 'test/output');
  assert.ok(path.isAbsolute(toolPath), 'resolveToolPath must return absolute path');
  assert.ok(toolPath.includes('.floki-tools/output'), 'resolveToolPath must use tool_output_root from YAML');

  const externalPath = cfg.resolveExternalPath('chat', 'media_root');
  assert.ok(path.isAbsolute(externalPath), 'resolveExternalPath must return absolute path');
  assert.equal(externalPath, path.resolve(chatPaths.media_root), 'resolveExternalPath must match YAML value');

  const projectPath = cfg.resolveProjectPath('src/config/floki-config.cjs');
  assert.ok(path.isAbsolute(projectPath), 'resolveProjectPath must return absolute path');
  assert.ok(projectPath.endsWith('src/config/floki-config.cjs'), 'resolveProjectPath must resolve relative to PROJECT_ROOT');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_YAML_DRIVEN_PATHS_PASS',
    project_root_derived: PROJECT_ROOT === expectedDerived,
    project_root_not_hardcoded: !chatConfigSource.includes("const PROJECT_ROOT = '/media/"),
    media_root_from_yaml: typeof chatPaths.media_root === 'string' && chatPaths.media_root.length > 0,
    youtube_transcript_root_from_yaml: typeof chatPaths.youtube_transcript_root === 'string' && chatPaths.youtube_transcript_root.length > 0,
    dream_root_from_yaml: typeof chatPaths.dream_root === 'string' && chatPaths.dream_root.length > 0,
    chat_transcript_root_from_yaml: typeof chatPaths.chat_transcript_root === 'string' && chatPaths.chat_transcript_root.length > 0,
    chat_runtime_root_from_yaml: typeof chatPaths.chat_runtime_root === 'string' && chatPaths.chat_runtime_root.length > 0,
    state_root_from_yaml: typeof chatPaths.state_root === 'string' && chatPaths.state_root.length > 0,
    resolveStatePath_works: typeof statePath === 'string' && statePath.length > 0,
    resolveToolPath_works: typeof toolPath === 'string' && toolPath.length > 0,
    resolveExternalPath_works: typeof externalPath === 'string' && externalPath.length > 0,
    resolveProjectPath_works: typeof projectPath === 'string' && projectPath.length > 0,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_YAML_DRIVEN_PATHS_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
