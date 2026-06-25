'use strict';

const assert = require('node:assert/strict');
const { statusReadyForChat, captureLiveFromStatus } = require('../src/vision/chat-webcam-vision-service.cjs');

const healthyCaptureWithStaleDetection = {
  service_process_alive: true,
  ffmpeg_process_alive: true,
  camera_open: true,
  first_frame_received: true,
  first_vlm_observation_succeeded: true,
  last_fatal_error: null,
  heartbeat_fresh: true,
  detection_heartbeat_fresh: false,
  tunnel_status: { active: true }
};

assert.equal(captureLiveFromStatus(healthyCaptureWithStaleDetection), true, 'fresh moving video must remain live independently of detector freshness');
assert.equal(statusReadyForChat(healthyCaptureWithStaleDetection), false, 'strict chat readiness must still fail when detector heartbeat is stale');
assert.equal(captureLiveFromStatus({ ...healthyCaptureWithStaleDetection, heartbeat_fresh: false }), false);
assert.equal(captureLiveFromStatus({ ...healthyCaptureWithStaleDetection, camera_open: false }), false);
assert.equal(captureLiveFromStatus({ ...healthyCaptureWithStaleDetection, last_fatal_error: 'capture failed' }), false);
assert.equal(statusReadyForChat({ ...healthyCaptureWithStaleDetection, detection_heartbeat_fresh: true }), true);

console.log('FLOKI_V2_VISION_LIVENESS_SEPARATION_PASS');
