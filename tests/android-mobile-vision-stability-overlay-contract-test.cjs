
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const backend = read('apps/Floki-mobile-app/app/src/main/java/com/floki/neural/data/FlokiBackend.kt');
const vm = read('apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiViewModel.kt');
const ui = read('apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiAppRoot.kt');

assert.doesNotMatch(backend, /\.pingInterval\s*\(/);
assert.match(backend, /suspend fun getVisionMetadata\(\)/);
assert.match(backend, /suspend fun getVisionFrameBytes\(\)/);
assert.match(backend, /Cache-Control", "no-cache"/);
assert.match(backend, /call\.timeout\(\)\.timeout\(5, TimeUnit\.SECONDS\)/);
assert.match(backend, /latest vision frame was not a complete JPEG/);

assert.match(vm, /data class VisionDetection/);
assert.match(vm, /data class VisionOverlaySnapshot/);
assert.match(vm, /visionFrameRequestInProgress/);
assert.match(vm, /visionMetadataRequestInProgress/);
assert.match(vm, /pollVisionFrameOnce/);
assert.match(vm, /pollVisionMetadataOnce/);
assert.match(vm, /parseVisionOverlay/);
assert.match(vm, /detection\.booleanOrNull\("stale"\) != true/);
assert.doesNotMatch(vm, /detection\?\.booleanOrNull\("stale"\)/);
assert.match(vm, /backend\.getVisionMetadata\(\)/);
assert.match(vm, /backend\.getVisionFrameBytes\(\)/);
assert.match(vm, /VISION_AUTHORITATIVE_OFFLINE_CONFIRMATIONS/);
assert.match(vm, /VISION_FRAME_GRACE_MS/);
assert.match(vm, /transportAuthenticated/);
assert.match(vm, /startMobileHeartbeat\(generation\)/);
assert.match(vm, /AUTO_ACCESS_RETRY_MAX_MS/);
assert.match(vm, /Reconnecting automatic access/);
assert.match(vm, /Renewing automatic access/);
assert.match(vm, /val hasUsableCredential/);
assert.match(vm, /delay\(retryDelay\)/);
assert.doesNotMatch(
  vm,
  /error = error\.message\s*\n\s*\?: "Automatic APK authorization failed"/
);
assert.doesNotMatch(vm, /delay\(500L\)\s*\n\s*refreshVisionFrame\(\)/);

assert.match(ui, /VisionDetectionOverlay/);
assert.match(ui, /Canvas\(/);
assert.match(ui, /drawRect\(/);
assert.match(ui, /nativeCanvas\.drawText/);
assert.match(ui, /state\.visionOverlay\.detections/);
assert.match(ui, /ContentScale\.Fit/);
assert.match(ui, /Canvas\(modifier = Modifier\.fillMaxSize\(\)\)/);
assert.doesNotMatch(ui, /matchParentSize/);
assert.match(ui, /RECONNECTING/);
assert.doesNotMatch(ui, /onClick = \{ vm\.flushVisionFrame\(\) \}/);

console.log('FLOKI_ANDROID_MOBILE_VISION_STABILITY_OVERLAY_CONTRACT_PASS');
