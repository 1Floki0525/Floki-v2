'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');

const EVENT_NAMES = Object.freeze([
  'request_accepted',
  'cached_vision_ready',
  'memory_context_ready',
  'model_dispatched',
  'first_response_chunk',
  'first_safe_public_text',
  'first_safe_sentence',
  'final_model_output',
  'schema_valid',
  'broca_ready',
  'tts_started',
  'tts_ready',
  'playback_started',
  'response_completed',
  'response_interrupted',
  'response_failed'
]);

const EVENT_SET = new Set(EVENT_NAMES);
const SAFE_EXTRA_KEYS = new Set([
  'configured_model',
  'configured_endpoint',
  'prompt_character_count',
  'prompt_token_count',
  'schema_enabled',
  'streaming_enabled',
  'retry_count',
  'safe_public_text_length',
  'completion_status',
  'error_code',
  'input_character_count',
  'cached_vision_available',
  'cached_vision_fresh',
  'memory_match_count',
  'response_character_count',
  'ollama_total_duration',
  'ollama_load_duration',
  'ollama_prompt_eval_count',
  'ollama_prompt_eval_duration',
  'ollama_eval_count',
  'ollama_eval_duration',
  'ollama_done_reason',
  'tts_character_count',
  'audio_file_size_bytes'
]);

function safeEndpointIdentifier(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    const port = parsed.port ? ':' + parsed.port : '';
    return parsed.protocol + '//' + parsed.hostname + port;
  } catch (_error) {
    return String(value).replace(/\/\/[^/@\s]+@/g, '//[redacted]@').split('?')[0].slice(0, 300);
  }
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function sanitizeExtra(extra = {}) {
  const sanitized = {};
  for (const key of SAFE_EXTRA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(extra, key)) continue;
    const value = extra[key];
    if (key === 'configured_endpoint') {
      sanitized[key] = safeEndpointIdentifier(value);
    } else if (typeof value === 'string') {
      sanitized[key] = value.slice(0, 300);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function appendEvent(filePath, event, maxBytes = 8 * 1024 * 1024) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const stat = fs.statSync(filePath);
    if (stat.size >= maxBytes) {
      const rotated = filePath + '.1';
      try { fs.rmSync(rotated, { force: true }); } catch (_error) {}
      fs.renameSync(filePath, rotated);
    }
  } catch (_error) {}
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function createLatencyTrace(options = {}) {
  const startMonotonic = performance.now();
  let previousMonotonic = startMonotonic;
  let closed = false;
  const traceId = String(options.trace_id || 'latency_' + randomUUID());
  const turnId = String(options.turn_id || 'turn_' + randomUUID());
  const inputModality = String(options.input_modality || 'text');
  const events = [];
  const base = Object.freeze({
    configured_model: options.configured_model ? String(options.configured_model) : null,
    configured_endpoint: safeEndpointIdentifier(options.configured_endpoint),
    prompt_character_count: nonNegativeInteger(options.prompt_character_count),
    prompt_token_count: nonNegativeInteger(options.prompt_token_count),
    schema_enabled: options.schema_enabled === true,
    streaming_enabled: options.streaming_enabled === true,
    retry_count: nonNegativeInteger(options.retry_count) || 0
  });

  function emit(eventName, extra = {}) {
    if (!EVENT_SET.has(eventName)) {
      throw new Error('unknown latency event: ' + eventName);
    }
    if (closed && eventName !== 'response_interrupted' && eventName !== 'response_failed') {
      return null;
    }

    const now = performance.now();
    const event = Object.freeze({
      event: eventName,
      trace_id: traceId,
      turn_id: turnId,
      input_modality: inputModality,
      monotonic_timestamp_ms: Number(now.toFixed(3)),
      wall_clock_timestamp: new Date().toISOString(),
      elapsed_ms: Number((now - startMonotonic).toFixed(3)),
      elapsed_from_previous_ms: Number((now - previousMonotonic).toFixed(3)),
      ...base,
      ...sanitizeExtra(extra)
    });

    previousMonotonic = now;
    events.push(event);
    appendEvent(options.log_path, event, Number(options.max_log_bytes || 8 * 1024 * 1024));
    if (typeof options.on_event === 'function') options.on_event(event);

    if (eventName === 'response_completed' || eventName === 'response_interrupted' || eventName === 'response_failed') {
      closed = true;
    }
    return event;
  }

  return Object.freeze({
    trace_id: traceId,
    turn_id: turnId,
    input_modality: inputModality,
    emit,
    events: () => events.slice(),
    is_closed: () => closed,
    elapsed_ms: () => finiteOrNull(performance.now() - startMonotonic)
  });
}

module.exports = {
  EVENT_NAMES,
  SAFE_EXTRA_KEYS,
  safeEndpointIdentifier,
  sanitizeExtra,
  appendEvent,
  createLatencyTrace
};
