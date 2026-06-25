'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runConfiguredKnowledgeAutoload } = require('../src/chat/knowledge-autoload.cjs');
const { retrieveKnowledgeContext } = require('../src/chat/knowledge-context.cjs');
const { runKnowledgeMemoryConsolidation } = require('../src/chat/knowledge-memory-consolidation.cjs');
const { createChatMemorySubstrate } = require('../src/chat/chat-memory-substrate.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-knowledge-memory-'));
try {
  const youtubeRoot = path.join(root, 'text', 'youtube');
  const channel = path.join(youtubeRoot, 'MorgueOfficial');
  const nestedTranscriptDir = path.join(channel, 'archive', 'transcripts');
  const knowledgeRoot = path.join(root, 'knowledge');
  const memoryRoot = path.join(root, 'memory');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(nestedTranscriptDir, { recursive: true });
  fs.writeFileSync(path.join(nestedTranscriptDir, 'morgue-origins.txt'), [
    'Morgue Official discusses consciousness, personal identity, symbolism, and the continuity of memory.',
    'The transcript connects trust and hope with the way a person forms meaning over time.'
  ].join('\n'), 'utf8');

  const loaded = runConfiguredKnowledgeAutoload({
    youtube_root: youtubeRoot,
    knowledge_root: knowledgeRoot,
    runtime_dir: runtimeRoot,
    stamp_file: path.join(runtimeRoot, 'autoload.stamp'),
    force: true,
    write_report: false
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.autoload_run_now, true);
  assert.ok(loaded.source_count >= 1);
  assert.ok(loaded.chunk_count >= 1);

  const context = retrieveKnowledgeContext('What do you remember about Morgue Official?', {
    knowledge_root: knowledgeRoot,
    limit: 8
  });
  assert.equal(context.persistent_knowledge_used, true);
  assert.ok(context.knowledge_matches.length >= 1);
  assert.ok(context.knowledge_matches.some((match) => /morgueofficial/i.test(String(match.channel_folder || ''))));
  assert.ok(context.knowledge_matches.some((match) => /consciousness|identity|symbolism/i.test(String(match.summary || ''))));

  const consolidated = runKnowledgeMemoryConsolidation({
    knowledge_root: knowledgeRoot,
    memory_base_dir: memoryRoot,
    write_report: false
  });
  assert.equal(consolidated.ok, true);
  assert.ok(consolidated.memories_written >= 1);

  const second = runKnowledgeMemoryConsolidation({
    knowledge_root: knowledgeRoot,
    memory_base_dir: memoryRoot,
    write_report: false
  });
  assert.equal(second.memories_written, 0);

  const substrate = createChatMemorySubstrate({ base_dir: memoryRoot });
  const recalled = substrate.recallContext({ text: 'Morgue Official consciousness identity', limit: 10 });
  assert.ok(recalled.long_term_matches.some((item) => /MorgueOfficial/i.test(item.memory.text)));
  assert.ok(recalled.long_term_matches.some((item) => item.memory.source === 'youtube_knowledge_consolidation'));

  console.log('FLOKI_V2_CHAT_LOCAL_KNOWLEDGE_MEMORY_INTEGRATION_PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
