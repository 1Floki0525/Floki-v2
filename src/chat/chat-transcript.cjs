'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { PROJECT_ROOT: ROOT, getPathConfig } = require('../config/floki-config.cjs');
const DEFAULT_TRANSCRIPT_DIR = path.resolve(ROOT, getPathConfig('chat').chat_transcript_root);

const PRIVATE_THOUGHT_PATTERNS = Object.freeze([
  /<think>/i,
  /<\/think>/i,
  /chain[-_ ]of[-_ ]thought/i,
  /private[-_ ]reasoning/i,
  /reasoning[-_ ]trace/i,
  /internal[-_ ]thought/i,
  /hidden[-_ ]thought/i,
  /hidden[-_ ]reasoning/i,
  /raw[-_ ]reasoning/i,
  /scratchpad/i,
  /safe[-_ ]thought[-_ ]summary/i,
  /thought_summary/i
]);

function nowIso(options = {}) {
  if (typeof options.clock === 'function') return new Date(options.clock()).toISOString();
  if (options.now) return new Date(options.now).toISOString();
  return new Date().toISOString();
}

function hashId(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 32);
}

function getTranscriptPaths(options = {}) {
  const dir = path.resolve(options.transcript_dir || process.env.FLOKI_CHAT_TRANSCRIPT_DIR || DEFAULT_TRANSCRIPT_DIR);
  return Object.freeze({
    transcript_dir: dir,
    transcript_jsonl_file: path.join(dir, 'chat-transcript.jsonl'),
    transcript_text_file: path.join(dir, 'chat-transcript.txt'),
    private_thought_jsonl_file: path.join(dir, 'chat-thoughts.private.jsonl'),
    private_thought_text_file: path.join(dir, 'chat-thoughts.private.txt')
  });
}

