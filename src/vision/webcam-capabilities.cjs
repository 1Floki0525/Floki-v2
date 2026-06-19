'use strict';

const { spawnSync } = require('node:child_process');
const { getFlokiConfig } = require('../config/floki-config.cjs');

function required(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new Error('missing required YAML key: ' + label);
  }
  return value;
}

function webcamCaptureConfig(mode) {
  const config = getFlokiConfig(mode || 'chat');
  const capture = config.webcam_capture || (config.vision && config.vision.webcam_capture);
  if (!capture || typeof capture !== 'object') {
    throw new Error('missing required YAML section: webcam_capture');
  }
  const vision = config.vision || {};
  const chatVision = config.chat_world_vision || {};
  const deviceEnvName = vision.webcam_device_env || chatVision.webcam_device_env || 'FLOKI_WEBCAM_DEVICE';
  const deviceDefault = vision.webcam_device_default || chatVision.webcam_device_default;
  const device = process.env[deviceEnvName] || required(deviceDefault, 'vision.webcam_device_default');
  return Object.freeze({
    mode: config.mode,
    config_path: config.source_path,
    device,
    backend: required(vision.webcam_backend || capture.ffmpeg_input_format, 'vision.webcam_backend or webcam_capture.ffmpeg_input_format'),
    target_fps: Number(required(capture.target_fps, 'webcam_capture.target_fps')),
    target_width: Number(required(capture.target_width, 'webcam_capture.target_width')),
    target_height: Number(required(capture.target_height, 'webcam_capture.target_height')),
    preferred_pixel_format: String(required(capture.preferred_pixel_format, 'webcam_capture.preferred_pixel_format')).toLowerCase(),
    fallback_pixel_format: String(required(capture.fallback_pixel_format, 'webcam_capture.fallback_pixel_format')).toLowerCase(),
    allow_resolution_fallback: capture.allow_resolution_fallback === true,
    allow_fps_fallback: capture.allow_fps_fallback === true,
    require_exact_target_fps: capture.require_exact_target_fps !== false,
    measurement_warmup_frames: Number(required(capture.measurement_warmup_frames, 'webcam_capture.measurement_warmup_frames')),
    measurement_frames: Number(required(capture.measurement_frames, 'webcam_capture.measurement_frames')),
    min_measured_fps: Number(required(capture.min_measured_fps, 'webcam_capture.min_measured_fps')),
    ffmpeg_bin: String(required(capture.ffmpeg_bin, 'webcam_capture.ffmpeg_bin')),
    v4l2_ctl_bin: String(required(capture.v4l2_ctl_bin, 'webcam_capture.v4l2_ctl_bin')),
    ffmpeg_loglevel: String(required(capture.ffmpeg_loglevel, 'webcam_capture.ffmpeg_loglevel')),
    ffmpeg_input_format: String(required(capture.ffmpeg_input_format, 'webcam_capture.ffmpeg_input_format')),
    ffmpeg_output_format: String(required(capture.ffmpeg_output_format, 'webcam_capture.ffmpeg_output_format')),
    frame_transport: String(required(capture.frame_transport, 'webcam_capture.frame_transport')),
    raw_frame_storage_enabled: capture.raw_frame_storage_enabled === true
  });
}

function normalizePixelFormat(format) {
  const raw = String(format || '').trim();
  const upper = raw.toUpperCase();
  if (upper === 'MJPG' || upper === 'MJPEG') return 'mjpeg';
  if (upper === 'YUYV' || upper === 'YUYV422') return 'yuyv422';
  if (upper === 'H264') return 'h264';
  return raw.toLowerCase();
}

function parseFps(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number;
}

function parseV4l2Formats(text) {
  const lines = String(text || '').split(/\r?\n/);
  const formats = [];
  const modes = [];
  let currentFormat = null;
  let currentSize = null;

  for (const line of lines) {
    const formatMatch = line.match(/\[\d+\]:\s+\'([^\']+)\'\s+\(([^)]*)\)/);
    if (formatMatch) {
      currentFormat = {
        raw_pixel_format: formatMatch[1],
        pixel_format: normalizePixelFormat(formatMatch[1]),
        description: formatMatch[2],
        sizes: []
      };
      formats.push(currentFormat);
      currentSize = null;
      continue;
    }

    const sizeMatch = line.match(/Size:\s+Discrete\s+(\d+)x(\d+)/);
    if (sizeMatch && currentFormat) {
      currentSize = { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]), fps: [] };
      currentFormat.sizes.push(currentSize);
      continue;
    }

    const intervalMatch = line.match(/\(([0-9.]+)\s+fps\)/i);
    if (intervalMatch && currentFormat && currentSize) {
      const fps = parseFps(intervalMatch[1]);
      if (fps !== null) {
        currentSize.fps.push(fps);
        modes.push({
          pixel_format: currentFormat.pixel_format,
          raw_pixel_format: currentFormat.raw_pixel_format,
          width: currentSize.width,
          height: currentSize.height,
          fps
        });
      }
    }
  }

  return Object.freeze({ formats, supported_modes: modes });
}

