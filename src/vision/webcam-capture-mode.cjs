'use strict';

const { webcamCaptureConfig } = require('./webcam-capabilities.cjs');

function scoreMode(mode, requested) {
  const pixelPenalty = mode.pixel_format === requested.preferred_pixel_format ? 0 : 100000000;
  const resolutionPenalty = Math.abs((mode.width * mode.height) - (requested.target_width * requested.target_height));
  const fpsPenalty = Math.abs(Number(mode.fps) - Number(requested.target_fps)) * 1000;
  return pixelPenalty + resolutionPenalty + fpsPenalty;
}

function isExact(mode, requested) {
  return mode.pixel_format === requested.preferred_pixel_format &&
    mode.width === requested.target_width &&
    mode.height === requested.target_height &&
    Number(mode.fps) >= Number(requested.target_fps);
}

function isYamlAllowedFallback(mode, requested) {
  const resolutionOk = requested.allow_resolution_fallback === true || (mode.width === requested.target_width && mode.height === requested.target_height);
  const fpsOk = requested.allow_fps_fallback === true || Number(mode.fps) >= Number(requested.target_fps);
  const pixelOk = mode.pixel_format === requested.preferred_pixel_format || mode.pixel_format === requested.fallback_pixel_format;
  return resolutionOk && fpsOk && pixelOk;
}

function selectCaptureMode(capabilities, options) {
  const requested = options && options.capture_config ? options.capture_config : webcamCaptureConfig(options && options.mode ? options.mode : 'chat');
  const modes = capabilities && Array.isArray(capabilities.supported_modes) ? capabilities.supported_modes : [];
  const exact = modes.find(function(mode) { return isExact(mode, requested); });
  if (exact) {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_WEBCAM_CAPTURE_MODE_CONTRACT_PASS',
      requested_mode: requested,
      selected_mode: exact,
      exact_match: true,
      fallback_used: false,
      fallback_reason: null,
      yaml_allowed_fallback: false,
      target_preserved: true
    });
  }
  const candidates = modes.filter(function(mode) { return isYamlAllowedFallback(mode, requested); })
    .sort(function(a, b) { return scoreMode(a, requested) - scoreMode(b, requested); });
  if (candidates.length > 0 && (requested.allow_resolution_fallback === true || requested.allow_fps_fallback === true)) {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_WEBCAM_CAPTURE_MODE_CONTRACT_PASS',
      requested_mode: requested,
      selected_mode: candidates[0],
      exact_match: false,
      fallback_used: true,
      fallback_reason: 'exact target mode not advertised by webcam; YAML allowed fallback',
      yaml_allowed_fallback: true,
      target_preserved: Number(candidates[0].fps) >= Number(requested.target_fps)
    });
  }
  return Object.freeze({
    ok: false,
    marker: 'FLOKI_V2_WEBCAM_CAPTURE_MODE_FAIL',
    requested_mode: requested,
    selected_mode: null,
    exact_match: false,
    fallback_used: false,
    fallback_reason: 'exact target mode unavailable and YAML fallback is disabled',
    yaml_allowed_fallback: false,
    target_preserved: false
  });
}

module.exports = {
  isExact,
  isYamlAllowedFallback,
  selectCaptureMode
};
