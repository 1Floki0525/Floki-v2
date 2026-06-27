#!/usr/bin/env node
'use strict';

// Guarded, non-destructive migration for the PRIVATE chat config.
//
// After checking out a branch that adds new self_improvement YAML keys, the
// private host file config/chat.config.yaml must gain those keys without losing
// any existing host values. This command:
//   * operates ONLY on config/chat.config.yaml (never game config),
//   * preserves every existing value (adds only missing keys, using the public
//     template's default for each),
//   * refuses to run on malformed YAML,
//   * validates the result through the real configuration loader,
//   * is idempotent and supports a non-writing --check mode.
//
// Usage:
//   node bin/floki-migrate-chat-config.cjs --check   # report only
//   node bin/floki-migrate-chat-config.cjs           # apply

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const { parseYaml } = require(path.join(PROJECT_ROOT, 'src/config/yaml-lite.cjs'));

const DEFAULT_TEMPLATE_FILE = path.join(PROJECT_ROOT, 'config', 'chat.config.yaml.temp');
const DEFAULT_PRIVATE_FILE = path.join(PROJECT_ROOT, 'config', 'chat.config.yaml');
const GAME_FILE_NAMES = ['game.config.yaml', 'game.config.yaml.temp'];
const BLOCK_KEY = 'self_improvement:';

class MigrationError extends Error {}

// Returns {start, end} line indices (inclusive start, exclusive end) of a
// top-level block.
function blockSpan(lines, header) {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === header || lines[i].startsWith(header + ' ')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[^\s#]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function blockKeys(lines, span) {
  const keys = new Map(); // key -> raw line
  for (let i = span.start + 1; i < span.end; i += 1) {
    const m = lines[i].match(/^ {2}([A-Za-z_][\w]*)\s*:/);
    if (m) keys.set(m[1], lines[i]);
  }
  return keys;
}

function migrateChatConfig(options = {}) {
  const templateFile = options.templateFile || DEFAULT_TEMPLATE_FILE;
  const privateFile = options.privateFile || DEFAULT_PRIVATE_FILE;
  const checkOnly = options.checkOnly === true;
  const validateLoader = options.validateLoader !== false && privateFile === DEFAULT_PRIVATE_FILE;

  // Never operate on game config.
  if (GAME_FILE_NAMES.includes(path.basename(privateFile))) {
    throw new MigrationError('refusing to migrate game configuration');
  }
  if (!fs.existsSync(templateFile)) throw new MigrationError('public template missing: ' + templateFile);
  if (!fs.existsSync(privateFile)) {
    throw new MigrationError('private config missing: ' + privateFile + ' (generate it from the template before migrating)');
  }

  const templateText = fs.readFileSync(templateFile, 'utf8');
  const privateText = fs.readFileSync(privateFile, 'utf8');

  // Refuse malformed YAML on either side.
  let privateParsed;
  try {
    parseYaml(templateText);
  } catch (err) {
    throw new MigrationError('public template is not valid YAML: ' + err.message);
  }
  try {
    privateParsed = parseYaml(privateText);
  } catch (err) {
    throw new MigrationError('private config is not valid YAML (refusing to migrate): ' + err.message);
  }
  if (privateParsed.mode !== 'chat') throw new MigrationError('private config mode is not "chat"');
  if (!privateParsed.self_improvement) throw new MigrationError('private config has no self_improvement block');

  const templateLines = templateText.split('\n');
  const privateLines = privateText.split('\n');
  const templateSpan = blockSpan(templateLines, BLOCK_KEY);
  const privateSpan = blockSpan(privateLines, BLOCK_KEY);
  if (!templateSpan) throw new MigrationError('template has no self_improvement block');
  if (!privateSpan) throw new MigrationError('private config has no self_improvement block');

  const templateKeys = blockKeys(templateLines, templateSpan);
  const privateKeys = blockKeys(privateLines, privateSpan);

  const missing = [];
  for (const [key, rawLine] of templateKeys) {
    if (!privateKeys.has(key)) missing.push({ key, rawLine });
  }

  if (missing.length === 0) {
    return { marker: 'FLOKI_V2_CHAT_CONFIG_MIGRATE_OK', changed: false, added_keys: [] };
  }
  if (checkOnly) {
    return { marker: 'FLOKI_V2_CHAT_CONFIG_MIGRATE_CHECK', changed: false, would_add_keys: missing.map((m) => m.key) };
  }

  // Insert missing template lines just before the end of the private block,
  // preserving all existing lines/values exactly.
  const insertAt = privateSpan.end;
  const additions = missing.map((m) => m.rawLine);
  const newText = [
    ...privateLines.slice(0, insertAt),
    ...additions,
    ...privateLines.slice(insertAt)
  ].join('\n').replace(/\s*$/, '\n');

  // Validate the candidate before writing.
  let candidateParsed;
  try {
    candidateParsed = parseYaml(newText);
  } catch (err) {
    throw new MigrationError('migration would produce invalid YAML (aborted, nothing written): ' + err.message);
  }
  for (const [key] of templateKeys) {
    if (!(key in candidateParsed.self_improvement)) {
      throw new MigrationError('post-migration key still missing: ' + key + ' (aborted, nothing written)');
    }
  }

  // Atomic write.
  const tmp = privateFile + '.migrate.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, newText, 'utf8');
  fs.renameSync(tmp, privateFile);

  let validatedThroughLoader = false;
  if (validateLoader) {
    try {
      execFileSync(
        process.execPath,
        ['-e', "const c=require('./src/config/floki-config.cjs');c.getSelfImprovementConfig('chat');process.stdout.write('LOADER_OK');"],
        { cwd: PROJECT_ROOT, encoding: 'utf8' }
      );
      validatedThroughLoader = true;
    } catch (err) {
      throw new MigrationError('migrated config failed the real loader: ' + (err.stderr || err.message));
    }
  }

  return {
    marker: 'FLOKI_V2_CHAT_CONFIG_MIGRATE_OK',
    changed: true,
    added_keys: missing.map((m) => m.key),
    validated_through_loader: validatedThroughLoader
  };
}

function main() {
  try {
    const result = migrateChatConfig({ checkOnly: process.argv.includes('--check') });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof MigrationError) {
      console.error('FLOKI_V2_CHAT_CONFIG_MIGRATE_FAIL: ' + err.message);
      process.exit(1);
    }
    throw err;
  }
}

if (require.main === module) {
  main();
}

module.exports = { migrateChatConfig, MigrationError, blockSpan, blockKeys };
