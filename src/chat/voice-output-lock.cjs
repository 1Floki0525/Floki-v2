'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { statePath } = require('../util/fs-safe.cjs');
const { newId } = require('../util/ids.cjs');
const { nowIso } = require('../util/time.cjs');

const VOICE_OUTPUT_LOCK_VERSION = 'floki-v2-voice-output-lock-v1';
const DEFAULT_TTL_MS = 120000;

function defaultLockFile() {
  return statePath('chat/voice/voice-output-lock.json');
}

function nowMs() {
  return Date.now();
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tmp = filePath + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sanitizeTextHash(value) {
  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  return text.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 160);
}

function normalizeLockRecord(record, options = {}) {
  const currentMs = typeof options.now_ms === 'number' ? options.now_ms : nowMs();

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return Object.freeze({
      lock_version: VOICE_OUTPUT_LOCK_VERSION,
      active: false,
      speaking_now: false,
      ears_muted_now: false,
      reason: 'missing_lock_record',
      lock_id: null,
      source: null,
      output_id: null,
      text_hash: '',
      started_at: null,
      started_at_ms: null,
      expires_at_ms: null,
      expired: false,
      current_time_ms: currentMs,
      chat_mode_only: true
    });
  }

  const active = record.active === true;
  const expiresAtMs = Number(record.expires_at_ms || 0);
  const expired = active && expiresAtMs > 0 && expiresAtMs <= currentMs;
  const speakingNow = active && !expired;

  return Object.freeze({
    lock_version: record.lock_version || VOICE_OUTPUT_LOCK_VERSION,
    active,
    speaking_now: speakingNow,
    ears_muted_now: speakingNow,
    reason: speakingNow ? 'voice_output_active' : (expired ? 'voice_output_lock_expired' : 'voice_output_inactive'),
    lock_id: record.lock_id || null,
    source: record.source || null,
    output_id: record.output_id || null,
    text_hash: sanitizeTextHash(record.text_hash || ''),
    started_at: record.started_at || null,
    started_at_ms: typeof record.started_at_ms === 'number' ? record.started_at_ms : null,
    expires_at_ms: expiresAtMs || null,
    expired,
    current_time_ms: currentMs,
    chat_mode_only: true
  });
}

function createVoiceOutputLock(options = {}) {
  const lockFile = options.lock_file || defaultLockFile();

  function readRaw() {
    return readJsonIfExists(lockFile);
  }

  function status(local = {}) {
    return normalizeLockRecord(readRaw(), {
      now_ms: typeof local.now_ms === 'number'
        ? local.now_ms
        : (typeof options.now_ms === 'number' ? options.now_ms : nowMs())
    });
  }

  function beginSpeaking(metadata = {}) {
    const currentMs = typeof metadata.now_ms === 'number'
      ? metadata.now_ms
      : (typeof options.now_ms === 'number' ? options.now_ms : nowMs());

    const ttlMs = Number(metadata.ttl_ms || options.ttl_ms || DEFAULT_TTL_MS);

    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('voice output lock ttl_ms must be positive');
    }

    const record = {
      lock_version: VOICE_OUTPUT_LOCK_VERSION,
      active: true,
      lock_id: metadata.lock_id || newId('voice_lock'),
      source: metadata.source || 'piper',
      output_id: metadata.output_id || null,
      text_hash: sanitizeTextHash(metadata.text_hash || ''),
      started_at: nowIso(),
      started_at_ms: currentMs,
      expires_at_ms: currentMs + ttlMs,
      chat_mode_only: true
    };

    atomicWriteJson(lockFile, record);

    return status({ now_ms: currentMs });
  }

  function endSpeaking(metadata = {}) {
    const currentMs = typeof metadata.now_ms === 'number'
      ? metadata.now_ms
      : (typeof options.now_ms === 'number' ? options.now_ms : nowMs());

    const prior = readRaw() || {};

    const record = {
      lock_version: VOICE_OUTPUT_LOCK_VERSION,
      active: false,
      lock_id: prior.lock_id || metadata.lock_id || null,
      source: prior.source || metadata.source || 'piper',
      output_id: prior.output_id || metadata.output_id || null,
      text_hash: sanitizeTextHash(prior.text_hash || metadata.text_hash || ''),
      started_at: prior.started_at || null,
      started_at_ms: typeof prior.started_at_ms === 'number' ? prior.started_at_ms : null,
      ended_at: nowIso(),
      ended_at_ms: currentMs,
      expires_at_ms: currentMs,
      ended_reason: metadata.reason || 'completed',
      chat_mode_only: true
    };

    atomicWriteJson(lockFile, record);

    return status({ now_ms: currentMs });
  }

  function clearExpired(local = {}) {
    const current = status(local);

    if (!current.expired) {
      return current;
    }

    return endSpeaking({
      now_ms: current.current_time_ms,
      reason: 'expired'
    });
  }

  function isEarsMuted(local = {}) {
    const current = clearExpired(local);

    return Object.freeze({
      ok: true,
      marker: current.ears_muted_now
        ? 'FLOKI_V2_VOICE_OUTPUT_EARS_MUTED'
        : 'FLOKI_V2_VOICE_OUTPUT_EARS_OPEN',
      lock_version: VOICE_OUTPUT_LOCK_VERSION,
      speaking_now: current.speaking_now,
      ears_muted_now: current.ears_muted_now,
      voice_output_lock_active: current.speaking_now,
      reason: current.reason,
      lock_id: current.lock_id,
      source: current.source,
      output_id: current.output_id,
      chat_mode_only: true
    });
  }

  async function withEarsMutedDuringSpeech(fn, metadata = {}) {
    if (typeof fn !== 'function') {
      throw new TypeError('withEarsMutedDuringSpeech requires a function');
    }

    const started = beginSpeaking(metadata);

    try {
      const result = await fn(started);
      const ended = endSpeaking({ reason: 'completed' });

      return Object.freeze({
        ok: true,
        started,
        result,
        ended,
        ears_muted_during_speech: started.ears_muted_now === true,
        ears_open_after_speech: ended.ears_muted_now === false,
        chat_mode_only: true
      });
    } catch (error) {
      const ended = endSpeaking({ reason: 'error' });
      error.voice_output_lock_ended = ended;
      throw error;
    }
  }

  return Object.freeze({
    lock_file: lockFile,
    status,
    beginSpeaking,
    endSpeaking,
    clearExpired,
    isEarsMuted,
    withEarsMutedDuringSpeech
  });
}

function voiceOutputLockStatus(options = {}) {
  const lock = createVoiceOutputLock(options);
  const status = lock.status();

  return Object.freeze({
    ok: true,
    marker: status.ears_muted_now
      ? 'FLOKI_V2_VOICE_OUTPUT_LOCK_ACTIVE'
      : 'FLOKI_V2_VOICE_OUTPUT_LOCK_INACTIVE',
    lock_version: VOICE_OUTPUT_LOCK_VERSION,
    lock_file: lock.lock_file,
    speaking_now: status.speaking_now,
    ears_muted_now: status.ears_muted_now,
    voice_output_lock_active: status.speaking_now,
    reason: status.reason,
    chat_mode_only: true
  });
}

if (require.main === module) {
  console.log(JSON.stringify(voiceOutputLockStatus(), null, 2));
}

module.exports = {
  VOICE_OUTPUT_LOCK_VERSION,
  DEFAULT_TTL_MS,
  defaultLockFile,
  nowMs,
  atomicWriteJson,
  readJsonIfExists,
  sanitizeTextHash,
  normalizeLockRecord,
  createVoiceOutputLock,
  voiceOutputLockStatus
};
