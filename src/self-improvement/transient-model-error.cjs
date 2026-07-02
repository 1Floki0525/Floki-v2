'use strict';

const RETRYABLE_HTTP_STATUS = new Set([502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EUPSTREAM',
  'EUPSTREAM_PARSE'
]);

function isMalformedUpstreamMessage(message) {
  return /XML syntax error|unexpected EOF|invalid JSON|malformed upstream|malformed model|unterminated string|unexpected end of json input/i
    .test(String(message || ''));
}

function createHttpModelError(statusCode, message) {
  const status = Number(statusCode || 0);
  const error = new Error(
    String(message || ('model request failed with HTTP ' + status))
  );
  error.statusCode = status;
  if (/timed?\s*out|timeout/i.test(error.message)) {
    error.code = 'ETIMEDOUT';
  } else if (isMalformedUpstreamMessage(error.message)) {
    error.code = 'EUPSTREAM_PARSE';
  } else if (RETRYABLE_HTTP_STATUS.has(status)) {
    error.code = 'EUPSTREAM';
  }
  return error;
}

// Caller (containers/self-improvement/agent.cjs, retryOrReject):
//   const transportRetry = error.code==='EPIPE'||error.code==='ECONNRESET'||error.code==='ETIMEDOUT';
//   if (retriesLeft > 0 && (transportRetry || isRetryableModelError(error))) { retry; }
//   else { reject(error); }  // exhausted — exits through controlled failure path
function isRetryableModelError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = String(error.code || '');
  const status = Number(error.statusCode || error.status || 0);
  const message = String(error.message || '');
  return (
    RETRYABLE_CODES.has(code) ||
    RETRYABLE_HTTP_STATUS.has(status) ||
    /timed?\s*out|timeout|temporarily unavailable|connection reset|broken pipe/i.test(message) ||
    isMalformedUpstreamMessage(message)
  );
}

module.exports = {
  createHttpModelError,
  isRetryableModelError,
  isMalformedUpstreamMessage
};
