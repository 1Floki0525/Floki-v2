'use strict';

/**
 * Floki-v2 Ollama client.
 *
 * Non-streaming remains the default for existing vision, dream, and other
 * callers. Chat cognition opts into stream:true explicitly.
 */

const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');

function abortError(message = 'Ollama request aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'OLLAMA_REQUEST_ABORTED';
  return error;
}

function postJson(urlString, payload, options = {}) {
  const url = new URL(urlString);
  const client = url.protocol === 'https:' ? https : http;
  const body = JSON.stringify(payload);
  const timeoutMs = options.timeout_ms || 120000;
  const signal = options.signal;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }

    let settled = false;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = client.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error('Ollama HTTP ' + res.statusCode + ': ' + raw.slice(0, 1000));
          error.code = 'OLLAMA_HTTP_ERROR';
          error.status_code = res.statusCode;
          finishReject(error);
          return;
        }

        try {
          finishResolve(JSON.parse(raw));
        } catch (error) {
          const wrapped = new Error('Ollama returned invalid JSON envelope: ' + error.message);
          wrapped.code = 'OLLAMA_INVALID_JSON_ENVELOPE';
          finishReject(wrapped);
        }
      });
    });

    const onAbort = () => req.destroy(abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    req.on('timeout', () => {
      const error = new Error('Ollama request timed out after ' + timeoutMs + 'ms');
      error.code = 'OLLAMA_REQUEST_TIMEOUT';
      req.destroy(error);
    });
    req.on('error', (error) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      finishReject(error);
    });
    req.on('close', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    });
    req.write(body);
    req.end();
  });
}

function assertPlainObject(value, fieldName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(fieldName + ' must be a plain object');
  }
}

function rejectPrivateReasoningMarkers(value, fieldName = 'model output') {
  const lower = String(value || '').toLowerCase();
  const markers = ['<think>', '</think>', 'chain_of_thought', 'hidden_reasoning', 'raw_reasoning', 'scratchpad'];

  for (const marker of markers) {
    if (lower.includes(marker)) {
      throw new Error(fieldName + ' contains banned private-reasoning marker: ' + marker);
    }
  }

  return true;
}

function safeJsonParseModelResponse(responseText) {
  rejectPrivateReasoningMarkers(responseText, 'model response');

  try {
    return JSON.parse(responseText);
  } catch (error) {
    const first = responseText.indexOf('{');
    const last = responseText.lastIndexOf('}');

    if (first >= 0 && last > first) {
      try {
        return JSON.parse(responseText.slice(first, last + 1));
      } catch (inner) {
        throw new Error('model response was not parseable JSON: ' + inner.message);
      }
    }

    throw new Error('model response was not parseable JSON: ' + error.message);
  }
}

function validateJsonSchemaShape(value, schema, pathName = 'response') {
  if (!schema || typeof schema !== 'object') return true;

  const expectedType = schema.type;

  if (expectedType === 'object') {
    assertPlainObject(value, pathName);
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new Error('JSON schema validation failed: missing required ' + pathName + '.' + key);
      }
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          throw new Error('JSON schema validation failed: unexpected property ' + pathName + '.' + key);
        }
      }
    }
    for (const key of Object.keys(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateJsonSchemaShape(value[key], properties[key], pathName + '.' + key);
      }
    }
    return true;
  }

  if (expectedType === 'array') {
    if (!Array.isArray(value)) throw new Error('JSON schema validation failed: ' + pathName + ' must be array');
    if (schema.items) value.forEach((item, index) => validateJsonSchemaShape(item, schema.items, pathName + '[' + index + ']'));
    return true;
  }

  if (expectedType === 'string') {
    if (typeof value !== 'string') throw new Error('JSON schema validation failed: ' + pathName + ' must be string');
    return true;
  }
  if (expectedType === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('JSON schema validation failed: ' + pathName + ' must be boolean');
    return true;
  }
  if (expectedType === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) throw new Error('JSON schema validation failed: ' + pathName + ' must be number');
    return true;
  }
  if (expectedType === 'integer') {
    if (!Number.isInteger(value)) throw new Error('JSON schema validation failed: ' + pathName + ' must be integer');
    return true;
  }
  return true;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildGeneratePayload(input) {
  if (!input || typeof input !== 'object') throw new TypeError('generateJson input must be an object');
  if (!input.model) throw new TypeError('model is required');
  if (!input.prompt) throw new TypeError('prompt is required');

  const options = {
    temperature: typeof input.temperature === 'number' ? input.temperature : 0.1,
    top_p: typeof input.top_p === 'number' ? input.top_p : 0.3
  };
  if (typeof input.num_predict === 'number') options.num_predict = input.num_predict;

  return {
    model: input.model,
    prompt: input.prompt,
    system: input.system || '',
    stream: input.stream === true,
    format: input.format_schema ? cloneJson(input.format_schema) : (input.format || 'json'),
    keep_alive: input.keep_alive || '24h',
    think: input.think === true,
    options
  };
}

