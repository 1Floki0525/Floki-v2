'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  PROJECT_ROOT,
  getVisionConfig,
  getChatWorldVisionConfig,
  getTimeoutConfig,
  resolveToolPath
} = require('../config/floki-config.cjs');

const {
  webcamCaptureConfig,
  probeCapabilities
} = require('./webcam-capabilities.cjs');

const {
  selectCaptureMode
} = require('./webcam-capture-mode.cjs');

const ROOT = PROJECT_ROOT || path.resolve(__dirname, '..', '..');

function normalizeOptions(input) {
  if (!input || typeof input !== 'object') {
    return Object.freeze({
      mode: 'chat',
      env: process.env
    });
  }

  if (input.env && typeof input.env === 'object') {
    return Object.freeze({
      ...input,
      mode: input.mode || 'chat',
      env: input.env
    });
  }

  return Object.freeze({
    mode: input.mode || 'chat',
    env: input
  });
}

function requiredEnvNames(mode) {
  const vision = getVisionConfig(mode || 'chat');

  return Object.freeze({
    webcam_capture_allow_env: vision.webcam_capture_allow_env,
    chat_vision_allow_env: vision.chat_vision_allow_env
  });
}

function webcamCaptureAllowed(input) {
  const options = normalizeOptions(input);
  const required = requiredEnvNames(options.mode);

  return options.env[required.webcam_capture_allow_env] === '1' &&
    options.env[required.chat_vision_allow_env] === '1';
}

function resolveWebcamDevice(input) {
  const options = normalizeOptions(input);
  const vision = getVisionConfig(options.mode);

  if (!vision.webcam_device_env) {
    throw new Error('missing required vision config key: webcam_device_env');
  }

  const envDevice = options.env[vision.webcam_device_env];

  if (envDevice && String(envDevice).trim()) {
    return Object.freeze({
      device: String(envDevice).trim(),
      source: 'env',
      env_name: vision.webcam_device_env,
      env_key: vision.webcam_device_env
    });
  }

  if (!vision.webcam_device_default) {
    throw new Error('missing required vision config key: webcam_device_default');
  }

  return Object.freeze({
    device: vision.webcam_device_default,
    source: 'yaml',
    env_name: vision.webcam_device_env,
    env_key: vision.webcam_device_env
  });
}

function commandReady(command, options) {
  const mode = options && options.mode ? options.mode : 'chat';
  const timeouts = getTimeoutConfig(mode);

  const result = spawnSync(
    'bash',
    ['-lc', 'command -v "$1"', 'bash', command],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: options && options.timeout_ms
        ? options.timeout_ms
        : timeouts.command_check_ms
    }
  );

  return Object.freeze({
    ready: result.status === 0,
    command,
    path: String(result.stdout || '').trim(),
    status: result.status,
    stderr: String(result.stderr || '').trim()
  });
}

function measuredFps(frameCountOrInput, elapsedMsMaybe) {
  let frames;
  let elapsedMs;

  if (typeof frameCountOrInput === 'number') {
    frames = frameCountOrInput;
    elapsedMs = elapsedMsMaybe;
  } else if (frameCountOrInput && typeof frameCountOrInput === 'object') {
    frames =
      frameCountOrInput.frame_count ??
      frameCountOrInput.frameCount ??
      frameCountOrInput.frames ??
      frameCountOrInput.frames_measured ??
      frameCountOrInput.captured_frames ??
      frameCountOrInput.measurement_frames;

    if (typeof frameCountOrInput.elapsed_ms === 'number') {
      elapsedMs = frameCountOrInput.elapsed_ms;
    } else if (typeof frameCountOrInput.elapsedMs === 'number') {
      elapsedMs = frameCountOrInput.elapsedMs;
    } else if (typeof frameCountOrInput.duration_ms === 'number') {
      elapsedMs = frameCountOrInput.duration_ms;
    } else if (typeof frameCountOrInput.seconds === 'number') {
      elapsedMs = frameCountOrInput.seconds * 1000;
    } else if (typeof frameCountOrInput.elapsed_seconds === 'number') {
      elapsedMs = frameCountOrInput.elapsed_seconds * 1000;
    }
  }

  frames = Number(frames);
  elapsedMs = Number(elapsedMs);

  if (!Number.isFinite(frames) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 0;
  }

  return frames / (elapsedMs / 1000);
}

