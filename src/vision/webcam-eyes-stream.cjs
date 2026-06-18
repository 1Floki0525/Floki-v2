'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  PROJECT_ROOT: ROOT,
  getVisionConfig,
  getChatWorldVisionConfig,
  getTimeoutConfig,
  resolveToolPath
} = require('../config/floki-config.cjs');

function commandReady(command, options = {}) {
  const timeouts = getTimeoutConfig('chat');
  const result = spawnSync('bash', ['-lc', 'command -v "$1"', 'bash', command], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeout_ms || timeouts.command_check_ms
  });

  return Object.freeze({
    ready: result.status === 0,
    command,
    path: String(result.stdout || '').trim()
  });
}

function requiredEnvNames(mode = 'chat') {
  const vision = getVisionConfig(mode);
  return Object.freeze({
    webcam_capture_allow_env: vision.webcam_capture_allow_env,
    chat_vision_allow_env: vision.chat_vision_allow_env
  });
}

function webcamCaptureAllowed(env = process.env, mode = 'chat') {
  const required = requiredEnvNames(mode);
  return env[required.webcam_capture_allow_env] === '1' &&
    env[required.chat_vision_allow_env] === '1';
}

function resolveWebcamDevice(options = {}) {
  const mode = options.mode || 'chat';
  const vision = getVisionConfig(mode);
  const env = options.env || process.env;
  const envDevice = env[vision.webcam_device_env];
  return Object.freeze({
    device: envDevice && String(envDevice).trim() ? String(envDevice).trim() : vision.webcam_device_default,
    source: envDevice && String(envDevice).trim() ? 'env' : 'yaml',
    env_key: vision.webcam_device_env
  });
}

function webcamEyesStreamGuardStatus(env = process.env, mode = 'chat') {
  const allowed = webcamCaptureAllowed(env, mode);
  const required = requiredEnvNames(mode);
  const device = resolveWebcamDevice({ env, mode });

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_EYES_STREAM_GUARDED',
    allowed_now: allowed,
    required_env: required.webcam_capture_allow_env + '=1 ' + required.chat_vision_allow_env + '=1',
    webcam_device: device.device,
    webcam_device_source: device.source,
    webcam_opened_now: false,
    stream_started_now: false,
    frame_capture_run_now: false,
    measured_fps: null,
    desktop_screenshot_run_now: false,
    desktop_automation_used_for_sight: false,
    host_screenshot_vision: false,
    mineflayer_used: false,
    pathfinding_used: false,
    rcon_body_control_used: false,
    public_transcript_visible: false,
    chat_mode_only: true,
    game_mode_started: false,
    reason: allowed
      ? 'Webcam capture is explicitly allowed for this proof run.'
      : 'Webcam eyes stream is guarded and will not open a camera without explicit env gates.'
  });
}

function buildWebcamFfmpegArgs(options = {}) {
  const mode = options.mode || 'chat';
  const vision = getVisionConfig(mode);
  const chatVision = getChatWorldVisionConfig(mode);
  const device = resolveWebcamDevice(options);
  const outputDir = options.output_dir;
  if (!outputDir) throw new Error('output_dir is required for webcam frame capture');
  const outputPattern = path.join(outputDir, 'frame_%06d.jpg');
  const targetFps = chatVision.target_fps;
  const size = String(vision.frame_width) + 'x' + String(vision.frame_height);

  return Object.freeze({
    command: vision.webcam_capture_command,
    args: Object.freeze([
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      vision.webcam_backend,
      '-framerate',
      String(targetFps),
      '-video_size',
      size,
      '-i',
      device.device,
      '-t',
      String(vision.frame_retention_seconds),
      '-vf',
      'fps=' + String(targetFps),
      outputPattern
    ]),
    device: device.device,
    device_source: device.source,
    output_dir: outputDir,
    output_pattern: outputPattern,
    target_fps: targetFps,
    frame_width: vision.frame_width,
    frame_height: vision.frame_height,
    frame_retention_seconds: vision.frame_retention_seconds,
    capture_timeout_ms: (vision.frame_retention_seconds * 1000) + vision.capture_timeout_grace_ms
  });
}

function countFrameFiles(outputDir) {
  if (!fs.existsSync(outputDir)) return 0;
  return fs.readdirSync(outputDir).filter((name) => /^frame_[0-9]+\.jpg$/.test(name)).length;
}

function latestFrameFile(outputDir) {
  if (!fs.existsSync(outputDir)) return null;
  const frames = fs.readdirSync(outputDir)
    .filter((name) => /^frame_[0-9]+\.jpg$/.test(name))
    .sort();
  if (frames.length === 0) return null;
  return path.join(outputDir, frames[frames.length - 1]);
}

function readFrameBase64(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath).toString('base64');
}

