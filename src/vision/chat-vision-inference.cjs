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

function requireConfiguredVisionLanguageModel(models) {
  const visionModel = models.vision || {};
  const cognitionModel = models.cognition || {};
  const endpoint = String(
    visionModel.endpoint ||
    visionModel.local_endpoint ||
    cognitionModel.endpoint ||
    cognitionModel.local_endpoint ||
    ''
  ).replace(/\/+$/, '');
  const model = visionModel.model || cognitionModel.model || '';
  const keepAlive = visionModel.keep_alive || cognitionModel.keep_alive || null;
  const timeoutMs = Number(visionModel.timeout_ms || cognitionModel.timeout_ms || 0);

  if (!endpoint) throw new Error('vision language endpoint is missing from YAML model config');
  if (!model) throw new Error('vision language model is missing from YAML model config');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('vision language timeout_ms is missing from YAML model config');
  }

  return Object.freeze({
    endpoint,
    model,
    keep_alive: keepAlive,
    timeout_ms: timeoutMs,
    temperature: visionModel.temperature ?? cognitionModel.temperature,
    top_p: visionModel.top_p ?? cognitionModel.top_p,
    max_new_tokens: visionModel.generate_max_new_tokens ??
      visionModel.max_new_tokens ??
      cognitionModel.max_new_tokens ??
      cognitionModel.num_predict,
    num_predict: visionModel.num_predict ??
      visionModel.generate_num_predict ??
      cognitionModel.num_predict
  });
}

function buildConfiguredGenerationOptions(config) {
  const options = {};
  if (config.temperature !== undefined && config.temperature !== null) {
    options.temperature = Number(config.temperature);
  }
  if (config.top_p !== undefined && config.top_p !== null) {
    options.top_p = Number(config.top_p);
  }
  if (config.max_new_tokens !== undefined && config.max_new_tokens !== null) {
    options.max_new_tokens = Number(config.max_new_tokens);
  }
  if (config.num_predict !== undefined && config.num_predict !== null) {
    options.num_predict = Number(config.num_predict);
  }
  return options;
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

  // FLOKI_CONFIG_ONLY_TEXT_VISION_BRIDGE_V1
  // Model identity, endpoint, provider, and runtime budgets are config-only.
  // The camera/detector path handles pixels locally. This call sends only
  // bounded local frame facts to the configured language endpoint.
  const config = requireConfiguredVisionLanguageModel(models);
  const frameFacts = {
    source: frame.frame_source || 'local_webcam_frame',
    frame_index: frame.frame_index || null,
    frame_file_present: Boolean(frame.frame_file),
    image_data_available: true,
    image_sent_to_language_model: false,
    language_model_role: 'observation_from_local_vision_facts',
    safety_rule: 'Do not invent objects, people, or scene details not provided by local detectors.'
  };

  const body = {
    model: config.model,
    stream: false,
    messages: [
      {
        role: 'system',
        content: [
          'You are the configured local vision-language narrator.',
          'Use only the provided local camera and detector facts.',
          'Write one short external-world observation.',
          'If no objects are listed, say only that the webcam frame is available.',
          'Do not invent scene contents.',
          'Do not include private reasoning.'
        ].join(' ')
      },
      {
        role: 'user',
        content: 'Local vision facts: ' + JSON.stringify(frameFacts)
      }
    ],
    options: buildConfiguredGenerationOptions(config)
  };
  if (config.keep_alive) body.keep_alive = config.keep_alive;

  const response = await fetch(config.endpoint + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeout_ms)
  });

  if (!response.ok) {
    throw new Error('vision language endpoint returned HTTP ' + String(response.status));
  }

  const json = await response.json();
  let content = String(
    (json.message && json.message.content) ||
    json.response ||
    json.content ||
    ''
  ).trim();

  if (!content || /^Thinking Process:\s*$/i.test(content)) {
    content = 'The webcam is active and a fresh local camera frame is available for the vision loop.';
  }

  return Object.freeze({
    observation_summary: content,
    raw_stats: Object.freeze({
      endpoint_status: response.status,
      schema_constrained_json: false,
      direct_vlm_call: false,
      config_only_text_vision_bridge: true,
      image_sent_to_language_model: false,
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
