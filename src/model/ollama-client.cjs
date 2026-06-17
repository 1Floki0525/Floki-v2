'use strict';

/**
 * Floki-v2 Ollama client.
 *
 * Uses current Ollama /api/generate shape:
 * - stream:false
 * - format:"json"
 * - keep_alive
 * - think for thinking models
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
          reject(new Error('Ollama HTTP ' + res.statusCode + ': ' + raw.slice(0, 500)));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error('Ollama returned invalid JSON: ' + error.message));
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
      return JSON.parse(responseText.slice(first, last + 1));
    }
    throw new Error('model response was not parseable JSON: ' + error.message);
  }
}

async function generateJson(input) {
  if (!input || typeof input !== 'object') throw new TypeError('generateJson input must be an object');
  if (!input.endpoint) throw new TypeError('endpoint is required');
  if (!input.model) throw new TypeError('model is required');
  if (!input.prompt) throw new TypeError('prompt is required');

  const endpoint = input.endpoint.replace(/\/$/, '') + '/api/generate';

  const payload = {
    model: input.model,
    prompt: input.prompt,
    system: input.system || '',
    stream: false,
    format: 'json',
    keep_alive: input.keep_alive || '24h',
    think: input.think === true,
    options: {
      temperature: typeof input.temperature === 'number' ? input.temperature : 0.55,
      top_p: typeof input.top_p === 'number' ? input.top_p : 0.9
    }
  };

  const raw = await postJson(endpoint, payload, { timeout_ms: input.timeout_ms || 120000 });
  if (!raw || typeof raw.response !== 'string') {
    throw new Error('Ollama response missing response string');
  }

  const parsed = safeJsonParseModelResponse(raw.response);

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
      eval_duration: raw.eval_duration || null
    }
  };
}

module.exports = {
  postJson,
  rejectPrivateReasoningMarkers,
  safeJsonParseModelResponse,
  generateJson
};