function cleanText(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

function assertPublicTranscriptText(text, fieldName = 'public transcript text') {
  const value = cleanText(text);
  for (const pattern of PRIVATE_THOUGHT_PATTERNS) {
    if (pattern.test(value)) {
      throw new Error(fieldName + ' contains private thought/reasoning marker and must not enter public transcript or speech');
    }
  }
  return value;
}

function humanLine(entry) {
  const modality = entry.input_modality || entry.output_modality || 'unknown';
  const spoken = entry.spoken_aloud === true ? ' spoken' : '';
  const partial = entry.transcript_state === 'partial' ? ' partial' : '';
  return '[' + entry.created_at + '] ' + entry.role + ' [' + modality + spoken + partial + ']: ' + entry.text + '\n';
}

function writeTranscriptEntries(entries, options = {}) {
  const paths = getTranscriptPaths(options);
  fs.mkdirSync(paths.transcript_dir, { recursive: true });
  const jsonTemp = paths.transcript_jsonl_file + '.tmp-' + process.pid;
  const textTemp = paths.transcript_text_file + '.tmp-' + process.pid;
  fs.writeFileSync(jsonTemp, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(textTemp, entries.map(humanLine).join(''), 'utf8');
  fs.renameSync(jsonTemp, paths.transcript_jsonl_file);
  fs.renameSync(textTemp, paths.transcript_text_file);
  return paths;
}

function appendChatTranscriptTurn(record, options = {}) {
  const paths = getTranscriptPaths(options);
  fs.mkdirSync(paths.transcript_dir, { recursive: true });
  const createdAt = nowIso(options);
  const text = assertPublicTranscriptText(record.text, 'public chat transcript text');
  if (!text) {
    return Object.freeze({ written: false, reason: 'empty_text', transcript_jsonl_file: paths.transcript_jsonl_file, transcript_text_file: paths.transcript_text_file });
  }
  const entry = Object.freeze({
    id: record.id || hashId([createdAt, record.role || '', record.source || '', record.input_modality || '', record.output_modality || '', text].join('\n')),
    created_at: createdAt,
    role: record.role || 'unknown',
    text,
    input_modality: record.input_modality || 'unknown',
    output_modality: record.output_modality || 'unknown',
    spoken_aloud: record.spoken_aloud === true,
    source: record.source || 'unknown',
    category: record.category || 'reflection',
    severity: record.severity || 'info',
    event_id: record.event_id || null,
    report_file: record.report_file || null,
    hearing_report_file: record.hearing_report_file || null,
    bridge_report_file: record.bridge_report_file || null,
    spoken_reply_report_file: record.spoken_reply_report_file || null,
    piper_wav_output_file: record.piper_wav_output_file || null,
    transcript_state: record.transcript_state === 'partial' ? 'partial' : 'final',
    finalized_at: record.transcript_state === 'partial' ? null : (record.finalized_at || createdAt),
    private_thought_visible: false,
    chat_mode_only: true,
    game_mode_started: false
  });
  fs.appendFileSync(paths.transcript_jsonl_file, JSON.stringify(entry) + '\n', 'utf8');
  fs.appendFileSync(paths.transcript_text_file, humanLine(entry), 'utf8');
  return Object.freeze({ written: true, entry, transcript_jsonl_file: paths.transcript_jsonl_file, transcript_text_file: paths.transcript_text_file });
}

function upsertChatTranscriptTurn(record, options = {}) {
  const paths = getTranscriptPaths(options);
  fs.mkdirSync(paths.transcript_dir, { recursive: true });
  const id = String(record.id || '').trim();
  if (!id) throw new Error('upsertChatTranscriptTurn requires a stable record.id');
  const text = assertPublicTranscriptText(record.text, 'public chat transcript text');
  if (!text) return Object.freeze({ written: false, reason: 'empty_text', transcript_jsonl_file: paths.transcript_jsonl_file });
  const entries = readJsonlTail(paths.transcript_jsonl_file, Number.MAX_SAFE_INTEGER);
  const index = entries.findIndex((entry) => entry && entry.id === id);
  const prior = index >= 0 ? entries[index] : null;
  const createdAt = prior && prior.created_at || nowIso(options);
  const entry = Object.freeze({
    ...(prior || {}),
    id,
    created_at: createdAt,
    role: record.role || prior && prior.role || 'user',
    text,
    input_modality: record.input_modality || prior && prior.input_modality || 'spoken',
    output_modality: record.output_modality || prior && prior.output_modality || 'none',
    spoken_aloud: record.spoken_aloud === true,
    source: record.source || prior && prior.source || 'live_audio_service',
    event_id: record.event_id || prior && prior.event_id || null,
    transcript_state: record.transcript_state === 'partial' ? 'partial' : 'final',
    finalized_at: record.transcript_state === 'partial' ? null : (record.finalized_at || nowIso(options)),
    private_thought_visible: false,
    chat_mode_only: true,
    game_mode_started: false
  });
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  writeTranscriptEntries(entries, options);
  return Object.freeze({ written: true, replaced: index >= 0, entry, transcript_jsonl_file: paths.transcript_jsonl_file, transcript_text_file: paths.transcript_text_file });
}

function removeChatTranscriptTurn(id, options = {}) {
  const stableId = String(id || '').trim();
  if (!stableId) return Object.freeze({ removed: false, reason: 'missing_id' });
  const paths = getTranscriptPaths(options);
  const entries = readJsonlTail(paths.transcript_jsonl_file, Number.MAX_SAFE_INTEGER);
  const remaining = entries.filter((entry) => entry && entry.id !== stableId);
  if (remaining.length === entries.length) return Object.freeze({ removed: false, reason: 'not_found' });
  writeTranscriptEntries(remaining, options);
  return Object.freeze({ removed: true, id: stableId, transcript_jsonl_file: paths.transcript_jsonl_file, transcript_text_file: paths.transcript_text_file });
}

function normalizePrivateThoughtText(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function appendPrivateThoughtRecord(record, options = {}) {
  const paths = getTranscriptPaths(options);
  fs.mkdirSync(paths.transcript_dir, { recursive: true });
  const createdAt = nowIso(options);
  const text = cleanText(record.text || record.safe_thought_summary || '');
  if (!text) {
    return Object.freeze({ written: false, reason: 'empty_private_thought', private_thought_jsonl_file: paths.private_thought_jsonl_file });
  }
  const category = record.category || 'reflection';
  const sessionId = record.session_id || options.session_id || null;
  const dedupeWindowMs = Math.max(0, Number(record.dedupe_window_ms === undefined ? options.dedupe_window_ms || 0 : record.dedupe_window_ms));
  const normalizedText = normalizePrivateThoughtText(text);
  if (dedupeWindowMs > 0 && normalizedText) {
    const cutoff = new Date(createdAt).getTime() - dedupeWindowMs;
    const duplicate = readJsonlTail(paths.private_thought_jsonl_file, 2000).reverse().find((entry) => {
      if (!entry || normalizePrivateThoughtText(entry.text) !== normalizedText) return false;
      if (String(entry.category || 'reflection') !== String(category)) return false;
      if (sessionId && entry.session_id !== sessionId) return false;
      const when = Date.parse(entry.created_at || '');
      return Number.isFinite(when) && when >= cutoff;
    });
    if (duplicate) {
      return Object.freeze({ written: false, reason: 'duplicate_private_thought', duplicate_id: duplicate.id, private_thought_jsonl_file: paths.private_thought_jsonl_file });
    }
  }
  const entry = Object.freeze({
    id: record.id || hashId([createdAt, 'private_thought', record.source || '', category, sessionId || '', text].join('\n')),
    created_at: createdAt,
    role: 'floki_private_thought',
    text,
    source: record.source || 'unknown',
    category,
    severity: record.severity || 'info',
    event_id: record.event_id || null,
    session_id: sessionId,
    report_file: record.report_file || null,
    public_transcript_visible: false,
    spoken_aloud: false,
    private_review_memory_only: true,
    chat_mode_only: true,
    game_mode_started: false
  });
  fs.appendFileSync(paths.private_thought_jsonl_file, JSON.stringify(entry) + '\n', 'utf8');
  fs.appendFileSync(paths.private_thought_text_file, '[' + entry.created_at + '] private thought: ' + entry.text + '\n', 'utf8');
  return Object.freeze({ written: true, entry, private_thought_jsonl_file: paths.private_thought_jsonl_file, private_thought_text_file: paths.private_thought_text_file });
}

function readJsonlTail(file, limit) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Number(limit || 80)));
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch (error) { out.push({ id: hashId(line), role: 'system', text: 'invalid transcript line: ' + error.message }); }
  }
  return out;
}