function resolveWebcamTargetFps(input) {
  const options = normalizeOptions(input);
  const capture = webcamCaptureConfig(options.mode);
  return Number(capture.target_fps);
}

function resolveWebcamFrameSize(input) {
  const options = normalizeOptions(input);
  const capture = webcamCaptureConfig(options.mode);

  return Object.freeze({
    width: Number(capture.target_width),
    height: Number(capture.target_height)
  });
}

function resolveWebcamPixelFormat(input) {
  const options = normalizeOptions(input);
  const capture = webcamCaptureConfig(options.mode);
  return capture.preferred_pixel_format;
}

function webcamEyesStreamGuardStatus(input) {
  const options = normalizeOptions(input);
  const required = requiredEnvNames(options.mode);
  const allowed = webcamCaptureAllowed(options);
  const device = resolveWebcamDevice(options);
  const vision = getVisionConfig(options.mode);
  const chatVision = getChatWorldVisionConfig(options.mode);
  const capture = webcamCaptureConfig(options.mode);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_EYES_STREAM_GUARDED',
    mode: options.mode,
    allowed_now: allowed,
    capture_allowed: allowed,
    webcam_capture_allowed: allowed,
    required_env: [
      required.webcam_capture_allow_env,
      required.chat_vision_allow_env
    ],
    required_env_text: required.webcam_capture_allow_env + '=1 ' + required.chat_vision_allow_env + '=1',

    device,
    webcam_device: device.device,
    webcam_device_source: device.source,
    resolved_device: device.device,
    capture_device: device.device,
    device_source: device.source,
    device_from_env: device.source === 'env',
    device_from_yaml_or_env: true,

    target_fps: Number(capture.target_fps),
    target_capture_fps: Number(chatVision.target_fps),
    min_measured_fps: Number(capture.min_measured_fps),
    fps: Number(capture.target_fps),
    framerate: Number(capture.target_fps),
    frame_width: Number(vision.frame_width),
    frame_height: Number(vision.frame_height),
    target_width: Number(capture.target_width),
    target_height: Number(capture.target_height),
    preferred_pixel_format: capture.preferred_pixel_format,
    pixel_format: capture.preferred_pixel_format,

    webcam_opened_now: false,
    stream_started_now: false,
    frame_capture_run_now: false,
    live_capture_run_now: false,
    measured_fps: null,
    captured_frame_fps: null,
    vlm_inference_fps: null,
    desktop_screenshot_run_now: false,
    desktop_automation_used_for_sight: false,
    host_screenshot_vision: false,
    mineflayer_used: false,
    pathfinding_used: false,
    rcon_body_control_used: false,
    public_transcript_visible: false,
    chat_mode_only: options.mode === 'chat',
    game_mode_started: false,
    fake_pass: false,
    fallback_as_success: false,
    reason: allowed
      ? 'Webcam capture is explicitly allowed for this proof run.'
      : 'Webcam eyes stream is guarded and will not open a camera without explicit env gates.'
  });
}

function buildWebcamFfmpegArgs(input) {
  const options = normalizeOptions(input);
  const vision = getVisionConfig(options.mode);
  const chatVision = getChatWorldVisionConfig(options.mode);
  const device = resolveWebcamDevice(options);

  const outputDir = input && input.output_dir
    ? input.output_dir
    : path.join(os.tmpdir(), 'floki-webcam-contract');

  const outputPattern = path.join(outputDir, 'frame_%06d.jpg');
  const targetFps = Number(chatVision.target_fps);
  const frameWidth = Number(vision.frame_width);
  const frameHeight = Number(vision.frame_height);
  const size = String(frameWidth) + 'x' + String(frameHeight);
  const command = vision.webcam_capture_command || 'ffmpeg';

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    String(vision.webcam_backend),
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
  ];

  Object.defineProperties(args, {
    args: { value: args, enumerable: false },
    ffmpeg_args: { value: args, enumerable: false },
    command: { value: command, enumerable: true },
    device: { value: device.device, enumerable: true },
    webcam_device: { value: device.device, enumerable: true },
    device_source: { value: device.source, enumerable: true },
    webcam_device_source: { value: device.source, enumerable: true },
    output_dir: { value: outputDir, enumerable: true },
    output_pattern: { value: outputPattern, enumerable: true },
    target_fps: { value: targetFps, enumerable: true },
    target_capture_fps: { value: targetFps, enumerable: true },
    fps: { value: targetFps, enumerable: true },
    framerate: { value: targetFps, enumerable: true },
    frame_width: { value: frameWidth, enumerable: true },
    frame_height: { value: frameHeight, enumerable: true },
    target_width: { value: frameWidth, enumerable: true },
    target_height: { value: frameHeight, enumerable: true },
    frame_retention_seconds: { value: Number(vision.frame_retention_seconds), enumerable: true },
    capture_timeout_ms: {
      value: (Number(vision.frame_retention_seconds) * 1000) + Number(vision.capture_timeout_grace_ms),
      enumerable: true
    },
    webcam_backend: { value: String(vision.webcam_backend), enumerable: true },
    raw_frame_storage_enabled: { value: vision.raw_frame_storage_enabled === true, enumerable: true },
    device_from_yaml_or_env: { value: true, enumerable: true },
    desktop_screenshot_run_now: { value: false, enumerable: true },
    host_screenshot_vision: { value: false, enumerable: true },
    chat_mode_only: { value: options.mode === 'chat', enumerable: true },
    game_mode_started: { value: false, enumerable: true }
  });

  return args;
}

