'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
  createHttpModelError,
  isRetryableModelError
} = require(path.join(root, 'src/self-improvement/transient-model-error.cjs'));

const timeout = createHttpModelError(502, 'model proxy upstream request timed out');
assert.equal(timeout.code, 'ETIMEDOUT');
assert.equal(timeout.statusCode, 502);
assert.equal(isRetryableModelError(timeout), true);
assert.equal(isRetryableModelError(createHttpModelError(503, 'unavailable')), true);
assert.equal(isRetryableModelError(createHttpModelError(504, 'gateway timeout')), true);
assert.equal(isRetryableModelError(createHttpModelError(400, 'bad request')), false);
const malformed = createHttpModelError(502, 'XML syntax error on line 96: unexpected EOF');
assert.equal(malformed.code, 'EUPSTREAM_PARSE');
assert.equal(isRetryableModelError(malformed), true);
assert.equal(isRetryableModelError(Object.assign(
  new Error('Ollama returned invalid JSON: Unexpected end of JSON input'),
  { code: 'EUPSTREAM_PARSE' }
)), true);
assert.equal(isRetryableModelError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
const dnsRetry = Object.assign(
  new Error('getaddrinfo EAI_AGAIN host.docker.internal'),
  { code: 'EAI_AGAIN', syscall: 'getaddrinfo' }
);
assert.equal(isRetryableModelError(dnsRetry), true);

const agent = fs.readFileSync(
  path.join(root, 'containers/self-improvement/agent.cjs'),
  'utf8'
);
const worker = fs.readFileSync(
  path.join(root, 'src/self-improvement/worker.cjs'),
  'utf8'
);
assert.match(agent, /model_turn_failure/);
assert.match(agent, /consecutiveModelTurnFailures \+= 1/);
assert.match(agent, /retryable: isRetryableModelError\(error\)/);
assert.match(agent, /EUPSTREAM_PARSE/);
assert.match(agent, /Ollama returned invalid JSON/);
assert.match(agent, /continue from the current convergence/);
assert.match(agent, /FLOKI_V2_SELF_IMPROVEMENT_SANDBOX_NO_CANDIDATE/);
assert.match(agent, /finishWithoutCandidate/);
assert.match(worker, /exit\.code === 0 && isNoCandidateSandboxFailure/);
assert.match(worker, /FLOKI_V2_SELF_IMPROVEMENT_SANDBOX_NO_CANDIDATE/i);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_MODEL_TIMEOUT_RECOVERY_CONTRACT_PASS',
  retryable_http_statuses: [502, 503, 504],
  retryable_codes: ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'],
  controlled_no_candidate_exit: true
}, null, 2));