function readChatTranscriptTail(limit = 80, options = {}) {
  return readJsonlTail(getTranscriptPaths(options).transcript_jsonl_file, limit);
}

function readPrivateThoughtTail(limit = 80, options = {}) {
  return readJsonlTail(getTranscriptPaths(options).private_thought_jsonl_file, limit);
}

function clearChatTranscript(options = {}) {
  const paths = getTranscriptPaths(options);
  fs.mkdirSync(paths.transcript_dir, { recursive: true });
  const entriesCleared = readJsonlTail(paths.transcript_jsonl_file, Number.MAX_SAFE_INTEGER).length;
  fs.writeFileSync(paths.transcript_jsonl_file, '', 'utf8');
  fs.writeFileSync(paths.transcript_text_file, '', 'utf8');
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_TRANSCRIPT_CLEAR_PASS',
    entries_cleared: entriesCleared,
    transcript_jsonl_file: paths.transcript_jsonl_file,
    transcript_text_file: paths.transcript_text_file,
    private_thoughts_preserved: true
  });
}

module.exports = {
  ROOT,
  DEFAULT_TRANSCRIPT_DIR,
  PRIVATE_THOUGHT_PATTERNS,
  getTranscriptPaths,
  assertPublicTranscriptText,
  appendChatTranscriptTurn,
  upsertChatTranscriptTurn,
  removeChatTranscriptTurn,
  appendPrivateThoughtRecord,
  normalizePrivateThoughtText,
  readChatTranscriptTail,
  readPrivateThoughtTail,
  clearChatTranscript
};