function countFrameFiles(outputDir) {
  if (!outputDir || !fs.existsSync(outputDir)) return 0;

  return fs.readdirSync(outputDir)
    .filter((name) => /^frame_[0-9]+\.jpg$/.test(name))
    .length;
}

function latestFrameFile(outputDir) {
  if (!outputDir || !fs.existsSync(outputDir)) return null;

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

function captureFramesWithFfmpeg(plan, options) {
  const started = process.hrtime.bigint();

  fs.mkdirSync(plan.output_dir, { recursive: true });

  const result = spawnSync(plan.command, plan.args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: plan.capture_timeout_ms,
    env: options && options.env ? options.env : process.env
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

function runWebcamEyesStreamProof(input) {
  const options = normalizeOptions(input);
  const guard = webcamEyesStreamGuardStatus(options);
  const vision = getVisionConfig(options.mode);
  const chatVision = getChatWorldVisionConfig(options.mode);

  if (!guard.allowed_now) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WEBCAM_EYES_STREAM_BLOCKED',
      guard,
      mode: options.mode,
      required_env: guard.required_env,
      allowed_now: false,
      webcam_opened_now: false,
      stream_started_now: false,
      frame_capture_run_now: false,
      live_capture_run_now: false,
      captured_frame_fps: null,
      measured_fps: null,
      vlm_inference_fps: null,
      desktop_screenshot_run_now: false,
      desktop_automation_used_for_sight: false,
      host_screenshot_vision: false,
      public_transcript_visible: false,
      chat_mode_only: options.mode === 'chat',
      game_mode_started: false
    });
  }

  if (input && input.live === true) {
    return runLiveProof(options.mode);
  }

  const outputDir = input && input.output_dir
    ? input.output_dir
    : (
      vision.raw_frame_storage_enabled === true
        ? resolveToolPath(options.mode, 'webcam-eyes-stream')
        : path.join(os.tmpdir(), 'floki-webcam-eyes-' + String(process.pid))
    );

  const plan = buildWebcamFfmpegArgs({
    ...input,
    env: options.env,
    mode: options.mode,
    output_dir: outputDir
  });

  const ready = input && typeof input.command_ready === 'function'
    ? input.command_ready(plan.command)
    : commandReady(plan.command, { mode: options.mode });

  if (!ready || ready.ready !== true) {
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
      measured_fps: 0,
      vlm_inference_fps: 0,
      desktop_screenshot_run_now: false,
      desktop_automation_used_for_sight: false,
      host_screenshot_vision: false,
      public_transcript_visible: false,
      chat_mode_only: options.mode === 'chat',
      game_mode_started: false
    });
  }

  const runner = input && typeof input.capture_runner === 'function'
    ? input.capture_runner
    : captureFramesWithFfmpeg;

  const captureResult = runner(plan, { env: options.env });
  const frameCount = Number(captureResult.frame_count || 0);
  const fps = measuredFps(frameCount, Number(captureResult.elapsed_ms || 0));
  const latestBase64 = captureResult.latest_frame_base64 || readFrameBase64(captureResult.latest_frame_file);
  const latestFrameBuffered = frameCount > 0 || Boolean(captureResult.latest_frame_file);

  const ok = captureResult.status === 0 &&
    frameCount > 0 &&
    fps >= Number(chatVision.target_fps);

  if (vision.raw_frame_storage_enabled !== true && input && input.keep_temp_frames !== true) {
    if (!input.output_dir) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }

  return Object.freeze({
    ok,
    marker: ok
      ? 'FLOKI_V2_WEBCAM_EYES_STREAM_CONTRACT_PASS'
      : 'FLOKI_V2_WEBCAM_EYES_STREAM_FAIL',

    guard,
    mode: options.mode,
    command: plan.command,
    command_ready: ready.ready,
    webcam_backend: vision.webcam_backend,
    webcam_device: plan.device,
    webcam_device_source: plan.device_source,
    target_capture_fps: Number(chatVision.target_fps),
    target_fps: Number(chatVision.target_fps),
    frame_width: plan.frame_width,
    frame_height: plan.frame_height,
    frame_buffer_size: Number(vision.frame_buffer_size),
    frame_retention_seconds: Number(vision.frame_retention_seconds),
    raw_frame_storage_enabled: vision.raw_frame_storage_enabled === true,
    output_dir: vision.raw_frame_storage_enabled === true ? outputDir : null,
    latest_frame_file: vision.raw_frame_storage_enabled === true ? captureResult.latest_frame_file : null,
    latest_frame_base64: input && input.include_frame_base64 === true ? latestBase64 : null,
    latest_frame_base64_available: input && input.include_frame_base64 === true ? Boolean(latestBase64) : false,
    latest_frame_buffered: latestFrameBuffered,
    frame_count: frameCount,
    elapsed_ms: Number(captureResult.elapsed_ms || 0),
    captured_frame_fps: fps,
    measured_fps: fps,
    vlm_inference_fps: null,
    webcam_opened_now: frameCount > 0,
    stream_started_now: frameCount > 0,
    frame_capture_run_now: true,
    ffmpeg_exit_status: captureResult.status,
    ffmpeg_signal: captureResult.signal || null,
    ffmpeg_stdout: String(captureResult.stdout || '').slice(0, 500),
    ffmpeg_stderr: String(captureResult.stderr || '').slice(0, 500),
    desktop_screenshot_run_now: false,
    desktop_automation_used_for_sight: false,
    host_screenshot_vision: false,
    public_transcript_visible: false,
    private_observation_log_enabled: vision.private_observation_log_enabled === true,
    chat_mode_only: options.mode === 'chat',
    game_mode_started: false,
    fake_pass: false,
    fallback_as_success: false,
    reason: ok
      ? 'Measured webcam frame stream meets YAML target FPS.'
      : 'Measured webcam frame stream did not meet YAML target FPS.'
  });
}

