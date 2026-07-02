
'use strict';

const { getLiveChatConfig } = require('../../config/floki-config.cjs');
const { ensureApprovalToken } = require('../store.cjs');
const { loadSelfImprovementConfig } = require('../config.cjs');

async function request(method, pathname, body, timeoutMs) {
  const live = getLiveChatConfig('chat');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('http://' + live.runtime_host + ':' + String(live.runtime_port) + pathname, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; }
    catch (_error) { throw new Error('runtime returned invalid JSON for ' + pathname); }
    if (!response.ok || !payload || payload.ok === false) {
      throw new Error((payload && payload.error) || 'runtime request failed: ' + method + ' ' + pathname + ' status ' + response.status);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function authorizedBody(extra = {}, config = loadSelfImprovementConfig()) {
  return { ...extra, token: ensureApprovalToken(config) };
}

function enterTrainingResource(runId, config = loadSelfImprovementConfig()) {
  return request('POST', '/self-improvement/training-resource/enter', authorizedBody({ run_id: runId }, config), Number(config.runtime_transition_timeout_ms));
}

function exitTrainingResource(reason, config = loadSelfImprovementConfig()) {
  return request('POST', '/self-improvement/training-resource/exit', authorizedBody({ reason }, config), Number(config.wake_restoration_timeout_ms));
}

module.exports = { request, authorizedBody, enterTrainingResource, exitTrainingResource };
