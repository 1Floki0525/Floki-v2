'use strict';

const assert = require('assert');

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

console.log(`PASS: yolo-runtime-export-contract — all ${REQUIRED.length} required exports are functions`);