function validateStreamEnvelope(envelope) {
  assertPlainObject(envelope, 'Ollama NDJSON envelope');
  if (typeof envelope.response !== 'string') {
    const error = new Error('Ollama NDJSON envelope missing response string');
    error.code = 'OLLAMA_MALFORMED_NDJSON_ENVELOPE';
    throw error;
  }
  if (Object.prototype.hasOwnProperty.call(envelope, 'done') && typeof envelope.done !== 'boolean') {
    const error = new Error('Ollama NDJSON envelope done must be boolean');
    error.code = 'OLLAMA_MALFORMED_NDJSON_ENVELOPE';
    throw error;
  }
  return envelope;
}

function createNdjsonParser(options = {}) {
  let buffer = '';
  let ended = false;
  let recordCount = 0;

  function parseLine(line) {
    if (!line.trim()) return;
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch (error) {
      const wrapped = new Error('Ollama returned malformed NDJSON: ' + error.message);
      wrapped.code = 'OLLAMA_MALFORMED_NDJSON';
      throw wrapped;
    }
    validateStreamEnvelope(envelope);
    recordCount += 1;
    if (typeof options.on_record === 'function') options.on_record(envelope);
  }

  function push(chunk) {
    if (ended) throw new Error('cannot push NDJSON after parser end');
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      parseLine(line);
    }
  }

  function end() {
    if (ended) return Object.freeze({ records: recordCount, trailing_buffer: '' });
    ended = true;
    const trailing = buffer;
    buffer = '';
    if (trailing.trim()) {
      try {
        parseLine(trailing.replace(/\r$/, ''));
      } catch (error) {
        if (error.code === 'OLLAMA_MALFORMED_NDJSON') {
          const wrapped = new Error('Ollama stream ended with incomplete or malformed final NDJSON line');
          wrapped.code = 'OLLAMA_INCOMPLETE_FINAL_NDJSON_LINE';
          throw wrapped;
        }
        throw error;
      }
    }
    return Object.freeze({ records: recordCount, trailing_buffer: '' });
  }

  return Object.freeze({ push, end, get_buffer: () => buffer, get_record_count: () => recordCount });
}

function postJsonStream(urlString, payload, options = {}) {
  const url = new URL(urlString);
  const client = url.protocol === 'https:' ? https : http;
  const body = JSON.stringify(payload);
  const timeoutMs = options.timeout_ms || 120000;
  const signal = options.signal;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }

    let settled = false;
    let responseStarted = false;
    const parser = createNdjsonParser({ on_record: options.on_record });
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = client.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        accept: 'application/x-ndjson'
      },
      timeout: timeoutMs
    }, (res) => {
      responseStarted = true;
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          const error = new Error('Ollama HTTP ' + res.statusCode + ': ' + raw.slice(0, 1000));
          error.code = 'OLLAMA_HTTP_ERROR';
          error.status_code = res.statusCode;
          finishReject(error);
        });
        return;
      }

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (signal && signal.aborted) return;
        try {
          parser.push(chunk);
        } catch (error) {
          req.destroy(error);
        }
      });
      res.on('end', () => {
        try {
          const ended = parser.end();
          finishResolve(ended);
        } catch (error) {
          finishReject(error);
        }
      });
      res.on('error', finishReject);
    });

    const onAbort = () => req.destroy(abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    req.on('timeout', () => {
      const error = new Error('Ollama streaming request timed out after ' + timeoutMs + 'ms');
      error.code = 'OLLAMA_REQUEST_TIMEOUT';
      req.destroy(error);
    });
    req.on('error', (error) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      finishReject(error);
    });
    req.on('close', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!settled && !responseStarted && signal && signal.aborted) finishReject(abortError());
    });
    req.write(body);
    req.end();
  });
}

