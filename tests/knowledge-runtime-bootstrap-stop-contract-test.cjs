
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createKnowledgeRuntimeBootstrap
} = require('../src/chat/knowledge-runtime-bootstrap.cjs');

function fakeWorker(exitDelayMs) {
  const worker = new EventEmitter();
  worker.connected = true;
  worker.killed = false;
  worker.disconnect = () => {
    worker.connected = false;
  };
  worker.kill = (signal) => {
    worker.killed = true;
    setTimeout(() => worker.emit('exit', null, signal), exitDelayMs);
    return true;
  };
  return worker;
}

(async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'floki-knowledge-bootstrap-stop-')
  );
  try {
    const knowledgeRoot = path.join(root, 'knowledge');
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(knowledgeRoot, 'chunks.jsonl'),
      JSON.stringify({ chunk_id: 'chunk-1', text: 'ready' }) + '\n'
    );
    fs.writeFileSync(
      path.join(knowledgeRoot, 'index.json'),
      JSON.stringify({
        ok: true,
        source_count_total: 1,
        chunk_count_total: 1
      }) + '\n'
    );

    const workers = [fakeWorker(20), fakeWorker(40)];
    const updates = [];
    const bootstrap = createKnowledgeRuntimeBootstrap({
      fork_worker: () => workers.shift()
    });

    bootstrap.start({
      knowledge_root: knowledgeRoot,
      runtime_dir: path.join(root, 'runtime-one'),
      on_update(update) {
        updates.push(update);
      }
    });
    assert.equal(bootstrap.running(), true);
    assert.equal(await bootstrap.stopAndWait(), true);
    assert.equal(bootstrap.running(), false);

    const second = bootstrap.start({
      knowledge_root: knowledgeRoot,
      runtime_dir: path.join(root, 'runtime-two'),
      on_update(update) {
        updates.push(update);
      }
    });
    second.worker.emit('message', {
      type: 'knowledge-autoload-complete',
      result: {
        ok: true,
        marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_PASS'
      }
    });
    second.worker.emit('exit', 0, null);

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(
      updates.some((update) => update.phase === 'failed'),
      false
    );
    assert.equal(
      updates.some((update) => update.error && /SIGTERM/.test(update.error)),
      false
    );
    assert.equal(
      updates.some((update) => update.phase === 'complete' && update.ready === true),
      true
    );
    assert.equal(bootstrap.running(), false);

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_KNOWLEDGE_BOOTSTRAP_EXPECTED_STOP_PASS',
      expected_sigterm_not_reported_as_failure: true,
      stale_worker_exit_did_not_poison_next_run: true,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_KNOWLEDGE_BOOTSTRAP_EXPECTED_STOP_FAIL',
    error: error.stack || error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
