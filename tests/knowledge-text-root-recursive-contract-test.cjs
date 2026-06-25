
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runConfiguredKnowledgeAutoload } = require('../src/chat/knowledge-autoload.cjs');
const { loadKnowledgeChunks } = require('../src/chat/knowledge-context.cjs');
const { readJsonlSync } = require('../src/util/jsonl.cjs');

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'floki-text-root-recursive-')
);
try {
  const textRoot = path.join(root, 'text');
  const youtubeRoot = path.join(textRoot, 'video-platform-a');
  const first = path.join(
    youtubeRoot,
    'channel-alpha',
    'nested',
    'alpha.txt'
  );
  const second = path.join(
    textRoot,
    'video-platform-b',
    'channel-beta',
    'archive',
    'deeper',
    'beta.md'
  );
  const knowledgeRoot = path.join(root, 'knowledge');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(
    first,
    'Channel Alpha discusses consciousness, symbolic memory, and continuity. '.repeat(40),
    'utf8'
  );
  fs.writeFileSync(
    second,
    'Channel Beta explores identity, trust, uncertainty, and personal meaning. '.repeat(40),
    'utf8'
  );

  const options = {
    text_root: textRoot,
    youtube_root: youtubeRoot,
    knowledge_root: knowledgeRoot,
    runtime_dir: runtimeRoot,
    stamp_file: path.join(runtimeRoot, 'autoload.stamp'),
    max_files: 0,
    force: true,
    write_report: false
  };

  const firstRun = runConfiguredKnowledgeAutoload(options);
  assert.equal(firstRun.ok, true);
  assert.equal(firstRun.autoload_run_now, true);
  assert.equal(firstRun.channel_count, 2);
  assert.equal(firstRun.source_count, 2);
  assert.ok(firstRun.chunk_count >= 2);
  assert.equal(firstRun.scanned_file_count, 2);

  const chunks = loadKnowledgeChunks({ knowledge_root: knowledgeRoot });
  assert.equal(
    chunks.some((chunk) => chunk.channel_folder === 'channel-alpha'),
    true
  );
  assert.equal(
    chunks.some((chunk) => chunk.channel_folder === 'channel-beta'),
    true
  );
  assert.equal(
    chunks.some((chunk) => chunk.source_type === 'youtube_transcript'),
    true
  );
  assert.equal(
    chunks.some((chunk) => chunk.source_type === 'media_text'),
    true
  );

  const sourcesFile = path.join(knowledgeRoot, 'sources.jsonl');
  const sourceCountBefore = readJsonlSync(sourcesFile).length;
  const chunkCountBefore = chunks.length;

  const secondRun = runConfiguredKnowledgeAutoload(options);
  assert.equal(secondRun.ok, true);
  assert.equal(secondRun.source_count, 0);
  assert.equal(secondRun.chunk_count, 0);
  assert.equal(secondRun.unchanged_source_count, 2);
  assert.equal(readJsonlSync(sourcesFile).length, sourceCountBefore);
  assert.equal(
    loadKnowledgeChunks({ knowledge_root: knowledgeRoot }).length,
    chunkCountBefore
  );

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_TEXT_ROOT_RECURSIVE_KNOWLEDGE_PASS',
    recursive_sources: firstRun.channel_count,
    source_count: firstRun.source_count,
    chunk_count: firstRun.chunk_count,
    unchanged_sources_skipped_without_pollution: true,
    channel_names_discovered_from_paths: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
