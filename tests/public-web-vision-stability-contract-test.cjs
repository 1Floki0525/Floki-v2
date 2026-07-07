'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), 'utf8');

const panel = read(
  'apps/floki-neural-interface/src/components/vision/VisionPanel.jsx'
);
const adapter = read(
  'apps/floki-neural-interface/src/integrations/floki/adapter.js'
);
const cards = read('tests/client-app-system-cards-contract-test.cjs');

assert.match(panel, /function preloadBlobUrl\(url\)/);
assert.match(panel, /await preloadBlobUrl\(nextUrl\)/);
assert.match(panel, /const previousUrl = jpgFrameUrlRef\.current/);
assert.match(panel, /setJpgFrameUrl\(nextUrl\)[\s\S]*retireFrameUrl\(previousUrl\)/);
assert.match(panel, /WEB_RETIRED_FRAME_REVOKE_DELAY_MS/);
assert.match(panel, /frameFailureCountRef/);
assert.match(panel, /metaFailureCountRef/);
assert.match(panel, /lastGoodFrameAtRef/);
assert.match(panel, /WEB_FRAME_FAILURE_GRACE_MS/);
assert.match(panel, /WEB_FRAME_FAILURE_THRESHOLD/);
assert.match(panel, /WEB_META_FAILURE_THRESHOLD/);
assert.match(panel, /WEB_FRAME_REQUEST_TIMEOUT_MS/);
assert.match(panel, /requestTimedOut = true[\s\S]*controller\?\.abort\(\)/);
assert.match(panel, /WEB_FRAME_POLL_SUCCESS_DELAY_MS = 125/);
assert.match(panel, /WEB_FRAME_POLL_MAX_BACKOFF_MS/);
assert.match(panel, /document\.hidden/);
assert.match(panel, /metaInFlightRef\.current/);
assert.match(
  panel,
  /key=\{frozen \? 'frozen-frame' : \(mjpegUrl \? `mjpeg-\$\{streamKey\}` : 'jpeg-stream'\)\}/
);
assert.doesNotMatch(
  panel,
  /key=\{frozen \? 'frozen-frame' : \(mjpegUrl \? streamKey : displayUrl\)\}/
);
assert.doesNotMatch(
  panel,
  /clearCurrentFrameUrl\(\)[\s\S]{0,100}setJpgFrameUrl\(nextUrl\)/
);
assert.doesNotMatch(
  panel,
  /catch \(error\) \{[\s\S]{0,180}setStreamLoaded\(false\);[\s\S]{0,80}setStreamError\(true\);[\s\S]{0,80}\}\s*finally \{[\s\S]{0,100}setTimeout\(poll, 330\)/
);

assert.match(adapter, /cache: options\.cache \|\| 'no-store'/);
assert.match(
  adapter,
  /accept: 'image\/jpeg',[\s\S]{0,80}cache: 'no-store'/
);
assert.match(adapter, /Authorization = `Bearer \$\{token\}`/);
assert.match(adapter, /if \(res\.status === 401 && webBootstrap\(\)\)/);

assert.match(cards, /production_vision_isolated:\s*true/);
assert.match(cards, /vision_reconciler:\s*isolatedVisionReconciler/);

console.log('FLOKI_PUBLIC_WEB_VISION_STABILITY_CONTRACT_PASS');
