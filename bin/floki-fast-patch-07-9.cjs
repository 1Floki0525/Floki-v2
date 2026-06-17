'use strict';

/**
 * Floki-v2 fast patch 07.9
 *
 * Adds stable launcher modes:
 * - bin/floki-start.sh chat
 * - bin/floki-start.sh game
 *
 * Current game mode is an honest guarded placeholder.
 * It must not fake Minecraft/body/eyes until those modules exist.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';

function projectPath() {
  return path.join.apply(path, [ROOT].concat(Array.from(arguments)));
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function backup(filePath) {
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, filePath + '.bak.' + timestamp());
  }
}

function writeFile(relativePath, content, mode) {
  const fullPath = projectPath(relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  backup(fullPath);
  fs.writeFileSync(fullPath, content);

  if (mode) {
    fs.chmodSync(fullPath, mode);
  }

  console.log('patched ' + relativePath);
}

function patchStartScript() {
  const content = [
    '#!/usr/bin/env bash',
    '',
    'PROJECT_DIR="/media/binary-god/1tb-ssd/Floki-v2"',
    'COMMAND="$1"',
    '',
    'fail() {',
    '  echo "FLOKI_V2_START_FAIL: $1" >&2',
    '  exit 1',
    '}',
    '',
    'if [ ! -d "$PROJECT_DIR" ]; then',
    '  fail "Project directory not found: $PROJECT_DIR"',
    'fi',
    '',
    'cd "$PROJECT_DIR" || fail "Could not cd into $PROJECT_DIR"',
    '',
    'if [ -s "$HOME/.nvm/nvm.sh" ]; then',
    '  export NVM_DIR="$HOME/.nvm"',
    '  . "$HOME/.nvm/nvm.sh"',
    '',
    '  if [ -f "$PROJECT_DIR/.nvmrc" ]; then',
    '    nvm use >/dev/null 2>&1',
    '  else',
    '    nvm use 24 >/dev/null 2>&1',
    '  fi',
    'fi',
    '',
    'if ! command -v node >/dev/null 2>&1; then',
    '  fail "node was not found on PATH"',
    'fi',
    '',
    'case "$COMMAND" in',
    '  chat)',
    '    node src/chat/floki-chat.cjs',
    '    exit "$?"',
    '    ;;',
    '',
    '  chat-smoke)',
    '    node src/chat/floki-chat.cjs --smoke',
    '    exit "$?"',
    '    ;;',
    '',
    '  game)',
    '    node src/game/floki-game.cjs',
    '    exit "$?"',
    '    ;;',
    '',
    '  game-smoke)',
    '    node src/game/floki-game.cjs --smoke',
    '    exit "$?"',
    '    ;;',
    '',
    '  status)',
    '    node src/game/floki-game.cjs --status',
    '    exit "$?"',
    '    ;;',
    '',
    '  "")',
    '    ;;',
    '',
    '  *)',
    '    echo "FLOKI_V2_START_UNKNOWN_COMMAND: $COMMAND" >&2',
    '    ;;',
    'esac',
    '',
    'echo "Floki-v2 start commands:"',
    'echo "  bin/floki-start.sh chat        open terminal chat mode"',
    'echo "  bin/floki-start.sh chat-smoke  run terminal chat smoke proof"',
    'echo "  bin/floki-start.sh game        start Minecraft/in-game mode when wired"',
    'echo "  bin/floki-start.sh game-smoke  prove game entrypoint is guarded until wired"',
    'echo "  bin/floki-start.sh status      show current game-mode readiness"',
    'echo ""',
    'echo "Current stage:"',
    'echo "  chat mode works as affect/personality/identity shell"',
    'echo "  game mode exists but is guarded until Minecraft body/eyes/bridge are wired"',
    'exit 0',
    ''
  ].join('\n');

  writeFile('bin/floki-start.sh', content, 0o755);
}

function patchGameEntrypoint() {
  const content = [
    "'use strict';",
    '',
    '/**',
    ' * Floki-v2 game entrypoint.',
    ' *',
    ' * This is the stable launcher target for future Minecraft mode:',
    ' *',
    ' *   bin/floki-start.sh game',
    ' *',
    ' * Current stage is guarded. It must not fake:',
    ' * - Minecraft bridge',
    ' * - body control',
    ' * - in-game eyes',
    ' * - PaperMC connection',
    ' */',
    '',
    "const models = require('../config/model-config.cjs');",
    "const runtime = require('../config/runtime-config.cjs');",
    '',
    'function makeStatus() {',
    '  const modelConfig = models.getModelConfig ? models.getModelConfig() : models.MODEL_CONFIG || models;',
    '',
    '  if (typeof models.validateModelConfig === "function") {',
    '    models.validateModelConfig(modelConfig);',
    '  }',
    '',
    '  return {',
    '    ok: true,',
    "    marker: 'FLOKI_V2_GAME_MODE_GUARDED',",
    "    command: 'floki-start.sh game',",
    "    mode: 'game',",
    "    stage: 'not_wired_yet',",
    '    cognition_model: modelConfig.cognition.model,',
    '    vision_model: modelConfig.vision.model,',
    '    cognition_enabled_now: modelConfig.cognition.enabled_in_current_stage,',
    '    vision_enabled_now: modelConfig.vision.enabled_in_current_stage,',
    '    minecraft_enabled_now: false,',
    '    papermc_enabled_now: false,',
    '    bridge_enabled_now: false,',
    '    body_movement_enabled_now: false,',
    '    in_game_eyes_enabled_now: false,',
    '    allowed_now: false,',
    "    reason: 'Minecraft game mode is reserved for the future body/eyes/bridge stage. It exists now so the launcher contract is stable.',",
    '    future_requirements: [',
    "      'PaperMC lifecycle scripts',",
    "      'Minecraft client/bridge process',",
    "      'in-game vision source',",
    "      'body action router',",
    "      'motor safety guard',",
    "      'live proof tests'",
    '    ]',
    '  };',
    '}',
    '',
    'function runSmoke() {',
    '  const status = makeStatus();',
    '  console.log(JSON.stringify({',
    '    ok: true,',
    "    marker: 'FLOKI_V2_GAME_ENTRYPOINT_CONTRACT_PASS',",
    '    game_command_exists: true,',
    '    game_mode_guarded_now: true,',
    '    minecraft_enabled_now: status.minecraft_enabled_now,',
    '    body_movement_enabled_now: status.body_movement_enabled_now,',
    '    in_game_eyes_enabled_now: status.in_game_eyes_enabled_now',
    '  }, null, 2));',
    '}',
    '',
    'function runGame() {',
    '  const status = makeStatus();',
    '  console.log(JSON.stringify(status, null, 2));',
    '  process.exit(2);',
    '}',
    '',
    'function main() {',
    "  if (process.argv.includes('--smoke')) {",
    '    runSmoke();',
    '    return;',
    '  }',
    '',
    "  if (process.argv.includes('--status')) {",
    '    console.log(JSON.stringify(makeStatus(), null, 2));',
    '    return;',
    '  }',
    '',
    '  runGame();',
    '}',
    '',
    'main();',
    ''
  ].join('\n');

  writeFile('src/game/floki-game.cjs', content, 0o644);
}

