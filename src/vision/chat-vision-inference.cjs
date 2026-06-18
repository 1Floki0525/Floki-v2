'use strict';

const fs = require('node:fs');

const { getModelConfig, getVisionConfig } = require('../config/floki-config.cjs');
const { appendPrivateThoughtRecord, assertPublicTranscriptText } = require('../chat/chat-transcript.cjs');
const {
  runWebcamEyesStreamProof,
  webcamCaptureAllowed
} = require('./webcam-eyes-stream.cjs');

function chatVisionInferenceAllowed(env = process.env) {
  const vision = getVisionConfig('chat');
  return env[vision.chat_vision_allow_env] === '1';
}

function selectFrame(streamStatus, options = {}) {
  if (options.frame) return options.frame;
  if (streamStatus && streamStatus.latest_frame_file) {
    return Object.freeze({
      frame_file: streamStatus.latest_frame_file,
      frame_index: streamStatus.frame_count || null
    });
  }
  if (streamStatus && streamStatus.latest_frame_base64) {
    return Object.freeze({
      base64: streamStatus.latest_frame_base64,
      frame_index: streamStatus.frame_count || null,
      frame_source: 'in_memory_buffer'
    });
  }
  return null;
}

function frameToBase64(frame) {
  if (frame && frame.base64) return frame.base64;
  if (frame && frame.frame_file && fs.existsSync(frame.frame_file)) {
    return fs.readFileSync(frame.frame_file).toString('base64');
  }
  return null;
}

async function callVisionModel(frame, options = {}) {
  if (typeof options.vlm_runner === 'function') {
    return options.vlm_runner(frame, options);
  }

  const models = getModelConfig('chat');
  const imageBase64 = frameToBase64(frame);
  if (!imageBase64) {
    throw new Error('chat vision inference requires a selected frame with image data');
  }

  const response = await fetch(models.vision.endpoint + '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: models.vision.model,
      prompt: 'Summarize only externally visible webcam facts for Floki chat mode. Do not include private reasoning.',
      images: [imageBase64],
      stream: false,
      options: {
        temperature: models.vision.temperature,
        top_p: models.vision.top_p
      },
      keep_alive: models.vision.keep_alive
    }),
    signal: AbortSignal.timeout(models.vision.timeout_ms)
  });

  if (!response.ok) {
    throw new Error('vision endpoint returned HTTP ' + String(response.status));
  }

  const json = await response.json();
  return Object.freeze({
    observation_summary: String(json.response || '').trim(),
    raw_stats: Object.freeze({
      endpoint_status: response.status,
      schema_constrained_json: false,
      direct_vlm_call: true,
      inference_elapsed_ms: null
    })
  });
}

function normalizeObservation(result, options = {}) {
  const text = String(
    result && (result.observation_summary || result.summary || result.response || '')
  ).trim();
  const safeText = assertPublicTranscriptText(text, 'chat vision observation summary');

  if (!safeText) {
    throw new Error('vision model did not return an observation summary');
  }

  return Object.freeze({
    created_at: options.created_at || new Date().toISOString(),
    source: 'webcam',
    sight_scope: 'maker_world_external',
    observation_summary: safeText,
    external_world_observation: true,
    internal_reality: false,
    public_transcript_visible: false,
    spoken_aloud: false,
    raw_private_reasoning_visible: false,
    chat_mode_only: true,
    game_mode_started: false
  });
}

function storePrivateObservation(observation, options = {}) {
  const vision = getVisionConfig('chat');
  if (vision.private_observation_log_enabled !== true || options.store_private_observation === false) {
    return Object.freeze({
      written: false,
      reason: 'private_observation_log_disabled'
    });
  }

  return appendPrivateThoughtRecord({
    source: 'chat_vision_inference',
    text: 'Webcam observation summary: ' + observation.observation_summary,
    event_id: options.event_id || null,
    report_file: options.report_file || null
  }, options.transcript_options || {});
}

async function runChatVisionInference(options = {}) {
  const env = options.env || process.env;
  const vision = getVisionConfig('chat');
  const models = getModelConfig('chat');
  const captureAllowed = webcamCaptureAllowed(env, 'chat');
  const inferenceAllowed = chatVisionInferenceAllowed(env);

  if (!captureAllowed || !inferenceAllowed || vision.vlm_inference_enabled !== true) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_CHAT_VISION_INFERENCE_BLOCKED',
      frame_capture_run_now: false,
      frame_capture_fps_measured: null,
      vlm_inference_run_now: false,
      vlm_model_from_yaml: models.vision.model,
      vlm_endpoint_from_yaml: models.vision.endpoint,
      observation_summary_created: false,
      public_transcript_visible: false,
      chat_mode_only: true,
      game_mode_started: false,
      reason: 'Chat vision inference requires explicit webcam and chat vision env gates.'
    });
  }

  const streamStatus = options.stream_status || runWebcamEyesStreamProof({
    ...options,
    include_frame_base64: true
  });
  const frame = selectFrame(streamStatus, options);
  if (!frame) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_CHAT_VISION_INFERENCE_FAIL',
      frame_capture_run_now: streamStatus.frame_capture_run_now === true,
      frame_capture_fps_measured: streamStatus.captured_frame_fps || null,
      vlm_inference_run_now: false,
      vlm_model_from_yaml: models.vision.model,
      vlm_endpoint_from_yaml: models.vision.endpoint,
      observation_summary_created: false,
      public_transcript_visible: false,
      chat_mode_only: true,
      game_mode_started: false,
      reason: 'No selected webcam frame was available for VLM inference.'
    });
  }

  const started = process.hrtime.bigint();
  const result = await callVisionModel(frame, {
    ...options,
    model: models.vision.model,
    endpoint: models.vision.endpoint
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1000000;
  const observation = normalizeObservation(result, options);
  const privateWrite = storePrivateObservation(observation, options);
  const inferenceFps = elapsedMs > 0 ? 1000 / elapsedMs : 0;

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_VISION_INFERENCE_CONTRACT_PASS',
    frame_capture_run_now: streamStatus.frame_capture_run_now === true,
    frame_capture_fps_measured: streamStatus.captured_frame_fps || streamStatus.measured_fps || null,
    captured_frame_fps: streamStatus.captured_frame_fps || streamStatus.measured_fps || null,
    vlm_inference_run_now: true,
    vlm_inference_fps: inferenceFps,
    vlm_model_from_yaml: models.vision.model,
    vlm_endpoint_from_yaml: models.vision.endpoint,
    vlm_inference_every_n_frames: vision.vlm_inference_every_n_frames,
    vlm_inference_min_interval_ms: vision.vlm_inference_min_interval_ms,
    observation_summary_created: true,
    observation,
    private_observation_written: privateWrite.written === true,
    private_observation_file: privateWrite.private_thought_jsonl_file || null,
    public_transcript_visible: false,
    spoken_aloud: false,
    raw_private_reasoning_visible: false,
    chat_mode_only: true,
    game_mode_started: false
  });
}

module.exports = {
  chatVisionInferenceAllowed,
  selectFrame,
  frameToBase64,
  callVisionModel,
  normalizeObservation,
  storePrivateObservation,
  runChatVisionInference
};
