'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBrainOutput } = require('../src/brain/brain-output-schema.cjs');
const {
  runCognitionFromHeardText
} = require('../src/senses/hearing-to-cognition-bridge.cjs');

async function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-spoken-vision-'));
  let capturedContext = null;
  let visionReads = 0;

  const heard = {
    ok: true,
    original_heard_text: 'Hey Floki, what can you see?',
    heard_text: 'what can you see?',
    heard_text_length: 17,
    heard_word_count: 4,
    wake_gate_marker: 'FLOKI_V2_WAKE_WORD_GATE_ROUTED'
  };

  const bridge = await runCognitionFromHeardText(heard, {
    brain_state_base_dir: path.join(baseDir, 'brain'),
    memory_base_dir: path.join(baseDir, 'memory'),
    dream_root: path.join(baseDir, 'dreams'),
    read_latest_private_observation: () => {
      visionReads += 1;
      return {
        available: true,
        fresh: true,
        observation_age_ms: 200,
        latest_private_observation_timestamp: '2026-06-19T15:50:58.112Z',
        source: 'webcam',
        sight_scope: 'maker_world_external',
        observation_summary: 'A person is seated in a room with framed photographs.'
      };
    },
    frontal_factory: () => ({
      runCognition: async (context) => {
        capturedContext = context;
        return createBrainOutput({
          type: 'model_response_summary',
          source: 'frontal',
          parent_event_ids: [context.event.id],
          payload: {
            model: 'spoken-vision-contract-model:local',
            cognition: {
              safe_thought_summary: 'I have a fresh Maker-world webcam observation.',
              felt_interpretation: 'calm and visually attentive.',
              memory_links: [],
              personality_implications: [],
              identity_implications: [],
              response_intent_for_broca: 'I can see a person seated in a room with framed photographs.',
              new_memory_summary: 'I answered a visual question from a fresh webcam observation.',
              emotion_reflection_enabled: true
            },
            safe_summary_only: true,
            raw_private_reasoning_stored: false,
            normalized_model_json: true,
            schema_constrained_json: true,
            json_retry_used: false,
            json_retry_first_error: null,
            model_json_fallback_used: false,
            model_json_fallback_reason: null
          },
          diagnostics: {
            module: 'frontal',
            status: 'spoken_vision_contract'
          }
        });
      }
    })
  });

  assert.equal(visionReads, 1);
  assert.ok(capturedContext);
  assert.equal(capturedContext.chat_webcam_vision.available, true);
  assert.equal(
    capturedContext.chat_webcam_vision.observation_summary,
    'A person is seated in a room with framed photographs.'
  );
  assert.equal(capturedContext.identity.self_model.has_eyes_now, true);
  assert.equal(capturedContext.identity.self_model.has_body_now, false);
  assert.equal(capturedContext.identity.self_model.has_game_world_eyes_now, false);
  assert.equal(bridge.chat_webcam_vision.available, true);
  assert.equal(bridge.runtime_capabilities.has_eyes_now, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SPOKEN_VISION_CONTEXT_INJECTION_PASS',
    spoken_observation_read_once: true,
    spoken_observation_reached_frontal: true,
    identity_runtime_sight_true: true,
    minecraft_body_claimed: false,
    game_vision_claimed: false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_SPOKEN_VISION_CONTEXT_INJECTION_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
