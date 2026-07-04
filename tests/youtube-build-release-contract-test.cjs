'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const config = require('../src/config/floki-config.cjs');
const { loadYamlFile } = require('../src/config/yaml-lite.cjs');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );

  config.clearConfigCache();
  const chatPaths = config.getPathConfig('chat');
  const gamePaths = config.getPathConfig('game');
  const cookiePath = chatPaths.youtube_cookies_file;

  assert.equal(typeof cookiePath, 'string');
  assert.equal(path.isAbsolute(cookiePath), true, 'paths.youtube_cookies_file must be absolute');
  assert.equal(Object.prototype.hasOwnProperty.call(gamePaths, 'youtube_cookies_file'), false);

  const chatYaml = read('config/chat.config.yaml');
  assert.equal((chatYaml.match(/^  youtube_cookies_file:/gm) || []).length, 1);
  assert.equal(chatYaml.includes('```'), false, 'working YAML must not contain Markdown fences');

  const chatTemplate = read('config/chat.config.yaml.temp');
  const gameTemplate = read('config/game.config.yaml.temp');
  assert.equal(chatTemplate.startsWith('schema_version:'), true, 'chat template must start with map-style YAML');
  assert.equal(gameTemplate.startsWith('schema_version:'), true, 'game template must start with map-style YAML');
  assert.doesNotMatch(chatTemplate, /^#/m, 'chat template must not contain top-level comments rejected by yaml-lite');
  assert.doesNotMatch(gameTemplate, /^#/m, 'game template must not contain top-level comments rejected by yaml-lite');
  const parsedChatTemplate = loadYamlFile(path.join(ROOT, 'config/chat.config.yaml.temp'));
  const templateCookiePath = parsedChatTemplate.paths.youtube_cookies_file;
  assert.equal(typeof templateCookiePath, 'string');
  assert.equal(path.isAbsolute(templateCookiePath), true, 'public cookie placeholder must be absolute');
  assert.equal(templateCookiePath.includes('/media/binary-god/'), false);
  assert.equal(templateCookiePath.includes('/mnt/firstlight-cold-storage/'), false);
  assert.equal(gameTemplate.includes('youtube_cookies_file:'), false, 'game config must not own the YouTube cookie path');
  assert.equal(chatTemplate.includes('/media/binary-god/'), false);
  assert.equal(chatTemplate.includes('/mnt/firstlight-cold-storage/'), false);
  assert.equal(gameTemplate.includes('/media/binary-god/'), false);
  assert.equal(gameTemplate.includes('/mnt/firstlight-cold-storage/'), false);

  const scraper = read('bin/scrape-youtube-public-transcripts.sh');
  assert.equal(scraper.includes("getPathConfig('chat')"), true);
  assert.equal(scraper.includes('youtube_cookies_file'), true);
  assert.equal(scraper.includes('docs/cookies.txt'), false);
  assert.equal(scraper.includes('cookies.runtime.txt'), false);
  assert.equal(scraper.includes('FLOKI_YT_COOKIES'), false);
  assert.equal((scraper.match(/--cookies "\$COOKIES_FILE"/g) || []).length >= 2, true);
  assert.equal(scraper.includes('--skip-download'), true);
  assert.equal(scraper.includes('--write-subs'), true);
  assert.equal(scraper.includes('--write-auto-subs'), true);
  assert.equal(scraper.includes("availability = 'public' & !is_live"), true);
  assert.doesNotMatch(scraper, /^\s*cp\s+.*COOKIE/im);
  assert.equal(scraper.includes(cookiePath), false, 'scraper must not contain the configured cookie pathname');

  const build = read('bin/floki-build.sh');
  assert.equal((fs.statSync(path.join(ROOT, 'bin/floki-build.sh')).mode & 0o111) !== 0, true);
  assert.equal(build.includes('bin/floki-node24-run.sh'), true);
  assert.equal(build.includes('run build'), true);
  assert.equal(build.includes('run test:integration'), true);
  assert.equal(build.includes('floki-' + 'start.sh'), false);
  assert.doesNotMatch(build, /^\s*npm\s+(?:ci|install)\b/m);

  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.build, 'bash bin/floki-node24-run.sh bash bin/floki-build.sh');
  assert.equal(fs.existsSync(path.join(ROOT, 'package-lock.json')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'apps/floki-neural-interface/package-lock.json')), true);

  const ignore = read('.gitignore');
  assert.equal(ignore.includes('config/chat.config.yaml'), true);
  assert.equal(ignore.includes('config/game.config.yaml'), true);
  assert.equal(ignore.includes('**/cookies.txt'), true);

  const trackedResult = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(trackedResult.status, 0, trackedResult.stderr || 'git ls-files failed');
  const tracked = trackedResult.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(tracked.includes('config/chat.config.yaml'), false);
  assert.equal(tracked.includes('config/game.config.yaml'), false);
  assert.equal(tracked.includes('config/chat.config.yaml.temp'), true);
  assert.equal(tracked.includes('config/game.config.yaml.temp'), true);
  assert.deepEqual(tracked.filter((name) => /(^|\/)cookies\.txt$/.test(name)), []);

  const sensitivePathResult = spawnSync('git', [
    'grep',
    '--cached',
    '-n',
    '-E',
    '(/media/binary-god/|/mnt/firstlight-cold-storage/|/1tb-ssd/secretes/cookies\\.txt)',
    '--',
    'config/chat.config.yaml.temp',
    'config/game.config.yaml.temp',
    'bin/scrape-youtube-public-transcripts.sh'
  ], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(
    sensitivePathResult.status,
    1,
    sensitivePathResult.stdout || sensitivePathResult.stderr || 'private paths must not exist in public release files'
  );

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_YOUTUBE_BUILD_RELEASE_CONTRACT_PASS',
    cookie_path_from_typed_yaml_config: true,
    private_configs_untracked: true,
    public_templates_tracked: true,
    cookie_files_untracked: true,
    build_command_present: true,
    media_download_disabled: true,
    live_runtime_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_YOUTUBE_BUILD_RELEASE_CONTRACT_FAIL',
    error: error.message,
    live_runtime_started: false
  }, null, 2));
  process.exit(1);
}
