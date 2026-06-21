'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const worker = fs.readFileSync(
  path.join(
    root,
    '.floki-tools/grounding-dino/grounding-dino-worker.py'
  ),
  'utf8'
);

assert.match(worker, /torch\.is_floating_point\(value\)/);
assert.match(
  worker,
  /value\.to\(device=DEVICE,\s*dtype=DTYPE\)/
);
assert.match(worker, /else value\.to\(device=DEVICE\)/);
assert.doesNotMatch(
  worker,
  /key:\s*value\.to\(DEVICE\)\s*if\s*hasattr/
);
assert.match(
  worker,
  /DTYPE\s*=\s*torch\.float16\s*if\s*DEVICE\.type\s*==\s*"cuda"/
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_GROUNDING_DINO_DTYPE_CONTRACT_PASS',
  floating_inputs_match_model_dtype: true,
  integer_and_boolean_inputs_preserved: true,
  component_fallbacks_allowed: false,
  live_services_started_by_test: false
}, null, 2));
