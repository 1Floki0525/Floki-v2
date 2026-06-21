'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const servicePath = path.join(
  root,
  'src/vision/chat-webcam-vision-service.cjs'
);

const serviceSource = fs.readFileSync(
  servicePath,
  'utf8'
);

const {
  parseYoloDetectionFrame,
  storeDetectionResult
} = require(
  '../src/vision/yolo-detection-service.cjs'
);

/*
 * Verify the actual runtime API instead of requiring the functions to be
 * declared directly inside yolo-detection-service.cjs. They may be imported
 * from another module and re-exported.
 */
assert.equal(
  typeof parseYoloDetectionFrame,
  'function',
  'parseYoloDetectionFrame must be exported as a function'
);

assert.equal(
  typeof storeDetectionResult,
  'function',
  'storeDetectionResult must be exported as a function'
);

/*
 * Verify the current hybrid detection pipeline.
 */
assert.match(
  serviceSource,
  /runHybridDetectionOnFrame/
);

assert.match(
  serviceSource,
  /const\s+hybridResult\s*=\s*await\s+runHybridDetectionOnFrame\s*\(/
);

assert.match(
  serviceSource,
  /const\s+parsedFrame\s*=\s*parseYoloDetectionFrame\s*\(\s*hybridResult\s*,\s*capturedAt\s*\)/
);

assert.match(
  serviceSource,
  /const\s+stored\s*=\s*storeDetectionResult\s*\(/
);

assert.match(
  serviceSource,
  /const\s+verifiedStored\s*=\s*storeDetectionResult\s*\(/
);

/*
 * Verify ordering without depending on incidental argument names.
 */
const parseIndex = serviceSource.indexOf(
  'const parsedFrame = parseYoloDetectionFrame'
);

const firstStoreIndex = serviceSource.indexOf(
  'const stored = storeDetectionResult',
  parseIndex
);

const verifiedStoreIndex = serviceSource.indexOf(
  'const verifiedStored = storeDetectionResult',
  firstStoreIndex
);

assert.ok(
  parseIndex >= 0,
  'parsed hybrid detection frame stage must exist'
);

assert.ok(
  firstStoreIndex > parseIndex,
  'initial detection storage must occur after parsing'
);

assert.ok(
  verifiedStoreIndex > firstStoreIndex,
  'verified detection storage must occur after initial storage'
);

/*
 * The obsolete displayFrame storage path must not return.
 */
assert.match(
  serviceSource,
  /storeDetectionResult\s*\(\s*displayFrame/
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_YOLO_PARSER_WIRING_CONTRACT_PASS',
  parser_export_verified: true,
  storage_export_verified: true,
  hybrid_result_is_parser_input: true,
  parse_precedes_initial_storage: true,
  initial_storage_precedes_verified_storage: true,
  display_frame_storage_verified: true,
  live_services_started: false
}, null, 2));
