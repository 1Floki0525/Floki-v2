'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { PROJECT_ROOT: ROOT, getPathConfig } = require('../config/floki-config.cjs');
const DEFAULT_TRANSCRIPT_DIR = path.join(ROOT, 'state', 'floki', 'chat', 'interface');

const PRIVATE_THOUGHT_PATTERNS = Object.freeze([
  /<think>/i,
  /<\/think>/i,
  /chain[-_ ]of[-_ ]thought/i,
  /private[-_ ]reasoning/i,
  /reasoning[-_ ]trace/i,
  /internal[-_ ]thought/i,
  /hidden[-_ ]thought/i,
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
  return '[' + entry.created_at + '] ' + entry.role + ' [' + modality + spoken + ']: ' + entry.text + '\n';
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
    event_id: record.event_id || null,
    report_file: record.report_file || null,
    hearing_report_file: record.hearing_report_file || null,
    bridge_report_file: record.bridge_report_file || null,
    spoken_reply_report_file: record.spoken_reply_report_file || null,
    piper_wav_output_file: record.piper_wav_output_file || null,
    private_thought_visible: false,
    chat_mode_only: true,
    game_mode_started: false
  });
  fs.appendFileSync(paths.transcript_jsonl_file, JSON.stringify(entry) + '\n', 'utf8');
  fs.appendFileSync(paths.transcript_text_file, humanLine(entry), 'utf8');
  return Object.freeze({ written: true, entry, transcript_jsonl_file: paths.transcript_jsonl_file, transcript_text_file: paths.transcript_text_file });
}

function appendPrivateThoughtRecord(record, options = {}) {
  const paths = getTranscriptPaths(options);
  fs.mkdirSync(paths.transcript_dir, { recursive: true });
  const createdAt = nowIso(options);
  const text = cleanText(record.text || record.safe_thought_summary || '');
  if (!text) {
    return Object.freeze({ written: false, reason: 'empty_private_thought', private_thought_jsonl_file: paths.private_thought_jsonl_file });
  }
  const entry = Object.freeze({
    id: record.id || hashId([createdAt, 'private_thought', record.source || '', text].join('\n')),
    created_at: createdAt,
    role: 'floki_private_thought',
    text,
    source: record.source || 'unknown',
    event_id: record.event_id || null,
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

module.exports = {
  ROOT,
  DEFAULT_TRANSCRIPT_DIR,
  PRIVATE_THOUGHT_PATTERNS,
  getTranscriptPaths,
  assertPublicTranscriptText,
  appendChatTranscriptTurn,
  appendPrivateThoughtRecord,
  readChatTranscriptTail,
  readPrivateThoughtTail
};
