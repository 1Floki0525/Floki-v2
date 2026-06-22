'use strict';

const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');

const yolo = require('../src/vision/yolo-detection-service.cjs');

const REQUIRED = [
  'runYoloDetectionOnFrame',
  'storeDetectionResult',
  'readLatestDetection',
  'getDetectionStatus',
  'startYoloDetectionWorker',
  'stopYoloDetectionWorker',
  'getDetectionConfig',
  'getYoloModelPath',
  'getPythonPath',
  'parseYoloDetectionFrame',
  'normalizeYoloDetection',
  'validateDetection',
  'validateDetectionFrame',
  'processAlive',
];

for (const fn of REQUIRED) {
  const msg = `yolo-detection-service.cjs must export ${fn}`;
  assert.equal(typeof yolo[fn], 'function', msg);
}

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src/vision/yolo-detection-service.cjs'),
  'utf8'
);

assert.match(source, /worker\.stdin\.on\('error'/);
assert.match(source, /error\.code\s*!==\s*'EPIPE'/);
assert.match(source, /stdin\.destroyed/);
assert.match(source, /stdin\.writableEnded/);
assert.match(source, /stdin\.writable\s*!==\s*true/);
assert.match(source, /settlePendingYoloFailure/);
assert.match(source, /YOLO_STDIN_WRITE_FAIL/);

console.log(`PASS: yolo-runtime-export-contract — all ${REQUIRED.length} required exports are functions`);
