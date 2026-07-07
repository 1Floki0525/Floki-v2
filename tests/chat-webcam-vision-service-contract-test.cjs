'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { webcamCaptureConfig } = require('../src/vision/webcam-capabilities.cjs');
const {
  assertNode24,
  buildContinuousFfmpegArgs,
  extractJpegFrames,
  buildOperationalStatus,
  publicStatus,
  statusReadyForChat,
  readLatestPrivateObservation,
  chatVisionTunnelConfig
} = require('../src/vision/chat-webcam-vision-service.cjs');
const { getModelConfig, getVisionConfig } = require('../src/config/floki-config.cjs');

function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );
  assert.doesNotThrow(() => assertNode24());

  const capture = webcamCaptureConfig('chat');
  const vision = getVisionConfig('chat');
  const models = getModelConfig('chat');
  const args = buildContinuousFfmpegArgs(capture);
  assert.equal(args.includes(capture.device), true);
  assert.equal(capture.device, process.env[vision.webcam_device_env] || vision.webcam_device_default);
  assert.equal(args.includes('-frames:v'), false);
  assert.equal(args.includes('image2pipe'), true);
  assert.equal(args.includes('mjpeg'), true);
  assert.equal(args.includes('-vf'), true, 'ffmpeg must set an explicit video filter');
  assert.equal(args.includes('scale=in_range=pc:out_range=pc,format=yuv420p'), true, 'ffmpeg must set explicit swscale range and non-deprecated pixel format');
  assert.equal(args.includes('-color_range'), true, 'ffmpeg must declare full color range for MJPEG');
  assert.equal(args.includes('pc'), true, 'ffmpeg MJPEG color range must be full/pc');
  assert.equal(args.join(' ').includes('screenshot'), false);
  assert.equal(args.join(' ').includes('xwd'), false);
  assert.ok(typeof models.vision.model === 'string' && models.vision.model.trim().length > 0, 'configured chat vision model must be non-empty');
  const tunnel = chatVisionTunnelConfig({ runtime_dir: '/tmp/floki-chat-webcam-contract-runtime' });
  assert.equal(tunnel.enabled, true);
  assert.equal(tunnel.active, true);
  assert.equal(tunnel.local_only, true);
  assert.equal(tunnel.web_host_only, true);
  assert.equal(tunnel.provider, 'huggingface');
  assert.equal(tunnel.backend, 'hf');
  assert.equal(tunnel.target, undefined);
  assert.equal(tunnel.local_endpoint, 'http://127.0.0.1:7711');
  assert.equal(tunnel.remote_endpoint, null);
  assert.equal(tunnel.required_model, models.vision.model);
  assert.equal(tunnel.model, models.vision.model);
  assert.equal(Object.prototype.hasOwnProperty.call(vision, 'vlm_ssh_tunnel_required_model'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(vision, 'vlm_ssh_tunnel_target'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(vision, 'vlm_ssh_tunnel_local_host'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(vision, 'vlm_ssh_tunnel_local_port'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(vision, 'vlm_ssh_tunnel_remote_host'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(vision, 'vlm_ssh_tunnel_remote_port'), false);
  assert.equal(tunnel.check_timeout_ms, 8000);

  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const parsed = extractJpegFrames(Buffer.concat([jpeg, jpeg]));
  assert.equal(parsed.frames.length, 2);
  assert.equal(parsed.remaining.length, 0);

  const status = buildOperationalStatus({
    camera_device: capture.device,
    target_capture_fps: capture.target_fps,
    camera_open: true,
    first_frame_received: true,
    first_vlm_observation_succeeded: true,
    total_frames_received: 16,
    first_frame_at_ms: 1000,
    last_frame_at_ms: 2000,
    last_frame_timestamp: '2026-06-19T10:00:00.000Z',
    last_vlm_inference_timestamp: '2026-06-19T10:00:01.000Z',
    latest_private_observation_timestamp: '2026-06-19T10:00:01.000Z',
    latest_private_observation_file: 'state/floki/chat/runtime/chat-webcam-vision.latest-observation.private.json',
    ffmpeg_pid: 123,
    ffmpeg_process_alive: true
  });
  assert.equal(status.measured_capture_fps, 15);
  assert.equal(status.target_capture_fps, 40);
  assert.equal(status.target_fps_met, false);
  assert.equal(status.ready_for_chat, true);
  assert.equal(statusReadyForChat(status), true);

  const notReadyNoFrame = buildOperationalStatus({
    ...status,
    camera_open: true,
    first_frame_received: false,
    first_vlm_observation_succeeded: true,
    ffmpeg_process_alive: true
  });
  assert.equal(notReadyNoFrame.ready_for_chat, false);

  const notReadyNoObservation = buildOperationalStatus({
    ...status,
    camera_open: true,
    first_frame_received: true,
    first_vlm_observation_succeeded: false,
    ffmpeg_process_alive: true
  });
  assert.equal(notReadyNoObservation.ready_for_chat, false);

  const strictBase = {
    ...status,
    heartbeat_fresh: true,
    tunnel_status: { active: true, local_only: true, web_host_only: true },
    detection_heartbeat_fresh: true
  };
  assert.equal(statusReadyForChat(strictBase), true, 'strict base status must be ready');

  assert.equal(statusReadyForChat({ ...strictBase, heartbeat_fresh: false }), false, 'stale heartbeat must block readiness');
  assert.equal(statusReadyForChat({ ...strictBase, tunnel_status: { active: false } }), false, 'inactive local HF vision model status must block readiness');
  assert.equal(statusReadyForChat({ ...strictBase, detection_heartbeat_fresh: false }), false, 'stale detection heartbeat must block readiness');

  const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'vision', 'chat-webcam-vision-service.cjs'), 'utf8');
  assert.equal(serviceSource.includes('options.signal'), true, 'waitForReady must accept a cancellation signal');
  assert.equal(serviceSource.includes('signal.addEventListener'), true, 'waitForReady must listen for signal abort');

  const publicOnly = publicStatus({
    ...status,
    observation_summary: 'private observation',
    latest_frame_base64: Buffer.from('raw').toString('base64')
  });
  assert.equal(Object.prototype.hasOwnProperty.call(publicOnly, 'observation_summary'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicOnly, 'latest_frame_base64'), false);

  const observationDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'floki-private-vision-'));
  const observationFile = path.join(observationDir, 'latest.private.json');
  fs.writeFileSync(observationFile, JSON.stringify({
    ok: true,
    created_at: '2026-06-19T10:00:01.000Z',
    source: 'webcam',
    sight_scope: 'maker_world_external',
    observation_summary: 'A private live webcam observation is available.'
  }, null, 2));
  const observation = readLatestPrivateObservation({
    runtime_dir: observationDir,
    latest_observation_file: observationFile,
    now_ms: Date.parse('2026-06-19T10:00:02.000Z'),
    max_age_ms: 5000
  });
  assert.equal(observation.available, true);
  assert.equal(observation.fresh, true);
  assert.equal(observation.stale, false);
  assert.equal(observation.public_transcript_visible, false);
  assert.equal(observation.observation_summary, 'A private live webcam observation is available.');

  assert.equal(serviceSource.includes('raw_frame_storage_enabled: false'), true);
  assert.equal(serviceSource.includes('desktop_screenshot_run_now: false'), true);
  assert.equal(serviceSource.includes('desktop_automation_used_for_sight: false'), true);
  assert.equal(serviceSource.includes('function readyTimeoutMs'), true, 'ready timeout must be config-driven');
  assert.equal(serviceSource.includes('getTimeoutConfig'), true, 'ready timeout must come from floki-config');

  
  // FLOKI_CHAT_WEBCAM_DIRECT_IMAGE_VLM_ASSERTS_V2
  const callBlock = serviceSource.match(/async function callVisionModel\(frameBuffer, options = \{\}\) \{[\s\S]*?\n\}\n\nfunction isAbortError/);
  assert.ok(callBlock, 'callVisionModel block must be present before isAbortError');
  assert.equal(callBlock[0].includes('FLOKI_CONFIG_ONLY_TEXT_VISION_BRIDGE_V1'), false);
  assert.ok(callBlock[0].includes("frameBuffer.toString('base64')"));
  assert.ok(callBlock[0].includes("'data:' + mimeType + ';base64,'"));
  assert.ok(callBlock[0].includes("type: 'image'"));
  assert.ok(callBlock[0].includes('image: imageDataUrl'));
  assert.ok(callBlock[0].includes("config.endpoint + '/api/chat'"));
  assert.ok(callBlock[0].includes('direct_vlm_call: true'));
  assert.ok(callBlock[0].includes('config_only_text_vision_bridge: false'));
  assert.ok(callBlock[0].includes('image_sent_to_language_model: true'));
  assert.ok(callBlock[0].includes('chat_template_kwargs: { enable_thinking: false }'));

  // Webcam observations must be concise non-thinking vision observations.
  // This is request-scoped and must not disable cognition/RSI thinking globally.
  assert.ok(callBlock[0].includes('chat_template_kwargs: { enable_thinking: false }'), 'vision disables thinking per request');
  assert.ok(callBlock[0].includes('enable_thinking: false'), 'vision request must opt out of thinking');

  assert.ok(callBlock[0].includes('enable_thinking: false'));
  assert.ok(callBlock[0].includes('sanitizeVisionObservationText'));
  assert.ok(callBlock[0].includes('vision language endpoint fetch failed for'));
  assert.equal(callBlock[0].includes('Local vision facts:'), false);
  assert.equal(callBlock[0].includes('image_sent_to_language_model: false'), false);


console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_WEBCAM_SERVICE_CONTRACT_PASS',
    node_24_required: true,
    configured_camera_device_used: true,
    ffmpeg_child_held_open: true,
    first_real_frame_required: true,
    first_vlm_observation_required: true,
    configured_vision_model_from_yaml: true,
    local_hf_vision_path: true,
    public_transcript_isolated: true,
    private_observation_context_available: true,
    target_fps_met: status.target_fps_met,
    measured_capture_fps: status.measured_capture_fps,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_WEBCAM_SERVICE_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