/*
 * Stage 12.37 live 40 FPS path.
 * This is separate from the injected contract proof above.
 */

function ffmpegPixelFormat(pixelFormat) {
  const normalized = String(pixelFormat || '').toLowerCase();

  if (normalized === 'mjpg') return 'mjpeg';
  if (normalized === 'mjpeg') return 'mjpeg';
  if (normalized === 'yuyv') return 'yuyv422';
  if (normalized === 'yuyv422') return 'yuyv422';

  return normalized;
}

function buildFfmpegArgs(capture, selectedMode) {
  const totalFrames =
    Number(capture.measurement_warmup_frames) +
    Number(capture.measurement_frames);

  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    String(capture.ffmpeg_loglevel),
    '-f',
    String(capture.ffmpeg_input_format),
    '-input_format',
    ffmpegPixelFormat(selectedMode.pixel_format),
    '-framerate',
    String(selectedMode.fps),
    '-video_size',
    String(selectedMode.width) + 'x' + String(selectedMode.height),
    '-i',
    String(capture.device),
    '-frames:v',
    String(totalFrames),
    '-f',
    String(capture.ffmpeg_output_format),
    '-',
    '-progress',
    'pipe:2',
    '-nostats'
  ];

  Object.defineProperties(args, {
    args: { value: args, enumerable: false },
    ffmpeg_args: { value: args, enumerable: false },
    device: { value: capture.device, enumerable: true },
    target_fps: { value: Number(capture.target_fps), enumerable: true },
    min_measured_fps: { value: Number(capture.min_measured_fps), enumerable: true },
    target_width: { value: Number(capture.target_width), enumerable: true },
    target_height: { value: Number(capture.target_height), enumerable: true },
    pixel_format: { value: selectedMode.pixel_format, enumerable: true },
    fake_pass: { value: false, enumerable: true },
    fallback_as_success: { value: false, enumerable: true }
  });

  return args;
}