function patchPackage() {
  const packagePath = projectPath('package.json');

  if (!fs.existsSync(packagePath)) {
    return { skipped: true };
  }

  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  backup(packagePath);

  pkg.version = '0.7.9';
  pkg.scripts = pkg.scripts || {};
  pkg.scripts['proof:game-entrypoint'] = 'bash bin/floki-start.sh game-smoke';

  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

  return {
    skipped: false,
    version: pkg.version
  };
}

function patchDocs() {
  const content = [
    '# Floki-v2 Launcher Modes',
    '',
    'Floki-v2 has two stable runtime entrypoints.',
    '',
    '## Terminal chat mode',
    '',
    '```bash',
    'bin/floki-start.sh chat',
    '```',
    '',
    'Purpose:',
    '',
    '- terminal/local conversation',
    '- memory/personality/identity development',
    '- qwen cognition once Batch 08 is wired',
    '- future USB webcam/mic offline senses',
    '',
    '## Minecraft game mode',
    '',
    '```bash',
    'bin/floki-start.sh game',
    '```',
    '',
    'Purpose:',
    '',
    '- future PaperMC/Minecraft embodiment',
    '- in-game eyes',
    '- body/motor control',
    '- Minecraft action safety',
    '',
    'Current status: guarded placeholder.',
    '',
    '`game` exists now so the command contract is stable, but it must not start fake Minecraft behavior before the body/eyes/bridge stage is implemented and live-proofed.',
    '',
    '## Smoke proofs',
    '',
    '```bash',
    'npm run proof:chat-shell',
    'npm run proof:game-entrypoint',
    '```',
    ''
  ].join('\n');

  writeFile('docs/LAUNCHER_MODES.md', content, 0o644);
}

function main() {
  if (process.cwd() !== ROOT) {
    throw new Error('Run this from ' + ROOT);
  }

  patchStartScript();
  patchGameEntrypoint();
  const pkg = patchPackage();
  patchDocs();

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FAST_PATCH_07_9_PASS',
    commands: {
      chat: 'bin/floki-start.sh chat',
      game: 'bin/floki-start.sh game'
    },
    game_mode_guarded_now: true,
    package: pkg
  }, null, 2));
}

main();