function captureFramesWithFfmpeg(plan, options = {}) {
  const started = process.hrtime.bigint();
  fs.mkdirSync(plan.output_dir, { recursive: true });
  const result = spawnSync(plan.command, plan.args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: plan.capture_timeout_ms,
    env: options.env || process.env
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1000000;
  const frameCount = countFrameFiles(plan.output_dir);

  return Object.freeze({
    status: result.status,
    signal: result.signal || null,
    stdout: String(result.stdout || '').trim().slice(0, 500),
    stderr: String(result.stderr || '').trim().slice(0, 500),
    elapsed_ms: elapsedMs,
    frame_count: frameCount,
    latest_frame_file: latestFrameFile(plan.output_dir)
  });
}

function measuredFps(frameCount, elapsedMs) {
  if (!Number.isFinite(frameCount) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return frameCount / (elapsedMs / 1000);
}

function runWebcamEyesStreamProof(options = {}) {
  const mode = options.mode || 'chat';
  const env = options.env || process.env;
  const guard = webcamEyesStreamGuardStatus(env, mode);
  const vision = getVisionConfig(mode);
  const chatVision = getChatWorldVisionConfig(mode);

  if (!guard.allowed_now) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WEBCAM_EYES_STREAM_BLOCKED',
      guard,
      webcam_opened_now: false,
      stream_started_now: false,
      frame_capture_run_now: false,
      captured_frame_fps: null,
      vlm_inference_fps: null,
      desktop_screenshot_run_now: false,
      public_transcript_visible: false,
      chat_mode_only: true,
      game_mode_started: false
    });
  }

  const outputDir = options.output_dir || (
    vision.raw_frame_storage_enabled === true
      ? resolveToolPath(mode, 'webcam-eyes-stream')
      : path.join(os.tmpdir(), 'floki-webcam-eyes-' + String(process.pid))
  );
  const plan = buildWebcamFfmpegArgs({ ...options, output_dir: outputDir, env, mode });
  const ready = typeof options.command_ready === 'function'
    ? options.command_ready(plan.command)
    : commandReady(plan.command);

  if (!ready.ready) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WEBCAM_EYES_STREAM_FAIL',
      reason: 'configured webcam capture command is not available',
      command: plan.command,
      command_ready: ready,
      webcam_opened_now: false,
      stream_started_now: false,
      frame_capture_run_now: false,
      captured_frame_fps: 0,
      vlm_inference_fps: 0,
      chat_mode_only: true,
      game_mode_started: false
    });
  }

  const runner = options.capture_runner || captureFramesWithFfmpeg;
  const capture = runner(plan, { env });
  const fps = measuredFps(capture.frame_count, capture.elapsed_ms);
  const latestFrameBase64 = capture.latest_frame_base64 || readFrameBase64(capture.latest_frame_file);
  const ok = capture.status === 0 &&
    capture.frame_count > 0 &&
    fps >= chatVision.target_fps;

  if (vision.raw_frame_storage_enabled !== true && options.keep_temp_frames !== true) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }

  return Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_WEBCAM_EYES_STREAM_CONTRACT_PASS' : 'FLOKI_V2_WEBCAM_EYES_STREAM_FAIL',
    guard,
    command: plan.command,
    command_ready: ready.ready,
    webcam_backend: vision.webcam_backend,
    webcam_device: plan.device,
    webcam_device_source: plan.device_source,
    target_capture_fps: chatVision.target_fps,
    frame_width: plan.frame_width,
    frame_height: plan.frame_height,
    frame_buffer_size: vision.frame_buffer_size,
    frame_retention_seconds: vision.frame_retention_seconds,
    raw_frame_storage_enabled: vision.raw_frame_storage_enabled,
    output_dir: vision.raw_frame_storage_enabled === true ? outputDir : null,
    latest_frame_file: vision.raw_frame_storage_enabled === true ? capture.latest_frame_file : null,
    latest_frame_base64: options.include_frame_base64 === true ? latestFrameBase64 : null,
    latest_frame_base64_available: Boolean(latestFrameBase64),
    latest_frame_buffered: capture.frame_count > 0,
    frame_count: capture.frame_count,
    elapsed_ms: capture.elapsed_ms,
    captured_frame_fps: fps,
    measured_fps: fps,
    vlm_inference_fps: null,
    webcam_opened_now: capture.frame_count > 0,
    stream_started_now: capture.frame_count > 0,
    frame_capture_run_now: true,
    ffmpeg_exit_status: capture.status,
    ffmpeg_signal: capture.signal,
    ffmpeg_stdout: capture.stdout,
    ffmpeg_stderr: capture.stderr,
    desktop_screenshot_run_now: false,
    desktop_automation_used_for_sight: false,
    host_screenshot_vision: false,
    public_transcript_visible: false,
    private_observation_log_enabled: vision.private_observation_log_enabled,
    chat_mode_only: true,
    game_mode_started: false,
    reason: ok ? 'Measured webcam frame stream meets YAML target FPS.' : 'Measured webcam frame stream did not meet YAML target FPS.'
  });
}

function printWebcamEyesStreamProof() {
  const status = runWebcamEyesStreamProof();
  console.log(JSON.stringify(status, null, 2));
  if (!status.ok) process.exitCode = 1;
  return status;
}

module.exports = {
  ROOT,
  commandReady,
  requiredEnvNames,
  webcamCaptureAllowed,
  resolveWebcamDevice,
  webcamEyesStreamGuardStatus,
  buildWebcamFfmpegArgs,
  countFrameFiles,
  latestFrameFile,
  readFrameBase64,
  captureFramesWithFfmpeg,
  measuredFps,
  runWebcamEyesStreamProof,
  printWebcamEyesStreamProof
};

if (require.main === module) {
  printWebcamEyesStreamProof();
}
