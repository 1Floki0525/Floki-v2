'use strict';

const path = require('node:path');
const { runConfiguredKnowledgeAutoload } = require('./knowledge-autoload.cjs');

function send(message) {
  if (typeof process.send !== 'function') return Promise.resolve();
  return new Promise((resolve) => process.send(message, resolve));
}

async function main() {
  const rawRuntimeDir = String(process.env.FLOKI_KNOWLEDGE_RUNTIME_DIR || '').trim();
  if (!rawRuntimeDir) throw new Error('FLOKI_KNOWLEDGE_RUNTIME_DIR is required');
  const runtimeDir = path.resolve(rawRuntimeDir);
  try {
    const result = runConfiguredKnowledgeAutoload({ runtime_dir: runtimeDir });
    await send({ type: 'knowledge-autoload-complete', result });
    if (process.connected) process.disconnect();
    process.exitCode = 0;
  } catch (error) {
    await send({
      type: 'knowledge-autoload-error',
      error: error && (error.stack || error.message) ? (error.stack || error.message) : String(error)
    });
    if (process.connected) process.disconnect();
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    await send({ type: 'knowledge-autoload-error', error: error.stack || error.message });
    if (process.connected) process.disconnect();
    process.exitCode = 1;
  });
}

module.exports = { main };
