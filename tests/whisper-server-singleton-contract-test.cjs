'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.join(ROOT, 'src/senses/live-whisper-service.cjs'),
  'utf8'
);

const {
  getAudioConfig,
  getSelfImprovementConfig
} = require('../src/config/floki-config.cjs');

const audio = getAudioConfig('chat');
assert.equal(audio.whisper_singleton_enforced, true);
assert.equal(
  typeof audio.whisper_singleton_lock_file,
  'string'
);
assert.equal(typeof audio.whisper_process_root, 'string');
assert.equal(typeof audio.whisper_server_probe_path, 'string');
assert.equal(
  typeof audio.whisper_server_probe_timeout_ms,
  'number'
);
assert.equal(
  typeof audio.whisper_server_probe_request_timeout_ms,
  'number'
);
assert.equal(
  typeof audio.whisper_server_probe_poll_ms,
  'number'
);
assert.equal(
  typeof audio.whisper_process_stop_timeout_ms,
  'number'
);
assert.equal(
  typeof audio.whisper_process_stop_poll_ms,
  'number'
);
assert.equal(typeof audio.whisper_error_tail_chars, 'number');

assert.match(source, /sharedStartPromise/);
assert.match(source, /acquireWhisperOwnership/);
assert.match(source, /discoverWhisperServerProcessIds/);
assert.match(source, /terminateWhisperProcesses/);
assert.match(source, /whisper_singleton_lock_file/);
assert.match(source, /sharedReferences/);
assert.match(source, /server_process_count/);

const selfImprovement = getSelfImprovementConfig('chat');
assert.equal(
  typeof selfImprovement.model_proxy_connection_header,
  'string'
);
assert.equal(
  typeof selfImprovement.model_request_max_bytes,
  'number'
);

const proxy = fs.readFileSync(
  path.join(ROOT, 'src/self-improvement/model-proxy.cjs'),
  'utf8'
);
assert.match(proxy, /collectRequestBody/);
assert.match(proxy, /resolved\.model_request_max_bytes/);
assert.match(proxy, /upstream\.end\(body\)/);
assert.match(
  proxy,
  /resolved\.model_proxy_connection_header/
);

const agent = fs.readFileSync(
  path.join(
    ROOT,
    'containers/self-improvement/agent.cjs'
  ),
  'utf8'
);
assert.match(agent, /MODEL_REQUEST_MAX_BYTES/);
assert.match(agent, /MODEL_PROXY_CONNECTION_HEADER/);
assert.match(
  agent,
  /request\.end\(body === null \? undefined : body\)/
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_WHISPER_EXACT_STATE_CONTRACT_PASS'
}, null, 2));
