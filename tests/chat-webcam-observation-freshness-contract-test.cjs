'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readLatestPrivateObservation,
  callVisionModelWithRetry
} = require('../src/vision/chat-webcam-vision-service.cjs');

async function run() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-observation-freshness-'));
  const observationFile = path.join(runtimeDir, 'chat-webcam-vision.latest-observation.private.json');
  const nowMs = Date.parse('2026-06-19T15:51:00.000Z');

  fs.writeFileSync(observationFile, JSON.stringify({
    ok: true,
    created_at: '2026-06-19T15:50:58.000Z',
    source: 'webcam',
    sight_scope: 'maker_world_external',
    observation_summary: 'A person is seated near framed photographs.',
    public_transcript_visible: false
  }, null, 2));

  const fresh = readLatestPrivateObservation({
    runtime_dir: runtimeDir,
    now_ms: nowMs,
    max_age_ms: 5000
  });

  assert.equal(fresh.available, true);
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.observation_age_ms, 2000);
  assert.equal(fresh.public_transcript_visible, false);

  const stale = readLatestPrivateObservation({
    runtime_dir: runtimeDir,
    now_ms: nowMs + 20000,
    max_age_ms: 5000
  });

  assert.equal(stale.available, false);
  assert.equal(stale.fresh, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.unavailable_reason, 'stale_observation');
  assert.equal(stale.observation_summary, null);



  fs.writeFileSync(
    path.join(
      runtimeDir,
      'chat-webcam-vision.latest-detection.json'
    ),
    JSON.stringify({
      ok: true,
      schema_version: 1,
      marker: 'FLOKI_V2_CHAT_YOLO_DETECTION_FRAME',
      frame_id: 'fresh-detector-frame',
      captured_at: new Date().toISOString(),
      detected_at: new Date().toISOString(),
      stored_at: new Date().toISOString(),
      source: 'hybrid',
      image_width: 1280,
      image_height: 720,
      device: 'cuda:0',
      model_source: 'hybrid_test',
      stale: false,
      age_ms: 0,
      detections: [
        {
          id: 'person-1',
          class_id: 0,
          type: 'person',
          label: 'person',
          confidence: 0.92,
          source: 'yolo',
          proposal_sources: ['yolo', 'grounding_dino'],
          bbox: {
            x: 0.1,
            y: 0.1,
            width: 0.4,
            height: 0.7
          }
        },
        {
          id: 'chair-1',
          class_id: 56,
          type: 'object',
          label: 'chair',
          confidence: 0.8,
          source: 'yolo',
          proposal_sources: ['yolo'],
          bbox: {
            x: 0.5,
            y: 0.4,
            width: 0.2,
            height: 0.4
          }
        }
      ]
    }, null, 2)
  );

  const detectionFallback = readLatestPrivateObservation({
    runtime_dir: runtimeDir,
    now_ms: Date.now(),
    max_age_ms: 1
  });

  assert.equal(detectionFallback.available, true);
  assert.equal(detectionFallback.fresh, true);
  assert.equal(detectionFallback.detection_fallback_used, true);
  assert.equal(
    detectionFallback.source,
    'webcam_live_detection'
  );
  assert.match(
    detectionFallback.observation_summary,
    /1 person/
  );
  assert.match(
    detectionFallback.observation_summary,
    /chair/
  );


  let attempts = 0;
  const retried = await callVisionModelWithRetry(Buffer.from('frame'), {
    max_attempts: 3,
    retry_delay_ms: 0,
    sleep_fn: async () => {},
    single_attempt_runner: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient VLM failure');
      return { observation_summary: 'Recovered visual observation.' };
    }
  });

  assert.equal(attempts, 3);
  assert.equal(retried.observation_summary, 'Recovered visual observation.');

  await assert.rejects(
    callVisionModelWithRetry(Buffer.from('frame'), {
      max_attempts: 2,
      retry_delay_ms: 0,
      sleep_fn: async () => {},
      single_attempt_runner: async () => {
        throw new Error('persistent VLM failure');
      }
    }),
    /failed after 2 attempts/
  );

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_WEBCAM_OBSERVATION_FRESHNESS_PASS',
    fresh_observation_available: true,
    stale_observation_blocked: true,
    stale_private_summary_suppressed: true,
    transient_vlm_failure_retried: true,
    persistent_vlm_failure_reported: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_WEBCAM_OBSERVATION_FRESHNESS_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
