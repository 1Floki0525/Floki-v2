'use strict';

/**
 * Floki-v2 config authority layer.
 *
 * Single source of truth for all runtime configuration.
 * Loads config/chat.config.yaml or config/game.config.yaml
 * and provides typed accessors for every config section.
 *
 * No module should hardcode operational config values.
 * All runtime settings come from YAML or env overrides
 * declared explicitly in YAML.
 */

const path = require('node:path');
const { loadYamlFile } = require('./yaml-lite.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const CONFIG_VERSION = 'floki-v2-core-brain-config-v1';

const REQUIRED_SECTIONS = Object.freeze([
  'schema_version',
  'mode',
  'models',
  'modules',
  'policies'
]);

const cache = new Map();

function configPathForMode(mode) {
  if (mode === 'chat') return path.join(PROJECT_ROOT, 'config', 'chat.config.yaml');
  if (mode === 'game') return path.join(PROJECT_ROOT, 'config', 'game.config.yaml');
  throw new Error('unknown floki-config mode: ' + mode);
}

function resolveEnvOrDefault(section, envKeyName, defaultKeyName) {
  const envName = section[envKeyName];
  if (envName && process.env[envName]) {
    return process.env[envName];
  }
  return section[defaultKeyName];
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(fieldName + ' must be a non-empty string');
  }
  return value;
}

function requireNumber(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(fieldName + ' must be a finite number');
  }
  return value;
}

function requireBoolean(value, fieldName) {
  if (typeof value !== 'boolean') {
    throw new TypeError(fieldName + ' must be a boolean');
  }
  return value;
}

function requireObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(fieldName + ' must be an object');
  }
  return value;
}

function failMissingYamlKey(mode, keyPath) {
  throw new Error(
    'Missing required YAML key "' + keyPath + '" in ' + mode + ' config. ' +
    'The YAML file is the single source of truth. Add this key to config/' + mode + '.config.yaml.'
  );
}

function loadRawYaml(mode) {
  const filePath = configPathForMode(mode);
  return loadYamlFile(filePath);
}

function loadFlokiConfig(mode) {
  if (cache.has(mode)) return cache.get(mode);

  const raw = loadRawYaml(mode);

  if (raw.schema_version !== CONFIG_VERSION) {
    throw new Error('invalid schema_version in ' + mode + ' config: ' + raw.schema_version);
  }
  if (raw.mode !== mode) {
    throw new Error('config mode mismatch: expected ' + mode + ', got ' + raw.mode);
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!raw[section]) failMissingYamlKey(mode, section);
  }

  const config = Object.freeze({
    schema_version: raw.schema_version,
    mode: raw.mode,
    models: Object.freeze({
      cognition: buildModelSection(raw.models.cognition, mode, 'cognition'),
      vision: buildModelSection(raw.models.vision, mode, 'vision')
    }),
    modules: Object.freeze(raw.modules || {}),
    policies: Object.freeze(raw.policies || {}),
    embodiment: Object.freeze(raw.embodiment || {}),
    paths: buildPathsSection(raw.paths, mode),
    sleep: buildSleepSection(raw.sleep, mode),
    dream: buildDreamSection(raw.dream, mode),
    audio: buildAudioSection(raw.audio, mode),
    timeouts: buildTimeoutSection(raw.timeouts, mode),
    knowledge: buildKnowledgeSection(raw.knowledge, mode),
    live_chat: buildLiveChatSection(raw.live_chat, mode),
    life_clock: buildLifeClockSection(raw.life_clock, mode),
    _raw: raw,
    source_path: configPathForMode(mode)
  });

  cache.set(mode, config);
  return config;
}

function buildModelSection(section, mode, label) {
  if (!section) failMissingYamlKey(mode, 'models.' + label);

  const model = resolveEnvOrDefault(section, 'model_env', 'model_default');
  const endpoint = resolveEnvOrDefault(section, 'endpoint_env', 'endpoint_default');

  requireString(model, 'models.' + label + '.model');
  requireString(endpoint, 'models.' + label + '.endpoint');

  return Object.freeze({
    provider: requireString(section.provider || 'ollama', 'models.' + label + '.provider'),
    model,
    endpoint,
    enabled_now: section.enabled_now === true,
    mode_scope: section.mode_scope || '',
    temperature: typeof section.temperature === 'number' ? section.temperature : 0.5,
    top_p: typeof section.top_p === 'number' ? section.top_p : 0.9,
    timeout_ms: typeof section.timeout_ms === 'number' ? section.timeout_ms : 120000,
    keep_alive: section.keep_alive || '24h'
  });
}

function buildPathsSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'paths');

  return Object.freeze({
    state_root: requireString(section.state_root, 'paths.state_root'),
    tool_input_root: requireString(section.tool_input_root, 'paths.tool_input_root'),
    tool_output_root: requireString(section.tool_output_root, 'paths.tool_output_root'),
    runtime_root: requireString(section.runtime_root, 'paths.runtime_root'),
    chat_runtime_root: requireString(section.chat_runtime_root, 'paths.chat_runtime_root'),
    chat_transcript_root: requireString(section.chat_transcript_root, 'paths.chat_transcript_root'),
    dream_root: requireString(section.dream_root, 'paths.dream_root'),
    media_root: requireString(section.media_root, 'paths.media_root'),
    youtube_transcript_root: requireString(section.youtube_transcript_root, 'paths.youtube_transcript_root')
  });
}

function buildSleepSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'sleep');

  return Object.freeze({
    timezone: requireString(section.timezone, 'sleep.timezone'),
    start_hhmm: requireString(section.start_hhmm, 'sleep.start_hhmm'),
    end_hhmm: requireString(section.end_hhmm, 'sleep.end_hhmm'),
    idle_resume_seconds: requireNumber(section.idle_resume_seconds, 'sleep.idle_resume_seconds'),
    rem_offsets_minutes: requireObject(section.rem_offsets_minutes, 'sleep.rem_offsets_minutes')
  });
}

function buildDreamSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'dream');

  return Object.freeze({
    temperature: requireNumber(section.temperature, 'dream.temperature'),
    top_p: requireNumber(section.top_p, 'dream.top_p'),
    num_predict: requireNumber(section.num_predict, 'dream.num_predict'),
    retry_temperature: requireNumber(section.retry_temperature, 'dream.retry_temperature'),
    retry_top_p: requireNumber(section.retry_top_p, 'dream.retry_top_p'),
    retry_num_predict: requireNumber(section.retry_num_predict, 'dream.retry_num_predict')
  });
}

function buildAudioSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'audio');

  return Object.freeze({
    mic_device: requireString(section.mic_device, 'audio.mic_device'),
    mic_rate: requireNumber(section.mic_rate, 'audio.mic_rate'),
    mic_channels: requireNumber(section.mic_channels, 'audio.mic_channels'),
    mic_format: requireString(section.mic_format, 'audio.mic_format'),
    live_capture_seconds: requireNumber(section.live_capture_seconds, 'audio.live_capture_seconds'),
    proof_capture_seconds: requireNumber(section.proof_capture_seconds, 'audio.proof_capture_seconds'),
    whisper_model_size: requireString(section.whisper_model_size, 'audio.whisper_model_size'),
    voice_lock_ttl_ms: requireNumber(section.voice_lock_ttl_ms, 'audio.voice_lock_ttl_ms'),
    piper_voice_name: requireString(section.piper_voice_name, 'audio.piper_voice_name'),
    piper_voice_size: requireString(section.piper_voice_size, 'audio.piper_voice_size')
  });
}

function buildTimeoutSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'timeouts');

  return Object.freeze({
    ollama_http_ms: requireNumber(section.ollama_http_ms, 'timeouts.ollama_http_ms'),
    model_warmup_ms: requireNumber(section.model_warmup_ms, 'timeouts.model_warmup_ms'),
    piper_synthesis_ms: requireNumber(section.piper_synthesis_ms, 'timeouts.piper_synthesis_ms'),
    speaker_playback_ms: requireNumber(section.speaker_playback_ms, 'timeouts.speaker_playback_ms'),
    vad_ms: requireNumber(section.vad_ms, 'timeouts.vad_ms'),
    whisper_ms: requireNumber(section.whisper_ms, 'timeouts.whisper_ms'),
    command_runner_ms: requireNumber(section.command_runner_ms, 'timeouts.command_runner_ms'),
    command_check_ms: requireNumber(section.command_check_ms, 'timeouts.command_check_ms'),
    knowledge_autoload_ms: requireNumber(section.knowledge_autoload_ms, 'timeouts.knowledge_autoload_ms'),
    speech_loop_start_ms: requireNumber(section.speech_loop_start_ms, 'timeouts.speech_loop_start_ms'),
    floki_chat_stop_ms: requireNumber(section.floki_chat_stop_ms, 'timeouts.floki_chat_stop_ms')
  });
}

function buildKnowledgeSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'knowledge');

  return Object.freeze({
    autoload_enabled: requireBoolean(section.autoload_enabled, 'knowledge.autoload_enabled'),
    autoload_min_seconds: requireNumber(section.autoload_min_seconds, 'knowledge.autoload_min_seconds'),
    ingestion_enabled_env: requireString(section.ingestion_enabled_env, 'knowledge.ingestion_enabled_env'),
    max_files: requireNumber(section.max_files, 'knowledge.max_files'),
    target_chunk_chars: requireNumber(section.target_chunk_chars, 'knowledge.target_chunk_chars'),
    max_chunk_chars: requireNumber(section.max_chunk_chars, 'knowledge.max_chunk_chars')
  });
}

function buildLiveChatSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'live_chat');

  return Object.freeze({
    warm_cognition_on_start: requireBoolean(section.warm_cognition_on_start, 'live_chat.warm_cognition_on_start'),
    warm_vision_on_start: requireBoolean(section.warm_vision_on_start, 'live_chat.warm_vision_on_start'),
    skip_model_warmup_env: requireString(section.skip_model_warmup_env, 'live_chat.skip_model_warmup_env'),
    live_reply_mode: requireString(section.live_reply_mode, 'live_chat.live_reply_mode'),
    stale_memory_topic_bleed_guard: requireBoolean(section.stale_memory_topic_bleed_guard, 'live_chat.stale_memory_topic_bleed_guard'),
    public_transcript_excludes_private_thoughts: requireBoolean(section.public_transcript_excludes_private_thoughts, 'live_chat.public_transcript_excludes_private_thoughts'),
    private_thought_review_log_enabled: requireBoolean(section.private_thought_review_log_enabled, 'live_chat.private_thought_review_log_enabled')
  });
}

function buildLifeClockSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'life_clock');

  return Object.freeze({
    ticks_per_second: requireNumber(section.ticks_per_second, 'life_clock.ticks_per_second'),
    ticks_per_day: requireNumber(section.ticks_per_day, 'life_clock.ticks_per_day'),
    real_seconds_per_day: requireNumber(section.real_seconds_per_day, 'life_clock.real_seconds_per_day'),
    phase_ticks: requireObject(section.phase_ticks, 'life_clock.phase_ticks')
  });
}

function getModelConfig(mode) {
  return loadFlokiConfig(mode).models;
}

function getPathConfig(mode) {
  return loadFlokiConfig(mode).paths;
}

function getSleepConfig(mode) {
  return loadFlokiConfig(mode).sleep;
}

function getDreamConfig(mode) {
  return loadFlokiConfig(mode).dream;
}

function getAudioConfig(mode) {
  return loadFlokiConfig(mode).audio;
}

function getTimeoutConfig(mode) {
  return loadFlokiConfig(mode).timeouts;
}

function getKnowledgeConfig(mode) {
  return loadFlokiConfig(mode).knowledge;
}

function getLiveChatConfig(mode) {
  return loadFlokiConfig(mode).live_chat;
}

function getLifeClockConfig(mode) {
  return loadFlokiConfig(mode).life_clock;
}

function resolveProjectPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new TypeError('relativePath must be a non-empty string');
  }
  if (path.isAbsolute(relativePath)) {
    throw new TypeError('relativePath must be relative, not absolute');
  }
  return path.resolve(PROJECT_ROOT, relativePath);
}

function resolveStatePath(mode, relativePath) {
  const paths = getPathConfig(mode);
  const stateRoot = paths.state_root;
  if (!relativePath) return path.resolve(PROJECT_ROOT, stateRoot);
  return path.resolve(PROJECT_ROOT, stateRoot, relativePath);
}

function resolveToolPath(mode, relativePath) {
  const paths = getPathConfig(mode);
  if (!relativePath) return path.resolve(PROJECT_ROOT, paths.tool_output_root);
  return path.resolve(PROJECT_ROOT, paths.tool_output_root, relativePath);
}

function resolveExternalPath(mode, key) {
  const paths = getPathConfig(mode);
  const value = paths[key];
  if (!value) throw new Error('unknown external path key: ' + key);
  return path.resolve(value);
}

function clearConfigCache() {
  cache.clear();
}

