'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runChatVisionInference } = require('../src/vision/chat-vision-inference.cjs');
const { getModelConfig, getVisionConfig } = require('../src/config/floki-config.cjs');

async function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );
  const vision = getVisionConfig('chat');
  const models = getModelConfig('chat');
  const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-chat-vision-'));
  const env = {
    [vision.webcam_capture_allow_env]: '1',
    [vision.chat_vision_allow_env]: '1'
  };

  const blocked = await runChatVisionInference({ env: {} });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.vlm_inference_run_now, false);
  assert.equal(blocked.public_transcript_visible, false);

  const status = await runChatVisionInference({
    env,
    stream_status: {
      ok: true,
      frame_capture_run_now: true,
      captured_frame_fps: vision.target_capture_fps,
      measured_fps: vision.target_capture_fps,
      frame_count: vision.vlm_inference_every_n_frames,
      latest_frame_base64: Buffer.from('contract-frame').toString('base64')
    },
    transcript_options: { transcript_dir: transcriptDir },
    vlm_runner: async () => ({
      observation_summary: 'A maker-world desk is visible through the webcam eyes.'
    })
  });

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_CHAT_VISION_INFERENCE_CONTRACT_PASS');
  assert.equal(status.frame_capture_run_now, true);
  assert.equal(status.frame_capture_fps_measured, vision.target_capture_fps);
  assert.equal(status.vlm_inference_run_now, true);
  assert.equal(status.vlm_model_from_yaml, models.vision.model);
  assert.equal(status.vlm_endpoint_from_yaml, models.vision.endpoint);
  assert.equal(status.vlm_inference_every_n_frames, vision.vlm_inference_every_n_frames);
  assert.equal(status.vlm_inference_min_interval_ms, vision.vlm_inference_min_interval_ms);
  assert.equal(status.observation_summary_created, true);
  assert.equal(status.private_observation_written, true);
  assert.equal(fs.existsSync(status.private_observation_file), true);
  assert.equal(status.public_transcript_visible, false);
  assert.equal(fs.existsSync(path.join(transcriptDir, 'chat-transcript.jsonl')), false);

  await assert.rejects(
    () => runChatVisionInference({
      env,
      stream_status: {
        ok: true,
        frame_capture_run_now: true,
        captured_frame_fps: vision.target_capture_fps,
        measured_fps: vision.target_capture_fps,
        frame_count: vision.vlm_inference_every_n_frames,
        latest_frame_base64: Buffer.from('contract-frame').toString('base64')
      },
      store_private_observation: false,
      vlm_runner: async () => ({
        observation_summary: '<think>private reasoning</think> A chair is visible.'
      })
    }),
    /private thought|reasoning marker/
  );

  
  // FLOKI_CHAT_VISION_IMAGE_CONTENT_SOURCE_ASSERTS_V2
  const serviceSource = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'src/vision/chat-webcam-vision-service.cjs'), 'utf8');
  const callBlock = serviceSource.match(/async function callVisionModel\(frameBuffer, options = \{\}\) \{[\s\S]*?\n\}\n\nfunction isAbortError/);
  assert.ok(callBlock, 'callVisionModel block must be present before isAbortError');
  assert.ok(/messages:\s*\[[\s\S]*content:\s*\[[\s\S]*type:\s*'image'[\s\S]*type:\s*'text'/m.test(callBlock[0]));
  assert.ok(callBlock[0].includes('requireConfiguredVisionLanguageModel(models)'));
  assert.ok(callBlock[0].includes('buildConfiguredGenerationOptions(config)'));
  assert.equal(/\/api\/generate/.test(callBlock[0]), false);
  assert.equal(/ollama|qwen3|qwen3-vl|omen|127\.0\.0\.1|localhost:11434|localhost:11436|:7711/i.test(callBlock[0]), false);


console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_VISION_INFERENCE_CONTRACT_PASS',
    frame_capture_run_now: true,
    frame_capture_fps_measured: status.frame_capture_fps_measured,
    vlm_inference_run_now: true,
    vlm_model_from_yaml: status.vlm_model_from_yaml,
    vlm_endpoint_from_yaml: status.vlm_endpoint_from_yaml,
    observation_summary_created: true,
    private_reasoning_marker_rejected: true,
    public_transcript_visible: false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_VISION_INFERENCE_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
