'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function parseJsonFromStdout(stdout) {
  const first = stdout.indexOf('{');
  const last = stdout.lastIndexOf('}');
  if (first < 0 || last <= first) {
    throw new Error('No JSON object found in chat-smoke stdout: ' + stdout.slice(0, 500));
  }
  return JSON.parse(stdout.slice(first, last + 1));
}

function run() {
  const result = spawnSync(process.execPath, ['src/chat/floki-chat.cjs', '--smoke'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240000
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    console.error('--- chat-smoke stdout ---');
    console.error(result.stdout || '');
    console.error('--- chat-smoke stderr ---');
    console.error(result.stderr || '');
    throw new Error('chat-smoke exited with status ' + result.status);
  }

  const json = parseJsonFromStdout(result.stdout);

  assert.equal(json.ok, true);
  assert.equal(json.marker, 'FLOKI_V2_CHAT_BROCA_SHELL_PASS');
  assert.equal(json.cognition_enabled_now, true);
  assert.equal(json.reflective_emotion_enabled_now, true);
  assert.equal(json.broca_enabled_now, true);
  assert.equal(json.minecraft_enabled_now, false);
  assert.ok(typeof json.cognition.model === 'string' && json.cognition.model.length > 0, 'cognition model from YAML must be non-empty');
  assert.equal(json.cognition.raw_private_reasoning_stored, false);
  assert.equal(typeof json.speech.text, 'string');
  assert.ok(json.speech.text.length > 0);
  assert.equal(json.speech.text.includes('<think>'), false);
  assert.equal(json.speech.text.toLowerCase().includes('i am in minecraft'), false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_BROCA_SHELL_PASS',
    cognition_output_id: json.cognition_output_id,
    speech_output_id: json.speech_output_id,
    model: json.cognition.model,
    speech_text: json.speech.text,
    cognition_enabled_now: json.cognition_enabled_now,
    reflective_emotion_enabled_now: json.reflective_emotion_enabled_now,
    broca_enabled_now: json.broca_enabled_now,
    minecraft_enabled_now: json.minecraft_enabled_now
  }, null, 2));
}

run();
