'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath } = require('../src/util/fs-safe.cjs');
const { appendChatTranscriptTurn, appendPrivateThoughtRecord, readChatTranscriptTail, readPrivateThoughtTail, getTranscriptPaths } = require('../src/chat/chat-transcript.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';

function run() {
  const transcriptDir = statePath('test/live-chat-interface/transcript-' + Date.now());
  appendChatTranscriptTurn({ role: 'user', text: 'Hey Floki, how are you doing today?', input_modality: 'spoken', output_modality: 'none', spoken_aloud: false, source: 'spoken_reply_once' }, { transcript_dir: transcriptDir, now: '2026-06-18T16:00:00.000Z' });
  appendChatTranscriptTurn({ role: 'floki', text: 'I am here, listening, and I feel steady today.', input_modality: 'spoken', output_modality: 'spoken', spoken_aloud: true, source: 'spoken_reply_once' }, { transcript_dir: transcriptDir, now: '2026-06-18T16:00:01.000Z' });
  appendPrivateThoughtRecord({ text: 'I noticed trust and warmth in the interaction.', source: 'contract_test' }, { transcript_dir: transcriptDir, now: '2026-06-18T16:00:02.000Z' });
  assert.throws(() => appendChatTranscriptTurn({ role: 'floki', text: 'safe_thought_summary: hidden reasoning leaked', input_modality: 'text', output_modality: 'text', source: 'contract_test' }, { transcript_dir: transcriptDir }), /private thought\/reasoning marker/);
  const paths = getTranscriptPaths({ transcript_dir: transcriptDir });
  assert.equal(fs.existsSync(paths.transcript_jsonl_file), true);
  assert.equal(fs.existsSync(paths.transcript_text_file), true);
  assert.equal(fs.existsSync(paths.private_thought_jsonl_file), true);
  const publicTail = readChatTranscriptTail(10, { transcript_dir: transcriptDir });
  const privateTail = readPrivateThoughtTail(10, { transcript_dir: transcriptDir });
  assert.equal(publicTail.length, 2);
  assert.equal(privateTail.length, 1);
  assert.equal(publicTail.some((entry) => /safe_thought_summary|hidden reasoning|private thought/i.test(entry.text)), false);
  assert.equal(privateTail[0].private_review_memory_only, true);
  const publicText = fs.readFileSync(paths.transcript_text_file, 'utf8');
  const privateText = fs.readFileSync(paths.private_thought_text_file, 'utf8');
  assert.equal(publicText.includes('I am here, listening'), true);
  assert.equal(publicText.includes('I noticed trust'), false);
  assert.equal(privateText.includes('I noticed trust'), true);
  const startScript = fs.readFileSync(path.join(ROOT, 'bin', 'floki-start.sh'), 'utf8');
  assert.equal(startScript.includes('src/chat/floki-live-chat-interface.cjs'), true);
  assert.equal(startScript.includes('text-chat'), true);
  const spokenSource = fs.readFileSync(path.join(ROOT, 'src', 'senses', 'spoken-reply-once.cjs'), 'utf8');
  assert.equal(spokenSource.includes('appendSpokenReplyTranscript'), true);
  assert.equal(spokenSource.includes('assertPublicTranscriptText'), true);
  assert.equal(spokenSource.includes('appendPrivateThoughtRecord'), true);
  console.log(JSON.stringify({ ok: true, marker: 'FLOKI_V2_LIVE_CHAT_DUAL_INPUT_CONTRACT_PASS', text_input_supported: true, spoken_wake_input_supported: true, spoken_replies_recorded_to_public_chat_transcript: true, private_thoughts_blocked_from_public_transcript_and_speech: true, private_thoughts_recorded_to_private_review_memory: true, floki_start_chat_launches_live_interface: true, old_text_chat_preserved_as_text_chat: true, transcript_jsonl_file: paths.transcript_jsonl_file, private_thought_jsonl_file: paths.private_thought_jsonl_file, chat_mode_only: true, game_mode_started: false }, null, 2));
}

try { run(); } catch (error) { console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_LIVE_CHAT_DUAL_INPUT_CONTRACT_FAIL', error: error.message, chat_mode_only: true, game_mode_started: false }, null, 2)); process.exit(1); }
