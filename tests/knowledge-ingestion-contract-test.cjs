'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getPathConfig } = require('../src/config/floki-config.cjs');

const {
  statePath,
  ensureDirSync,
  writeTextFileAtomicSync,
  writeJsonFileAtomicSync
} = require('../src/util/fs-safe.cjs');
const { appendJsonlSync, readJsonlSync } = require('../src/util/jsonl.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  FLOKI_MEDIA_ROOT,
  detectKnowledgeInput,
  runKnowledgeIngestionOnce
} = require('../src/chat/knowledge-ingestion.cjs');

function repeatSentence(sentence, count) {
  return Array.from({ length: count }, () => sentence).join(' ');
}

function makeFixtures(baseDir) {
  const fixtureDir = path.join(baseDir, 'fixtures');
  const youtubeDir = path.join(baseDir, 'Floki-media', 'text', 'youtube', 'testchannel');
  const knowledgeRoot = path.join(baseDir, 'knowledge');

  ensureDirSync(fixtureDir);
  ensureDirSync(youtubeDir);
  ensureDirSync(knowledgeRoot);

  writeTextFileAtomicSync(path.join(fixtureDir, 'plain.txt'), repeatSentence('Floki learned a careful memory about trust and patient listening.', 40));
  writeTextFileAtomicSync(path.join(fixtureDir, 'notes.md'), '# Notes\n\n' + repeatSentence('Dreams and knowledge should feed chat-mode continuity honestly.', 35));
  writeTextFileAtomicSync(path.join(fixtureDir, 'caption.vtt'), [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:04.000',
    'This transcript line should be cleaned before ingestion.',
    '',
    '00:00:04.000 --> 00:00:08.000',
    'Floki remembers watched material only as text knowledge.'
  ].join('\n'));
  fs.writeFileSync(path.join(fixtureDir, 'unsupported.bin'), Buffer.from([1, 2, 3, 4]));

  const transcriptFile = path.join(youtubeDir, '20260618_fakevideo_Test_Title.en.txt');
  writeTextFileAtomicSync(transcriptFile, repeatSentence('A public YouTube transcript taught Floki about symbolic memory and careful self-continuity.', 45));

  appendJsonlSync(path.join(youtubeDir, 'transcripts.manifest.jsonl'), {
    video_id: 'fakevideo',
    title_guess: 'Test Title',
    video_url: 'https://www.youtube.com/watch?v=fakevideo',
    text_file: transcriptFile,
    word_count: 180,
    char_count: 1200,
    created_at_utc: '2026-06-18T12:00:00.000Z'
  });

  writeJsonFileAtomicSync(path.join(youtubeDir, 'SCRAPE_REPORT.latest.json'), {
    ok: true,
    marker: 'FLOKI_YOUTUBE_PUBLIC_TRANSCRIPT_SCRAPE_PASS',
    channel_folder: 'testchannel',
    text_dir: youtubeDir,
    downloaded_media: false,
    created_at_utc: '2026-06-18T12:00:00.000Z'
  });

  return Object.freeze({
    fixtureDir,
    youtubeDir,
    knowledgeRoot,
    transcriptFile
  });
}

function run() {
  const unique = newId('knowledge_ingestion').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/knowledge-ingestion/' + unique);
  const fixtures = makeFixtures(baseDir);

  const configuredMediaRoot = getPathConfig('chat').media_root;
  assert.equal(FLOKI_MEDIA_ROOT, configuredMediaRoot);
  assert.equal(path.isAbsolute(FLOKI_MEDIA_ROOT), true);

  const detectedDirectory = detectKnowledgeInput(fixtures.fixtureDir);
  assert.equal(detectedDirectory.ok, true);
  assert.equal(detectedDirectory.input_type, 'directory');

  const first = runKnowledgeIngestionOnce({
    env: { FLOKI_ALLOW_KNOWLEDGE_INGESTION: '1' },
    input_path: fixtures.fixtureDir,
    knowledge_root: fixtures.knowledgeRoot,
    report_file: path.join(baseDir, 'first-report.json')
  });

  assert.equal(first.ok, true);
  assert.equal(first.marker, 'FLOKI_V2_KNOWLEDGE_INGESTION_CONTRACT_PASS');
  assert.equal(first.source_count, 3);
  assert.equal(first.chunk_count >= 3, true);
  assert.equal(first.unsupported_count, 1);
  assert.equal(first.failed_count, 0);
  assert.equal(first.model_called_now, false);
  assert.equal(first.network_called_now, false);
  assert.equal(first.chat_mode_only, true);
  assert.equal(first.game_mode_started, false);

  const second = runKnowledgeIngestionOnce({
    env: { FLOKI_ALLOW_KNOWLEDGE_INGESTION: '1' },
    input_path: fixtures.fixtureDir,
    knowledge_root: fixtures.knowledgeRoot,
    report_file: path.join(baseDir, 'second-report.json')
  });

  assert.equal(second.ok, true);
  assert.equal(second.chunk_count, 0);
  assert.equal(second.duplicate_chunk_count >= first.chunk_count, true);

  const detectedYoutube = detectKnowledgeInput(fixtures.youtubeDir);
  assert.equal(detectedYoutube.ok, true);
  assert.equal(detectedYoutube.input_type, 'youtube_transcript_dir');
  assert.equal(detectedYoutube.channel_folder, 'testchannel');

  const youtube = runKnowledgeIngestionOnce({
    env: { FLOKI_ALLOW_KNOWLEDGE_INGESTION: '1' },
    input_path: fixtures.youtubeDir,
    knowledge_root: fixtures.knowledgeRoot,
    report_file: path.join(baseDir, 'youtube-report.json')
  });

  assert.equal(youtube.ok, true);
  assert.equal(youtube.input_type, 'youtube_transcript_dir');
  assert.equal(youtube.channel_folder, 'testchannel');
  assert.equal(youtube.source_count >= 2, true);
  assert.equal(youtube.source_summaries.some((source) => source.source_type === 'youtube_transcript' && source.video_id === 'fakevideo'), true);
  assert.equal(youtube.model_called_now, false);
  assert.equal(youtube.network_called_now, false);
  assert.equal(youtube.chat_mode_only, true);
  assert.equal(youtube.game_mode_started, false);

  const chunks = readJsonlSync(path.join(fixtures.knowledgeRoot, 'chunks.jsonl'));
  assert.equal(chunks.length >= first.chunk_count + youtube.chunk_count, true);
  assert.equal(chunks.some((chunk) => chunk.source_type === 'youtube_transcript' && chunk.channel_folder === 'testchannel'), true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_KNOWLEDGE_INGESTION_CONTRACT_PASS',
    input_types_verified: ['directory', 'youtube_transcript_dir'],
    source_count: first.source_count + youtube.source_count,
    chunk_count: first.chunk_count + youtube.chunk_count,
    duplicate_chunk_count: second.duplicate_chunk_count,
    unsupported_count: first.unsupported_count,
    youtube_metadata_preserved: true,
    floki_media_root: FLOKI_MEDIA_ROOT,
    persistent_knowledge_used: true,
    model_called_now: false,
    network_called_now: false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_KNOWLEDGE_INGESTION_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
