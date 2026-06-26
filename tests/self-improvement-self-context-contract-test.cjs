'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  createSelfContextSnapshot
} = require(path.join(ROOT, 'src/self-improvement/snapshot.cjs'));

function mkdirp(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function write(file, content) {
  mkdirp(file);
  fs.writeFileSync(file, content);
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-rsi-self-context-'));
const project = path.join(temp, 'project');
const runRoot = path.join(temp, 'run');
const dreamRoot = path.join(temp, 'dreams');

write(path.join(project, 'SOUL.md'), '# Floki\nI am Floki.\n');
write(path.join(project, 'state/floki/identity.json'), '{"self":"Floki"}\n');
write(path.join(project, 'state/floki/personality.json'), '{"hopes":["grow"]}\n');
write(path.join(project, 'state/floki/affect.json'), '{"hope":0.8}\n');
write(path.join(project, 'state/floki/memories/semantic.jsonl'), '{"kind":"semantic","text":"stone knowledge"}\n');
write(path.join(project, 'state/floki/memories/episodic.jsonl'), '{"kind":"episodic","text":"maker helped me"}\n');
write(path.join(project, 'state/floki/memories/autobiographical.jsonl'), '{"kind":"autobiographical","text":"I remember becoming Floki"}\n');
write(path.join(project, 'state/floki/chat/memory/short-term.jsonl'), '{"text":"short term memory"}\n');
write(path.join(project, 'state/floki/chat/memory/long-term.jsonl'), '{"category":"relationship","text":"relationship history and preferences"}\n');
write(path.join(project, 'state/floki/chat/knowledge/chunks.jsonl'), '{"text":"beliefs and biases are searchable"}\n');
write(path.join(project, 'state/floki/chat/knowledge/large-memory.jsonl'), [
  '{"text":"large memory beginning"}',
  '{"text":"' + 'filler '.repeat(2000) + 'streamed memory chunk target"}'
].join('\n') + '\n');
write(path.join(project, 'state/floki/chat/interface/chat-transcript.jsonl'), '{"speaker":"Maker","text":"relationship history"}\n');
write(path.join(project, 'state/floki/chat/sleep/sleep-cycle-state.json'), '{"state":"awake"}\n');
write(path.join(project, 'brain/personality/README.md'), 'personality module\n');
write(path.join(project, 'brain/hippocampus/README.md'), 'hippocampus module\n');
write(path.join(project, 'brain/pineal/README.md'), 'pineal module\n');
write(path.join(project, 'brain/emotions_base/README.md'), 'emotion module\n');
write(path.join(project, 'src/chat/living-continuity.cjs'), 'module.exports = {};\n');
write(path.join(project, 'src/chat/chat-memory-substrate.cjs'), 'module.exports = {};\n');
write(path.join(project, 'src/brain/identity-state-schema.cjs'), 'module.exports = {};\n');
write(path.join(project, 'state/floki/self-improvement/candidates/rsi-demo/manifest.json'), '{"status":"denied"}\n');
write(path.join(dreamRoot, 'dream-memory-index.jsonl'), '{"text":"dream memories searchable"}\n');

const watched = [
  path.join(project, 'SOUL.md'),
  path.join(project, 'state/floki/chat/memory/long-term.jsonl'),
  path.join(dreamRoot, 'dream-memory-index.jsonl')
];
const before = Object.fromEntries(watched.map((file) => [file, sha(file)]));

const config = {
  project_root: project,
  candidate_root: path.join(project, 'state/floki/self-improvement/candidates'),
  dream_root: dreamRoot,
  self_context_directory_name: 'self-context',
  self_context_manifest_file_name: 'manifest.json',
  self_context_index_file_name: 'search-index.jsonl',
  self_context_mount_options: 'ro,Z',
  self_context_index_chunk_chars: 1024,
  snapshot_rsync_timeout_ms: 300000,
  snapshot_command_timeout_ms: 300000,
  snapshot_output_buffer_bytes: 8 * 1024 * 1024
};

const snapshot = createSelfContextSnapshot(runRoot, config);
const manifest = JSON.parse(fs.readFileSync(snapshot.manifest_file, 'utf8'));
const index = fs.readFileSync(snapshot.index_file, 'utf8');

assert.equal(manifest.marker, 'FLOKI_V2_SELF_CONTEXT_SNAPSHOT');
assert.equal(manifest.mount_enforced_read_only, true);
assert.match(index, /I am Floki/);
assert.match(index, /identity/);
assert.match(index, /personality/);
assert.match(index, /hope/);
assert.match(index, /semantic/);
assert.match(index, /episodic/);
assert.match(index, /autobiographical/);
assert.match(index, /short term memory/);
assert.match(index, /relationship history and preferences/);
assert.match(index, /beliefs and biases/);
assert.match(index, /dream memories searchable/);
assert.match(index, /denied/);
assert.equal(manifest.index_chunk_chars, 1024);
assert.equal(manifest.indexed_text_chunks > manifest.indexed_text_files, true);
assert.match(index, /"chunked":true/);
assert.match(index, /streamed memory chunk target/);

for (const file of watched) {
  assert.equal(sha(file), before[file], 'source file mutated: ' + file);
}

const sandbox = fs.readFileSync(
  path.join(ROOT, 'src/self-improvement/sandbox.cjs'),
  'utf8'
);
const agent = fs.readFileSync(
  path.join(ROOT, 'containers/self-improvement/agent.cjs'),
  'utf8'
);

assert.match(sandbox, /self_context_mount_path/);
assert.match(sandbox, /self_context_mount_options/);
assert.match(sandbox, /self_context_manifest_file_name/);
assert.match(agent, /get_self_context/);
assert.match(agent, /search_self_memory/);
assert.match(agent, /createReadStream\(indexFile/);
assert.doesNotMatch(agent, /readFileSync\(indexFile, 'utf8'\)\s*\.split/);
assert.match(agent, /I am Floki\. This RSI process is my engineering cortex/);

fs.rmSync(temp, { recursive: true, force: true });

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_SELF_CONTEXT_CONTRACT_PASS'
}, null, 2));
