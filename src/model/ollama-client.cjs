'use strict';

/**
 * Floki-v2 Ollama client.
 *
 * Uses Ollama /api/generate:
 * - stream:false
 * - format:"json" or a JSON schema object
 * - keep_alive
 * - think:false for chat cognition
 */

const http = require('node:http');
const https = require('node:https');

function postJson(urlString, payload, options = {}) {
  const url = new URL(urlString);
  const client = url.protocol === 'https:' ? https : http;
  const body = JSON.stringify(payload);
  const timeoutMs = options.timeout_ms || 120000;

  return new Promise((resolve, reject) => {
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
          reject(new Error('Ollama HTTP ' + res.statusCode + ': ' + raw.slice(0, 1000)));
          return;
        }

        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error('Ollama returned invalid JSON envelope: ' + error.message));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Ollama request timed out after ' + timeoutMs + 'ms'));
    });

    req.on('error', reject);
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
  if (!schema || typeof schema !== 'object') {
    return true;
  }

  const expectedType = schema.type;

  if (expectedType === 'object') {
    assertPlainObject(value, pathName);

    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new Error('JSON schema validation failed: missing required ' + pathName + '.' + key);
      }
    }

    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {};

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
    if (!Array.isArray(value)) {
      throw new Error('JSON schema validation failed: ' + pathName + ' must be array');
    }

    if (schema.items) {
      value.forEach((item, index) => {
        validateJsonSchemaShape(item, schema.items, pathName + '[' + index + ']');
      });
    }

    return true;
  }

  if (expectedType === 'string') {
    if (typeof value !== 'string') {
      throw new Error('JSON schema validation failed: ' + pathName + ' must be string');
    }

    return true;
  }

  if (expectedType === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new Error('JSON schema validation failed: ' + pathName + ' must be boolean');
    }

    return true;
  }

  if (expectedType === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error('JSON schema validation failed: ' + pathName + ' must be number');
    }

    return true;
  }

  if (expectedType === 'integer') {
    if (!Number.isInteger(value)) {
      throw new Error('JSON schema validation failed: ' + pathName + ' must be integer');
    }

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

  if (typeof input.num_predict === 'number') {
    options.num_predict = input.num_predict;
  }

  return {
    model: input.model,
    prompt: input.prompt,
    system: input.system || '',
    stream: false,
    format: input.format_schema ? cloneJson(input.format_schema) : (input.format || 'json'),
    keep_alive: input.keep_alive || '24h',
    think: input.think === true,
    options
  };
}

async function generateJson(input) {
  if (!input || typeof input !== 'object') throw new TypeError('generateJson input must be an object');
  if (!input.endpoint) throw new TypeError('endpoint is required');

  const endpoint = input.endpoint.replace(/\/$/, '') + '/api/generate';
  const payload = buildGeneratePayload(input);

  const raw = await postJson(endpoint, payload, { timeout_ms: input.timeout_ms || 120000 });

  if (!raw || typeof raw.response !== 'string') {
    throw new Error('Ollama response missing response string');
  }

  const parsed = safeJsonParseModelResponse(raw.response);

  if (input.response_schema) {
    validateJsonSchemaShape(parsed, input.response_schema, 'response');
  }

  return {
    ok: true,
    model: raw.model || input.model,
    created_at: raw.created_at || null,
    response_json: parsed,
    raw_stats: {
      done: raw.done === true,
      done_reason: raw.done_reason || null,
      total_duration: raw.total_duration || null,
      load_duration: raw.load_duration || null,
      prompt_eval_count: raw.prompt_eval_count || null,
      eval_count: raw.eval_count || null,
      eval_duration: raw.eval_duration || null,
      schema_constrained_json: Boolean(input.format_schema)
    }
  };
}

module.exports = {
  postJson,
  assertPlainObject,
  rejectPrivateReasoningMarkers,
  safeJsonParseModelResponse,
  validateJsonSchemaShape,
  buildGeneratePayload,
  generateJson
};
