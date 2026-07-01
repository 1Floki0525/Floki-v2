'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nodeMajor = Number(process.versions.node.split('.')[0]);
assert.equal(Number.isInteger(nodeMajor) && nodeMajor >= 24, true, 'Node 24 or newer is required');

const {
  jsonlFileSize,
  readJsonlActivityChunk
} = require('../src/runtime/chat-local-runtime.cjs');
const {
  getSelfImprovementConfig
} = require('../src/config/floki-config.cjs');

async function main() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'floki-rsi-activity-stream-')
  );
  const file = path.join(root, 'audit.jsonl');

  try {
    const records = Array.from({ length: 40 }, (_, index) => ({
      marker: 'FLOKI_TEST_ACTIVITY',
      created_at: new Date(1700000000000 + index).toISOString(),
      type: 'event_' + index,
      detail: { index, payload: 'x'.repeat(80) }
    }));
    fs.writeFileSync(
      file,
      records.map((record) => JSON.stringify(record)).join('\n') + '\n'
    );

    const config = getSelfImprovementConfig('chat');
    assert.ok(config.activity_stream_max_bytes >= 4096);
    assert.ok(config.activity_stream_max_events >= 1);

    const totalSize = await jsonlFileSize(file);
    assert.equal(totalSize, fs.statSync(file).size);

    let cursor = 0;
    const observed = [];
    let guard = 0;
    while (cursor < totalSize) {
      guard += 1;
      assert.ok(guard < 100, 'activity cursor must make bounded progress');
      const chunk = await readJsonlActivityChunk(file, cursor, {
        source: 'controller',
        max_bytes: 4096,
        max_events: 3
      });
      assert.ok(chunk.events.length <= 3);
      assert.ok(chunk.next_cursor > cursor);
      for (const event of chunk.events) {
        observed.push(event.record.detail.index);
        assert.equal(event.source, 'controller');
        assert.ok(Number.isSafeInteger(event.index));
      }
      cursor = chunk.next_cursor;
    }

    assert.deepEqual(observed, records.map((record) => record.detail.index));

    const beforePartial = await jsonlFileSize(file);
    fs.appendFileSync(file, '{"type":"partial"');
    const partial = await readJsonlActivityChunk(file, beforePartial, {
      source: 'controller',
      max_bytes: 4096,
      max_events: 10
    });
    assert.equal(partial.events.length, 0);
    assert.equal(
      partial.next_cursor,
      beforePartial,
      'incomplete JSONL records must not be consumed'
    );

    fs.appendFileSync(file, ',"detail":{"ok":true}}\n');
    const completed = await readJsonlActivityChunk(file, beforePartial, {
      source: 'controller',
      max_bytes: 4096,
      max_events: 10
    });
    assert.equal(completed.events.length, 1);
    assert.equal(completed.events[0].record.type, 'partial');
    assert.equal(completed.events[0].record.detail.ok, true);

    const rotated = await readJsonlActivityChunk(file, totalSize * 100, {
      source: 'controller',
      max_bytes: 4096,
      max_events: 1
    });
    assert.equal(rotated.cursor_reset, true);
    assert.equal(rotated.events.length, 1);

    const runtimeSource = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        'src/runtime/chat-local-runtime.cjs'
      ),
      'utf8'
    );
    const route = runtimeSource.slice(
      runtimeSource.indexOf(
        "url.pathname === '/self-improvement/activity'"
      ),
      runtimeSource.indexOf(
        "url.pathname === '/speak'"
      )
    );
    assert.doesNotMatch(route, /readFileSync/);
    assert.match(route, /Promise\.all/);
    assert.match(route, /cursor_mode: 'byte_offset'/);

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_RSI_ACTIVITY_STREAM_BOUNDED_PASS',
      byte_offset_cursor: true,
      asynchronous_file_reads: true,
      whole_file_polling_removed: true,
      incomplete_record_preserved: true,
      rotation_recovery: true
    }, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