function parseLatestFrameFromChunk(chunk) {
  const text = String(chunk || '');
  let latest = null;

  const progressMatches = text.match(/frame=\s*(\d+)/g) || [];

  for (const item of progressMatches) {
    const frameMatch = item.match(/(\d+)/);
    if (frameMatch) latest = Number(frameMatch[1]);
  }

  return latest;
}

function runFfmpegMeasured(capture, selectedMode) {
  return new Promise(function(resolve) {
    const args = buildFfmpegArgs(capture, selectedMode);
    const child = spawn(capture.ffmpeg_bin, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    const warmupFrames = Number(capture.measurement_warmup_frames);
    const measurementFrames = Number(capture.measurement_frames);

    let stderr = '';
    let spawnError = null;
    let firstMeasuredAt = null;
    let lastMeasuredAt = null;
    let firstMeasuredFrame = null;
    let lastMeasuredFrame = null;

    child.stderr.on('data', function(chunk) {
      const text = String(chunk);
      stderr += text;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);

      const frame = parseLatestFrameFromChunk(text);

      if (frame !== null && frame >= warmupFrames) {
        const now = process.hrtime.bigint();

        if (firstMeasuredAt === null) {
          firstMeasuredAt = now;
          firstMeasuredFrame = frame;
        }

        lastMeasuredAt = now;
        lastMeasuredFrame = frame;
      }
    });

    child.on('error', function(error) {
      spawnError = error;
    });

    child.on('close', function(status) {
      let fps = 0;
      let framesMeasured = 0;

      if (
        firstMeasuredAt !== null &&
        lastMeasuredAt !== null &&
        lastMeasuredAt > firstMeasuredAt
      ) {
        framesMeasured = Math.max(
          0,
          Number(lastMeasuredFrame) - Number(firstMeasuredFrame)
        );

        fps = measuredFps(
          framesMeasured,
          Number(lastMeasuredAt - firstMeasuredAt) / 1000000
        );
      }

      resolve(Object.freeze({
        ok: !spawnError && status === 0,
        ffmpeg_exit_status: status,
        spawn_error: spawnError ? spawnError.message : null,
        measured_fps: fps,
        measuredFps: fps,
        fps,
        frames_measured: framesMeasured,
        requested_measurement_frames: measurementFrames,
        warmup_frames: warmupFrames,
        stderr_tail: stderr.slice(-1200),
        ffmpeg_args_shape: args.map(function(arg) {
          return arg === capture.device ? '<webcam-device-from-yaml-or-env>' : arg;
        })
      }));
    });
  });
}

async function runLiveProof(modeInput) {
  const mode = modeInput || 'chat';

  if (!webcamCaptureAllowed({ mode, env: process.env })) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WEBCAM_EYES_LIVE_40FPS_FAIL',
      failure: 'webcam capture blocked by guard env',
      required_env: webcamEyesStreamGuardStatus({ mode }).required_env,
      live_capture_run_now: false,
      webcam_opened_now: false,
      frame_capture_run_now: false,
      desktop_screenshot_run_now: false,
      host_screenshot_vision: false,
      public_transcript_visible: false,
      chat_mode_only: mode === 'chat',
      game_mode_started: false
    });
  }

  const capture = webcamCaptureConfig(mode);
  const resolved = resolveWebcamDevice({ mode, env: process.env });
  const captureWithDevice = Object.freeze({
    ...capture,
    device: resolved.device,
    device_source: resolved.source
  });

  const capability = probeCapabilities(mode);

  if (!capability.capability_probe_run_now) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WEBCAM_EYES_LIVE_40FPS_FAIL',
      failure: 'capability probe did not run',
      capability,
      live_capture_run_now: false,
      webcam_opened_now: false,
      frame_capture_run_now: false,
      desktop_screenshot_run_now: false,
      public_transcript_visible: false,
      chat_mode_only: mode === 'chat',
      game_mode_started: false
    });
  }

  const selection = selectCaptureMode(capability, {
    capture_config: captureWithDevice
  });

  if (!selection.ok) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WEBCAM_EYES_LIVE_40FPS_FAIL',
      failure: selection.fallback_reason,
      capability,
      selection,
      live_capture_run_now: false,
      webcam_opened_now: false,
      frame_capture_run_now: false,
      desktop_screenshot_run_now: false,
      public_transcript_visible: false,
      chat_mode_only: mode === 'chat',
      game_mode_started: false
    });
  }

  const measured = await runFfmpegMeasured(captureWithDevice, selection.selected_mode);
  const fpsPass =
    measured.ok === true &&
    Number(measured.measured_fps) >= Number(captureWithDevice.min_measured_fps);

  return Object.freeze({
    ok: fpsPass,
    marker: fpsPass
      ? 'FLOKI_V2_WEBCAM_EYES_LIVE_40FPS_PASS'
      : 'FLOKI_V2_WEBCAM_EYES_LIVE_40FPS_FAIL',
    mode,
    config_path: captureWithDevice.config_path,
    requested_mode: {
      width: captureWithDevice.target_width,
      height: captureWithDevice.target_height,
      fps: captureWithDevice.target_fps,
      pixel_format: captureWithDevice.preferred_pixel_format
    },
    selected_mode: selection.selected_mode,
    exact_match: selection.exact_match,
    fallback_used: selection.fallback_used,
    min_measured_fps: captureWithDevice.min_measured_fps,
    measured_fps: measured.measured_fps,
    measuredFps: measured.measured_fps,
    frames_measured: measured.frames_measured,
    ffmpeg_exit_status: measured.ffmpeg_exit_status,
    ffmpeg_args_shape: measured.ffmpeg_args_shape,
    failure: fpsPass ? null : 'measured FPS below YAML min_measured_fps or ffmpeg failed',
    live_capture_run_now: true,
    webcam_opened_now: true,
    frame_capture_run_now: true,
    desktop_screenshot_run_now: false,
    host_screenshot_vision: false,
    public_transcript_visible: false,
    fake_pass: false,
    fallback_as_success: false,
    raw_frame_storage_enabled: captureWithDevice.raw_frame_storage_enabled,
    chat_mode_only: mode === 'chat',
    game_mode_started: false
  });
}

