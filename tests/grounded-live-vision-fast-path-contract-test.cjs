'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../src/chat/floki-chat.cjs');
const { authorizePublicText } = require('../brain/broca/index.cjs');
const { handleTypedText } = require('../src/chat/floki-live-chat-interface.cjs');
const { getVisionConfig } = require('../src/config/floki-config.cjs');
const { normalizeChatWebcamVisionContext } = require('../src/vision/chat-webcam-vision-context.cjs');
const { readLatestPrivateObservation } = require('../src/vision/chat-webcam-vision-service.cjs');
const {
  configuredVisionQuestionPhrases,
  looksLikeVisionQuestion,
  looksLikeVisionHardwareQuestion,
  configuredProhibitedPublicVisionTerms
} = require('../src/runtime/chat-local-runtime.cjs');

async function run() {
  const vision = getVisionConfig('chat');
  assert.ok(vision.vision_question_max_age_ms > 0);
  assert.ok(vision.vision_question_wait_ms > 0);
  assert.ok(vision.cognition_scene_max_detected_objects >= 12);
  assert.equal(vision.cognition_scene_require_narrative, true);
  assert.ok(configuredVisionQuestionPhrases(vision).length >= 1);
  assert.equal(looksLikeVisionQuestion('Hey Floki, what can you see?', vision), true);
  assert.equal(looksLikeVisionHardwareQuestion('What can you see?', vision), false);
  assert.equal(looksLikeVisionHardwareQuestion('How does your camera work?', vision), true);

  const observation = normalizeChatWebcamVisionContext({
    available: true,
    fresh: true,
    source: 'fused_live_sight',
    observation_summary: 'A cluttered living room is visible, with a seated person near a couch and coffee table, wall decorations behind them, and a doorway opening into another area.',
    scene_summary: 'A cluttered living room is visible, with a seated person near a couch and coffee table, wall decorations behind them, and a doorway opening into another area.',
    detected_people_count: 1,
    detected_objects: [
      { label: 'chair', count: 1 },
      { label: 'cup', count: 1 },
      { label: 'couch', count: 1 },
      { label: 'coffee table', count: 1 },
      { label: 'television', count: 1 }
    ],
    grounding_summary: '1 person is visible. Visible objects include chair, cup, couch, coffee table, television.',
    detection_grounding_used: true
  });
  assert.equal(observation.detected_objects.length, 5);
  assert.match(observation.scene_summary, /living room/i);

  const fusionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-rich-sight-fusion-'));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(fusionDir, 'chat-webcam-vision.latest-observation.private.json'), JSON.stringify({
    ok: true,
    created_at: now,
    source: 'vlm_scene',
    sight_scope: 'maker_world_external',
    observation_summary: observation.scene_summary
  }, null, 2));
  const objectLabels = ['chair', 'cup', 'couch', 'coffee table', 'television', 'book', 'potted plant', 'remote'];
  const detections = objectLabels.map((label, index) => ({
    id: 'object-' + String(index),
    class_id: index + 1,
    type: 'object',
    label,
    confidence: 0.92,
    source: 'yolo',
    proposal_sources: ['yolo'],
    bbox: { x: 0.01 * index, y: 0.01 * index, width: 0.1, height: 0.1 }
  }));
  detections.unshift({
    id: 'person-0',
    class_id: 0,
    type: 'person',
    label: 'person',
    confidence: 0.95,
    source: 'yolo',
    proposal_sources: ['yolo', 'grounding_dino'],
    verification: { verifier_ok: true, classification: 'live_person', confidence: 0.98, depiction_type: 'unknown', short_basis: 'live person' },
    bbox: { x: 0.2, y: 0.1, width: 0.3, height: 0.7 }
  });
  fs.writeFileSync(path.join(fusionDir, 'chat-webcam-vision.latest-detection.json'), JSON.stringify({
    schema_version: 1,
    frame_id: 'rich-scene-frame',
    captured_at: now,
    detected_at: now,
    stored_at: now,
    image_width: 1280,
    image_height: 720,
    device: 'cuda',
    model_source: 'fixture',
    stale: false,
    age_ms: 0,
    detections
  }, null, 2));
  const fused = readLatestPrivateObservation({ runtime_dir: fusionDir, max_age_ms: 10000 });
  assert.equal(fused.available, true);
  assert.equal(fused.source, 'fused_live_sight');
  assert.match(fused.scene_summary, /cluttered living room/i);
  assert.equal(fused.detected_people_count, 1);
  assert.ok(fused.detected_objects.length >= 8);
  assert.ok(fused.detected_objects.some((entry) => entry.label === 'potted plant'));
  fs.rmSync(fusionDir, { recursive: true, force: true });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-cognition-sight-'));
  const oldStateRoot = process.env.FLOKI_STATE_ROOT;
  process.env.FLOKI_STATE_ROOT = temp;
  try {
    const runtime = createRuntime({ session_id: 'cognition-sight-contract' });
    let prompt = '';
    const modelReply = 'I can see a lived-in living room, with a couch and coffee table forming the center of the space. A person is seated near a chair and cup, while wall decorations and an open doorway make the room feel connected to the rest of the home.';
    const cognition = {
      response_intent_for_broca: modelReply,
      safe_thought_summary: 'I am taking in the whole room and connecting the visible details into one scene.',
      felt_interpretation: 'I feel attentive and grounded in what is actually visible.',
      memory_links: [],
      personality_implications: [],
      identity_implications: [],
      new_memory_summary: 'I described what I could see as one coherent living-room scene.',
      emotion_reflection_enabled: true
    };
    const result = await handleTypedText(runtime, 'what can you see?', {
      chat_webcam_vision: observation,
      vision_question: true,
      vision_hardware_question: false,
      streaming_enabled: false,
      print_public_text: false,
      post_json: async (_url, payload) => {
        prompt = payload.prompt;
        return { model: payload.model, response: JSON.stringify(cognition), done: true };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.reply, modelReply);
    assert.match(prompt, /whole grounded scene/i);
    assert.match(prompt, /cluttered living room/i);
    assert.match(prompt, /coffee table/i);
    assert.match(result.reply, /living room/i);
    assert.match(result.reply, /couch/i);
    assert.match(result.reply, /coffee table/i);
    assert.match(result.reply, /wall decorations/i);
    assert.equal(result.reply.includes(';'), false);
    assert.equal(/objects including/i.test(result.reply), false);
    for (const term of configuredProhibitedPublicVisionTerms(vision)) {
      assert.equal(new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(result.reply), false, term);
    }

    const visionContract = {
      question: true,
      hardware_question: false,
      require_narrative: true,
      prohibited_terms: configuredProhibitedPublicVisionTerms(vision)
    };
    const inventoryRejected = authorizePublicText('I can see one person; one chair.', {
      chat_webcam_vision: observation,
      vision_response_contract: visionContract
    }, { persist_diagnostics: false });
    assert.equal(inventoryRejected.type, 'failure');
    assert.match(inventoryRejected.failure.message, /inventory|natural scene thought/i);

    const technicalRejected = authorizePublicText('My camera detector found a chair.', {
      chat_webcam_vision: observation,
      vision_response_contract: visionContract
    }, { persist_diagnostics: false });
    assert.equal(technicalRejected.type, 'failure');
    assert.match(technicalRejected.failure.message, /technical framing/i);

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V13_COGNITION_GROUNDED_LIVE_VISION_PASS',
      cognition_model_path_exercised: true,
      rich_scene_context_preserved: true,
      detector_inventory_not_public_reply: true,
      natural_first_person_scene_reply: result.reply,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
  } finally {
    if (oldStateRoot === undefined) delete process.env.FLOKI_STATE_ROOT;
    else process.env.FLOKI_STATE_ROOT = oldStateRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V13_COGNITION_GROUNDED_LIVE_VISION_FAIL', error: error.stack || error.message }, null, 2));
  process.exit(1);
});
