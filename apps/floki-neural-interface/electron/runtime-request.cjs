'use strict';

function errorCode(error) {
  let current = error;
  const seen = new Set();

  while (
    current &&
    typeof current === 'object' &&
    !seen.has(current)
  ) {
    seen.add(current);

    if (
      typeof current.code === 'string' &&
      current.code
    ) {
      return current.code;
    }

    current = current.cause;
  }

  return null;
}

function transient(error) {
  const code = errorCode(error);

  return code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ECONNABORTED' ||
    code === 'UND_ERR_SOCKET';
}

function createRuntimeRequest(options = {}) {
  const baseUrl =
    String(options.base_url || '')
      .replace(/\/$/, '');

  const timeoutMs =
    Number(options.timeout_ms);

  const fetchImpl =
    options.fetch_impl ||
    globalThis.fetch;

  if (!baseUrl) {
    throw new Error(
      'runtime request base_url is required'
    );
  }

  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error(
      'runtime request timeout_ms must be ' +
      'a positive YAML-resolved number'
    );
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'runtime request fetch implementation ' +
      'is required'
    );
  }

  async function execute(
    method,
    pathname,
    body,
    timeoutOverrideMs
  ) {
    const hasBody = body !== null;

    const effectiveTimeoutMs =
      Number.isFinite(timeoutOverrideMs) && timeoutOverrideMs > 0
        ? timeoutOverrideMs
        : timeoutMs;

    const response =
      await fetchImpl(
        baseUrl + pathname,
        {
          method,

          headers: {
            connection: 'close',

            ...(hasBody
              ? {
                  'content-type':
                    'application/json'
                }
              : {})
          },

          body: hasBody
            ? JSON.stringify(body)
            : undefined,

          signal:
            AbortSignal.timeout(
              effectiveTimeoutMs
            )
        }
      );

    const raw =
      await response.text();

    let payload = {};

    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        throw new Error(
          'authoritative runtime returned ' +
          'invalid JSON: ' +
          error.message
        );
      }
    }

    if (!response.ok) {
      throw new Error(
        payload.error ||
        'runtime HTTP ' +
        String(response.status)
      );
    }

    return payload;
  }

  return async function runtimeRequest(
    method,
    pathname,
    body = null,
    timeoutOverrideMs = null
  ) {
    try {
      return await execute(
        method,
        pathname,
        body,
        timeoutOverrideMs
      );
    } catch (error) {
      if (
        method !== 'GET' ||
        !transient(error)
      ) {
        throw error;
      }

      return execute(
        method,
        pathname,
        body,
        timeoutOverrideMs
      );
    }
  };
}

module.exports = {
  errorCode,
  transient,
  createRuntimeRequest
};