function nearestFortyFpsModes(modes, target) {
  const wanted = Number(target.target_fps);
  return modes
    .filter(function(mode) { return Number(mode.fps) >= wanted; })
    .sort(function(a, b) {
      const aResolutionDelta = Math.abs((a.width * a.height) - (target.target_width * target.target_height));
      const bResolutionDelta = Math.abs((b.width * b.height) - (target.target_width * target.target_height));
      const aFpsDelta = Math.abs(a.fps - wanted);
      const bFpsDelta = Math.abs(b.fps - wanted);
      return aResolutionDelta - bResolutionDelta || aFpsDelta - bFpsDelta;
    })
    .slice(0, 10);
}

function exactTargetSupported(modes, target) {
  return modes.some(function(mode) {
    const fpsMatches = target.require_exact_target_fps === true
      ? Number(mode.fps) === Number(target.target_fps)
      : Number(mode.fps) >= Number(target.target_fps);

    return mode.width === target.target_width &&
      mode.height === target.target_height &&
      fpsMatches &&
      mode.pixel_format === target.preferred_pixel_format;
  });
}

function capabilityStatusFromText(text, options) {
  const mode = options && options.mode ? options.mode : 'chat';
  const capture = options && options.capture_config ? options.capture_config : webcamCaptureConfig(mode);
  const parsed = parseV4l2Formats(text);
  const exact = exactTargetSupported(parsed.supported_modes, capture);
  const nearest = nearestFortyFpsModes(parsed.supported_modes, capture);
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_CAPABILITIES_CONTRACT_PASS',
    mode: capture.mode,
    config_path: capture.config_path,
    device: capture.device,
    backend: capture.backend,
    target_fps: capture.target_fps,
    target_width: capture.target_width,
    target_height: capture.target_height,
    preferred_pixel_format: capture.preferred_pixel_format,
    formats: parsed.formats,
    supported_modes: parsed.supported_modes,
    exact_target_supported: exact,
    nearest_40fps_modes: nearest,
    recommended_mode: exact ? parsed.supported_modes.find(function(item) {
      const fpsMatches = capture.require_exact_target_fps === true
        ? Number(item.fps) === Number(capture.target_fps)
        : Number(item.fps) >= Number(capture.target_fps);
      return item.width === capture.target_width && item.height === capture.target_height && item.pixel_format === capture.preferred_pixel_format && fpsMatches;
    }) : nearest[0] || null,
    capability_probe_run_now: false,
    target_from_yaml: true,
    device_from_yaml_or_env: true,
    chat_mode_only: mode === 'chat',
    game_mode_started: false
  });
}

function probeCapabilities(mode) {
  const capture = webcamCaptureConfig(mode || 'chat');
  if (process.env.FLOKI_ALLOW_WEBCAM_CAPTURE !== '1') {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WEBCAM_CAPABILITIES_LIVE_FAIL',
      failure: 'FLOKI_ALLOW_WEBCAM_CAPTURE must be 1 for live capability probe',
      device: capture.device,
      capability_probe_run_now: false,
      chat_mode_only: capture.mode === 'chat',
      game_mode_started: false
    });
  }
  const result = spawnSync(capture.v4l2_ctl_bin, ['--device', capture.device, '--list-formats-ext'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WEBCAM_CAPABILITIES_LIVE_FAIL',
      failure: result.error ? result.error.message : result.stderr,
      exit_status: result.status,
      device: capture.device,
      capability_probe_run_now: true,
      chat_mode_only: capture.mode === 'chat',
      game_mode_started: false
    });
  }
  const status = capabilityStatusFromText(result.stdout, { mode: capture.mode, capture_config: capture });
  return Object.freeze({
    ...status,
    marker: status.exact_target_supported ? 'FLOKI_V2_WEBCAM_CAPABILITIES_LIVE_PASS' : 'FLOKI_V2_WEBCAM_CAPABILITIES_LIVE_FAIL',
    ok: status.exact_target_supported === true,
    capability_probe_run_now: true
  });
}

function main() {
  const status = probeCapabilities(process.argv[2] || 'chat');
  console.log(JSON.stringify(status, null, 2));
  if (!status.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  webcamCaptureConfig,
  normalizePixelFormat,
  parseV4l2Formats,
  capabilityStatusFromText,
  probeCapabilities
};
