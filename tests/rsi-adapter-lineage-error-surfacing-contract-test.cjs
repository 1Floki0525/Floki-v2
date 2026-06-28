'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  listAdapters,
  readLineageManifest
} = require('../src/self-improvement/training/lineage.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-lineage-errors-'));
const adapter = path.join(root, 'adapter-v1');
fs.mkdirSync(adapter, { recursive: true });
const manifest = path.join(adapter, 'lineage.json');
fs.writeFileSync(manifest, '{not json}\n');

const config = {
  adapter_root: root,
  adapter_manifest_file_name: 'lineage.json'
};

assert.throws(
  () => readLineageManifest(manifest),
  /FLOKI_ADAPTER_LINEAGE_READ_FAILED/
);
assert.throws(
  () => listAdapters(config),
  /FLOKI_ADAPTER_LINEAGE_READ_FAILED/
);

fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_ADAPTER_LINEAGE_ERROR_SURFACING_PASS',
  malformed_lineage_not_silenced: true
}, null, 2));
