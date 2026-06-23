'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareCiConfig } = require('../bin/floki-prepare-ci-config.cjs');
const { loadYamlFile } = require('../src/config/yaml-lite.cjs');

const ROOT = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-ci-config-'));
const fixture = path.join(temp, 'project');
const configDir = path.join(fixture, 'config');
const external = path.join(temp, 'runner-temp', 'floki-v2-external');
fs.mkdirSync(configDir, { recursive: true });
for (const name of ['chat.config.yaml.temp', 'game.config.yaml.temp']) {
  fs.copyFileSync(path.join(ROOT, 'config', name), path.join(configDir, name));
}
const chatTemplateBefore = fs.readFileSync(path.join(configDir, 'chat.config.yaml.temp'), 'utf8');
const result = prepareCiConfig({ projectRoot: fixture, externalRoot: external });
const chat = loadYamlFile(path.join(configDir, 'chat.config.yaml'));
const game = loadYamlFile(path.join(configDir, 'game.config.yaml'));
assert.equal(result.ok, true);
assert.equal(path.isAbsolute(chat.paths.dream_root), true);
assert.equal(chat.paths.dream_root.startsWith(external), true);
assert.equal(chat.paths.media_root.startsWith(external), true);
assert.equal(chat.paths.youtube_transcript_root.startsWith(external), true);
assert.equal(chat.paths.youtube_cookies_file.startsWith(external), true);
assert.equal(game.paths.dream_root.startsWith(external), true);
assert.equal(fs.existsSync(chat.paths.youtube_cookies_file), true);
assert.equal(fs.readFileSync(path.join(configDir, 'chat.config.yaml.temp'), 'utf8'), chatTemplateBefore);
assert.equal(fs.readFileSync(path.join(ROOT, '.github/workflows/node.js.yml'), 'utf8').includes('node bin/floki-prepare-ci-config.cjs'), true);
fs.rmSync(temp, { recursive: true, force: true });
console.log('FLOKI_V2_CI_PUBLIC_TEMPLATE_PORTABLE_PASS');