function statsFromEnvelope(raw, input, extra = {}) {
  return {
    done: raw && raw.done === true,
    done_reason: raw && raw.done_reason ? raw.done_reason : null,
    total_duration: raw && raw.total_duration !== undefined ? raw.total_duration : null,
    load_duration: raw && raw.load_duration !== undefined ? raw.load_duration : null,
    prompt_eval_count: raw && raw.prompt_eval_count !== undefined ? raw.prompt_eval_count : null,
    prompt_eval_duration: raw && raw.prompt_eval_duration !== undefined ? raw.prompt_eval_duration : null,
    eval_count: raw && raw.eval_count !== undefined ? raw.eval_count : null,
    eval_duration: raw && raw.eval_duration !== undefined ? raw.eval_duration : null,
    keep_alive: input.keep_alive || '24h',
    think: input.think === true,
    endpoint: input.endpoint,
    configured_model: input.model,
    schema_constrained_json: Boolean(input.format_schema),
    ...extra
  };
}

async function generateJson(input) {
  if (!input || typeof input !== 'object') throw new TypeError('generateJson input must be an object');
  if (!input.endpoint) throw new TypeError('endpoint is required');

  const endpoint = input.endpoint.replace(/\/$/, '') + '/api/generate';
  const payload = buildGeneratePayload({ ...input, stream: false });
  const transport = input.post_json || postJson;
  const raw = await transport(endpoint, payload, { timeout_ms: input.timeout_ms || 120000, signal: input.signal });

  if (!raw || typeof raw.response !== 'string') throw new Error('Ollama response missing response string');
  const parsed = safeJsonParseModelResponse(raw.response);
  if (input.response_schema) validateJsonSchemaShape(parsed, input.response_schema, 'response');

  return {
    ok: true,
    model: raw.model || input.model,
    created_at: raw.created_at || null,
    response_json: parsed,
    response_text: raw.response,
    raw_stats: statsFromEnvelope(raw, input, { streaming: false, first_chunk_ms: null, final_output_ms: null })
  };
}

async function generateJsonStream(input) {
  if (!input || typeof input !== 'object') throw new TypeError('generateJsonStream input must be an object');
  if (!input.endpoint) throw new TypeError('endpoint is required');
  if (input.signal && input.signal.aborted) throw abortError();

  const endpoint = input.endpoint.replace(/\/$/, '') + '/api/generate';
  const payload = buildGeneratePayload({ ...input, stream: true });
  const transport = input.post_json_stream || postJsonStream;
  const startedAt = performance.now();
  let firstChunkMs = null;
  let outputText = '';
  let finalEnvelope = null;
  let envelopeCount = 0;
  let stopped = false;

  await transport(endpoint, payload, {
    timeout_ms: input.timeout_ms || 120000,
    signal: input.signal,
    on_record(envelope) {
      if (stopped || (input.signal && input.signal.aborted)) return;
      envelopeCount += 1;
      if (envelope.response.length > 0) {
        if (firstChunkMs === null) {
          firstChunkMs = performance.now() - startedAt;
          if (typeof input.on_first_chunk === 'function') {
            input.on_first_chunk(Object.freeze({ elapsed_ms: firstChunkMs, envelope_index: envelopeCount }));
          }
        }
        outputText += envelope.response;
        if (typeof input.on_response_fragment === 'function') {
          input.on_response_fragment(Object.freeze({
            fragment: envelope.response,
            accumulated_length: outputText.length,
            envelope_index: envelopeCount
          }));
        }
      }
      if (envelope.done === true) finalEnvelope = envelope;
    }
  });

  stopped = true;
  if (input.signal && input.signal.aborted) throw abortError();
  if (!finalEnvelope || finalEnvelope.done !== true) {
    const error = new Error('Ollama streaming response ended without a final done envelope');
    error.code = 'OLLAMA_STREAM_MISSING_DONE';
    throw error;
  }

  const parsed = safeJsonParseModelResponse(outputText);
  if (input.response_schema) validateJsonSchemaShape(parsed, input.response_schema, 'response');
  const finalOutputMs = performance.now() - startedAt;

  return {
    ok: true,
    model: finalEnvelope.model || input.model,
    created_at: finalEnvelope.created_at || null,
    response_json: parsed,
    response_text: outputText,
    raw_stats: statsFromEnvelope(finalEnvelope, input, {
      streaming: true,
      first_chunk_ms: firstChunkMs,
      final_output_ms: finalOutputMs,
      ndjson_envelope_count: envelopeCount
    })
  };
}

module.exports = {
  abortError,
  postJson,
  postJsonStream,
  assertPlainObject,
  rejectPrivateReasoningMarkers,
  safeJsonParseModelResponse,
  validateJsonSchemaShape,
  cloneJson,
  buildGeneratePayload,
  validateStreamEnvelope,
  createNdjsonParser,
  statsFromEnvelope,
  generateJson,
  generateJsonStream
};