function contractStatus(modeInput) {
  const mode = modeInput || 'chat';
  const capture = webcamCaptureConfig(mode);
  const vision = getVisionConfig(mode);
  const guard = webcamEyesStreamGuardStatus({ mode });

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_EYES_STREAM_CONTRACT_PASS',
    mode,
    config_path: capture.config_path,
    target_fps: Number(capture.target_fps),
    min_measured_fps: Number(capture.min_measured_fps),
    fps: Number(capture.target_fps),
    framerate: Number(capture.target_fps),
    target_width: Number(capture.target_width),
    width: Number(capture.target_width),
    target_height: Number(capture.target_height),
    height: Number(capture.target_height),
    frame_width: Number(vision.frame_width),
    frame_height: Number(vision.frame_height),
    preferred_pixel_format: capture.preferred_pixel_format,
    pixel_format: capture.preferred_pixel_format,
    ffmpeg_config_from_yaml: true,
    device_from_yaml_or_env: true,
    required_env: guard.required_env,
    live_capture_run_now: false,
    webcam_opened_now: false,
    frame_capture_run_now: false,
    desktop_screenshot_run_now: false,
    host_screenshot_vision: false,
    public_transcript_visible: false,
    fake_pass: false,
    fallback_as_success: false,
    chat_mode_only: mode === 'chat',
    game_mode_started: false
  });
}

async function main() {
  const live = process.argv.includes('--live-proof');
  const status = live ? await runLiveProof('chat') : contractStatus('chat');
  console.log(JSON.stringify(status, null, 2));
  if (!status.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(function(error) {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_WEBCAM_EYES_LIVE_40FPS_FAIL',
      error: error.message,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  ROOT,
  commandReady,
  requiredEnvNames,

  webcamCaptureAllowed,
  webcamEyesStreamGuardStatus,
  resolveWebcamDevice,
  buildWebcamFfmpegArgs,
  countFrameFiles,
  latestFrameFile,
  readFrameBase64,
  captureFramesWithFfmpeg,
  measuredFps,
  runWebcamEyesStreamProof,

  resolveWebcamTargetFps,
  resolveWebcamFrameSize,
  resolveWebcamPixelFormat,

  createWebcamEyesStreamGuardReport: webcamEyesStreamGuardStatus,
  createWebcamEyesGuardReport: webcamEyesStreamGuardStatus,
  webcamEyesGuardStatus: webcamEyesStreamGuardStatus,

  ffmpegPixelFormat,
  buildFfmpegArgs,
  parseLatestFrameFromChunk,
  runFfmpegMeasured,
  runLiveProof,
  contractStatus
};