module.exports = {
  PROJECT_ROOT,
  CONFIG_VERSION,
  loadFlokiConfig,
  getModelConfig,
  getPathConfig,
  getSleepConfig,
  getDreamConfig,
  getAudioConfig,
  getTimeoutConfig,
  getKnowledgeConfig,
  getLiveChatConfig,
  getLifeClockConfig,
  resolveProjectPath,
  resolveStatePath,
  resolveToolPath,
  resolveExternalPath,
  clearConfigCache,
  configPathForMode
};

// Public config authority API compatibility layer.
// This is the stable API other runtime modules and shell checks should use.
if (typeof module.exports.getFlokiConfig !== 'function') {
  const _flokiConfigPath = require('node:path');
  const { loadYamlFile: _loadFlokiYamlFile } = require('./yaml-lite.cjs');
  const _FLOKI_PROJECT_ROOT = _flokiConfigPath.resolve(__dirname, '..', '..');

  function _requiredObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('missing required YAML section: ' + label);
    }
    return value;
  }

  function _resolveEnvOrDefault(section, envKeyName, defaultKeyName) {
    const envName = section && section[envKeyName];
    if (envName && process.env[envName]) return process.env[envName];
    return section ? section[defaultKeyName] : undefined;
  }

  function _normalizeModel(section, label) {
    _requiredObject(section, label);
    const model = _resolveEnvOrDefault(section, 'model_env', 'model_default');
    const endpoint = _resolveEnvOrDefault(section, 'endpoint_env', 'endpoint_default');
    if (typeof model !== 'string' || model.trim() === '') throw new Error(label + '.model must be configured in YAML/env');
    if (typeof endpoint !== 'string' || endpoint.trim() === '') throw new Error(label + '.endpoint must be configured in YAML/env');
    return Object.freeze({
      provider: section.provider || 'ollama',
      model,
      endpoint,
      enabled_now: section.enabled_now === true,
      mode_scope: section.mode_scope || '',
      temperature: section.temperature,
      top_p: section.top_p,
      timeout_ms: section.timeout_ms,
      keep_alive: section.keep_alive
    });
  }

  function _resolvePathValue(value) {
    if (typeof value !== 'string' || value.trim() === '') return value;
    if (_flokiConfigPath.isAbsolute(value)) return value;
    return _flokiConfigPath.resolve(_FLOKI_PROJECT_ROOT, value);
  }

  function _normalizePaths(paths) {
    const section = _requiredObject(paths, 'paths');
    const out = {};
    for (const [key, value] of Object.entries(section)) {
      out[key] = _resolvePathValue(value);
    }
    return Object.freeze(out);
  }

  function _configPathForMode(mode) {
    if (mode === 'chat') return _flokiConfigPath.join(_FLOKI_PROJECT_ROOT, 'config', 'chat.config.yaml');
    if (mode === 'game') return _flokiConfigPath.join(_FLOKI_PROJECT_ROOT, 'config', 'game.config.yaml');
    throw new Error('unknown Floki config mode: ' + mode);
  }

  module.exports.getFlokiConfig = function getFlokiConfig(mode = 'chat') {
    const filePath = _configPathForMode(mode);
    const raw = _loadFlokiYamlFile(filePath);
    _requiredObject(raw.models, 'models');
    return Object.freeze({
      schema_version: raw.schema_version,
      mode: raw.mode || mode,
      source_path: filePath,
      project_root: _FLOKI_PROJECT_ROOT,
      models: Object.freeze({
        cognition: _normalizeModel(raw.models.cognition, 'models.cognition'),
        vision: _normalizeModel(raw.models.vision, 'models.vision')
      }),
      modules: Object.freeze(_requiredObject(raw.modules, 'modules')),
      policies: Object.freeze(_requiredObject(raw.policies, 'policies')),
      embodiment: Object.freeze(_requiredObject(raw.embodiment, 'embodiment')),
      paths: _normalizePaths(raw.paths),
      sleep: Object.freeze(_requiredObject(raw.sleep, 'sleep')),
      dream: Object.freeze(_requiredObject(raw.dream, 'dream')),
      audio: Object.freeze(_requiredObject(raw.audio, 'audio')),
      timeouts: Object.freeze(_requiredObject(raw.timeouts, 'timeouts')),
      knowledge: Object.freeze(_requiredObject(raw.knowledge, 'knowledge')),
      live_chat: Object.freeze(_requiredObject(raw.live_chat, 'live_chat')),
      life_clock: Object.freeze(_requiredObject(raw.life_clock, 'life_clock'))
    });
  };
}
