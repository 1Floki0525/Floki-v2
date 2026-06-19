'use strict';
const assert = require('node:assert/strict');
const { createNdjsonParser, validateStreamEnvelope, buildGeneratePayload, generateJsonStream } = require('../src/model/ollama-client.cjs');

(function splitAndMultipleRecords() {
  const records = [];
  const parser = createNdjsonParser({ on_record: (record) => records.push(record) });
  parser.push('{"response":"{\\"public_response\\":\\"Hel');
  parser.push('lo.\\"}","done":false}\n{"response":"","done":true,"model":"synthetic-model","total_duration":10}\n');
  const ended = parser.end();
  assert.equal(records.length, 2);
  assert.equal(ended.records, 2);
  assert.equal(records[0].response, '{"public_response":"Hello."}');
})();

(function malformedEnvelopeRejected() {
  assert.throws(() => validateStreamEnvelope({ done: false }), /missing response string/);
  assert.throws(() => validateStreamEnvelope({ response: '', done: 'yes' }), /done must be boolean/);
})();

(function incompleteFinalLineRejected() {
  const parser = createNdjsonParser();
  parser.push('{"response":"unfinished"');
  assert.throws(() => parser.end(), (error) => error.code === 'OLLAMA_INCOMPLETE_FINAL_NDJSON_LINE');
})();

(function payloadModesRemainExplicit() {
  const base = { model: 'synthetic-model', prompt: 'test' };
  assert.equal(buildGeneratePayload(base).stream, false);
  assert.equal(buildGeneratePayload({ ...base, stream: true }).stream, true);
  assert.equal(buildGeneratePayload({ ...base, stream: true }).think, false);
})();

(async function mockedStreamPreservesStats() {
  let firstChunk = 0;
  const result = await generateJsonStream({
    endpoint: 'http://127.0.0.1:1', model: 'synthetic-model', prompt: 'synthetic prompt',
    response_schema: { type: 'object', required: ['public_response'], properties: { public_response: { type: 'string' } } },
    on_first_chunk: () => { firstChunk += 1; },
    post_json_stream: async (_url, payload, options) => {
      assert.equal(payload.stream, true);
      options.on_record({ response: '{"public_response":"Hello.', done: false });
      options.on_record({ response: '"}', done: false });
      options.on_record({ response: '', done: true, model: 'synthetic-model', total_duration: 123, load_duration: 4, prompt_eval_count: 5, prompt_eval_duration: 6, eval_count: 7, eval_duration: 8, done_reason: 'stop' });
      return { records: 3 };
    }
  });
  assert.equal(firstChunk, 1);
  assert.equal(result.response_json.public_response, 'Hello.');
  assert.equal(result.raw_stats.total_duration, 123);
  assert.equal(result.raw_stats.prompt_eval_count, 5);
  assert.equal(result.raw_stats.eval_count, 7);
  assert.equal(result.raw_stats.done_reason, 'stop');
  assert.equal(result.raw_stats.streaming, true);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    generateJsonStream({
      endpoint: 'http://127.0.0.1:1',
      model: 'synthetic-model',
      prompt: 'synthetic prompt',
      signal: controller.signal,
      post_json_stream: async (_url, _payload, options) => {
        if (options.signal && options.signal.aborted) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          error.code = 'OLLAMA_REQUEST_ABORTED';
          throw error;
        }
        throw new Error('signal was not forwarded');
      }
    }),
    (error) => error && (error.name === 'AbortError' || error.code === 'OLLAMA_REQUEST_ABORTED')
  );

  console.log('ollama-streaming-transport-contract-test PASS');
})().catch((error) => { console.error(error); process.exit(1); });
