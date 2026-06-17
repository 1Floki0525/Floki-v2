'use strict';

/**
 * Floki-v2 Batch 08.2
 *
 * Fixes chat-shell telemetry after qwen cognition wiring.
 *
 * Problem:
 * - qwen cognition proof passes
 * - chat smoke still reports cognition_enabled_now:false
 *
 * Fix:
 * - chat smoke exposes cognitionOutput
 * - proof:chat-shell parses chat smoke JSON and asserts qwen cognition is active
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

function patchChatSmoke() {
  const chatPath = projectPath('src/chat/floki-chat.cjs');

  if (!fs.existsSync(chatPath)) {
    throw new Error('src/chat/floki-chat.cjs not found');
  }

  let content = fs.readFileSync(chatPath, 'utf8');
  backup(chatPath);

  const replacement = [
    'async function runSmoke() {',
    "  const runtime = createRuntime();",
    "  const result = await handleUserText(runtime, 'Smoke test: Floki should remember, learn, and form hope before Minecraft embodiment.');",
    '',
    '  const cognitionOutput = result.cognitionOutput || null;',
    "  const cognitionEnabled = cognitionOutput && cognitionOutput.type === 'model_response_summary';",
    '  const cognitionPayload = cognitionEnabled ? cognitionOutput.payload.cognition : null;',
    '',
    '  console.log(JSON.stringify({',
    '    ok: true,',
    "    marker: 'FLOKI_V2_CHAT_SHELL_PASS',",
    '    session_id: runtime.session_id,',
    '    event_id: result.event.id,',
    '    memory_id: result.memoryOutput.payload.record.id,',
    '    personality_output_id: result.personalityOutput.id,',
    '    identity_output_id: result.identityOutput.id,',
    '    cognition_output_id: cognitionEnabled ? cognitionOutput.id : null,',
    '    salience: {',
    '      urgency: result.salienceOutput.payload.salience.urgency,',
    '      attention_priority: result.salienceOutput.payload.salience.attention_priority,',
    '      memory_importance_hint: result.salienceOutput.payload.salience.memory_importance_hint',
    '    },',
    '    affect: result.affectSummary,',
    '    cognition: cognitionEnabled ? {',
    '      model: cognitionOutput.payload.model,',
    '      safe_thought_summary: cognitionPayload.safe_thought_summary,',
    '      felt_interpretation: cognitionPayload.felt_interpretation,',
    '      response_intent_for_broca: cognitionPayload.response_intent_for_broca,',
    '      normalized_model_json: cognitionOutput.payload.normalized_model_json,',
    '      raw_private_reasoning_stored: cognitionOutput.payload.raw_private_reasoning_stored',
    '    } : {',
    "      error: cognitionOutput && cognitionOutput.payload && cognitionOutput.payload.failure ? cognitionOutput.payload.failure.message : 'cognition output missing'",
    '    },',
    '    broca_enabled_now: false,',
    '    affect_scaffold_enabled_now: true,',
    '    reflective_emotion_enabled_now: cognitionEnabled,',
    '    cognition_enabled_now: cognitionEnabled,',
    '    minecraft_enabled_now: false',
    '  }, null, 2));',
    '}',
    ''
  ].join('\n');

  const regex = /async function runSmoke\(\) \{[\s\S]*?\n\}\n\nfunction main\(\)/m;

  if (!regex.test(content)) {
    throw new Error('Could not find async runSmoke() block followed by function main()');
  }

  content = content.replace(regex, replacement + '\nfunction main()');

  fs.writeFileSync(chatPath, content);
  console.log('patched src/chat/floki-chat.cjs');
}

function patchChatProofTest() {
  const content = [
    "'use strict';",
    '',
    "const assert = require('node:assert/strict');",
    "const { spawnSync } = require('node:child_process');",
    '',
    "function parseJsonFromStdout(stdout) {",
    "  const first = stdout.indexOf('{');",
    "  const last = stdout.lastIndexOf('}');",
    '',
    "  if (first < 0 || last <= first) {",
    "    throw new Error('No JSON object found in chat-smoke stdout: ' + stdout.slice(0, 500));",
    "  }",
    '',
    "  return JSON.parse(stdout.slice(first, last + 1));",
    "}",
    '',
    "function run() {",
    "  const result = spawnSync('bash', ['bin/floki-start.sh', 'chat-smoke'], {",
    "    cwd: '/media/binary-god/1tb-ssd/Floki-v2',",
    "    encoding: 'utf8',",
    "    timeout: 180000",
    "  });",
    '',
    "  if (result.error) {",
    "    throw result.error;",
    "  }",
    '',
    "  if (result.status !== 0) {",
    "    console.error(result.stdout);",
    "    console.error(result.stderr);",
    "    throw new Error('chat-smoke exited with status ' + result.status);",
    "  }",
    '',
    "  const json = parseJsonFromStdout(result.stdout);",
    '',
    "  assert.equal(json.ok, true);",
    "  assert.equal(json.marker, 'FLOKI_V2_CHAT_SHELL_PASS');",
    "  assert.equal(json.cognition_enabled_now, true);",
    "  assert.equal(json.reflective_emotion_enabled_now, true);",
    "  assert.equal(json.broca_enabled_now, false);",
    "  assert.equal(json.minecraft_enabled_now, false);",
    "  assert.equal(json.cognition.model, 'qwen3.5:9b');",
    "  assert.equal(json.cognition.raw_private_reasoning_stored, false);",
    "  assert.equal(typeof json.cognition.safe_thought_summary, 'string');",
    "  assert.ok(json.cognition.safe_thought_summary.length > 0);",
    '',
    "  console.log(JSON.stringify({",
    "    ok: true,",
    "    marker: 'FLOKI_V2_CHAT_QWEN_COGNITION_PASS',",
    "    chat_marker: json.marker,",
    "    cognition_output_id: json.cognition_output_id,",
    "    model: json.cognition.model,",
    "    safe_thought_summary: json.cognition.safe_thought_summary,",
    "    cognition_enabled_now: json.cognition_enabled_now,",
    "    reflective_emotion_enabled_now: json.reflective_emotion_enabled_now,",
    "    broca_enabled_now: json.broca_enabled_now,",
    "    minecraft_enabled_now: json.minecraft_enabled_now",
    "  }, null, 2));",
    "}",
    '',
    "run();",
    ''
  ].join('\n');

  writeFile('tests/chat-cognition-shell-contract-test.cjs', content, 0o644);
}

function patchPackage() {
  const packagePath = projectPath('package.json');

  if (!fs.existsSync(packagePath)) {
    throw new Error('package.json not found');
  }

  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  backup(packagePath);

  pkg.version = '0.8.2';
  pkg.scripts = pkg.scripts || {};
  pkg.scripts['proof:chat-smoke-raw'] = 'bash bin/floki-start.sh chat-smoke';
  pkg.scripts['proof:chat-shell'] = 'node tests/chat-cognition-shell-contract-test.cjs';

  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

  return {
    version: pkg.version
  };
}

function main() {
  if (process.cwd() !== ROOT) {
    throw new Error('Run this from ' + ROOT);
  }

  patchChatSmoke();
  patchChatProofTest();
  const pkg = patchPackage();

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FAST_PATCH_08_2_PASS',
    package: pkg,
    chat_shell_now_proves_qwen_cognition: true
  }, null, 2));
}

main();
