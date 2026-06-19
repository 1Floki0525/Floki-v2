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

  const configDraft = {
    schema_version: raw.schema_version,
    mode: raw.mode,
    models: Object.freeze({
      cognition: buildModelSection(raw.models.cognition, mode, 'cognition'),
      vision: buildModelSection(raw.models.vision, mode, 'vision')
    }),
    modules: Object.freeze(raw.modules || {}),
    policies: Object.freeze(raw.policies || {}),
    vision: buildVisionSection(raw.vision, mode),
    pineal_vision: buildPinealVisionSection(raw.pineal_vision, mode),
    embodiment: Object.freeze(raw.embodiment || {}),
    paths: buildPathsSection(raw.paths, mode),
    sleep: buildSleepSection(raw.sleep, mode),
    dream: buildDreamSection(raw.dream, mode),
    timeouts: buildTimeoutSection(raw.timeouts, mode),
    knowledge: buildKnowledgeSection(raw.knowledge, mode),
    life_clock: buildLifeClockSection(raw.life_clock, mode),
    _raw: raw,
    source_path: configPathForMode(mode)
  };

  if (mode === 'chat') {
    configDraft.chat_world_vision = buildChatWorldVisionSection(raw.chat_world_vision, mode);
    configDraft.audio = buildAudioSection(raw.audio, mode);
    configDraft.live_chat = buildLiveChatSection(raw.live_chat, mode);
    if (raw.game_world_vision !== undefined) {
      throw new Error('chat config must not contain inactive game_world_vision section');
    }
  }

  if (mode === 'game') {
    configDraft.game_world_vision = buildGameWorldVisionSection(raw.game_world_vision, mode);
    if (raw.chat_world_vision !== undefined) {
      throw new Error('game config must not contain inactive chat_world_vision section');
    }
  }

  const config = Object.freeze(configDraft);

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
    provider: requireString(section.provider, 'models.' + label + '.provider'),
    model,
    endpoint,
    enabled_now: section.enabled_now === true,
    mode_scope: requireString(section.mode_scope, 'models.' + label + '.mode_scope'),
    temperature: requireNumber(section.temperature, 'models.' + label + '.temperature'),
    top_p: requireNumber(section.top_p, 'models.' + label + '.top_p'),
    timeout_ms: requireNumber(section.timeout_ms, 'models.' + label + '.timeout_ms'),
    keep_alive: requireString(section.keep_alive, 'models.' + label + '.keep_alive')
  });
}

function buildVisionSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'vision');

  return Object.freeze({
    external_eyes_enabled: requireBoolean(section.external_eyes_enabled, 'vision.external_eyes_enabled'),
    external_eyes_source: requireString(section.external_eyes_source, 'vision.external_eyes_source'),
    inner_vision_source: requireString(section.inner_vision_source, 'vision.inner_vision_source'),
    target_capture_fps: requireNumber(section.target_capture_fps, 'vision.target_capture_fps'),
    frame_width: requireNumber(section.frame_width, 'vision.frame_width'),
    frame_height: requireNumber(section.frame_height, 'vision.frame_height'),
    frame_buffer_size: requireNumber(section.frame_buffer_size, 'vision.frame_buffer_size'),
    frame_retention_seconds: requireNumber(section.frame_retention_seconds, 'vision.frame_retention_seconds'),
    capture_timeout_grace_ms: requireNumber(section.capture_timeout_grace_ms, 'vision.capture_timeout_grace_ms'),
    vlm_inference_enabled: requireBoolean(section.vlm_inference_enabled, 'vision.vlm_inference_enabled'),
    vlm_inference_every_n_frames: requireNumber(section.vlm_inference_every_n_frames, 'vision.vlm_inference_every_n_frames'),
    vlm_inference_min_interval_ms: requireNumber(section.vlm_inference_min_interval_ms, 'vision.vlm_inference_min_interval_ms'),
    vision_model_env: requireString(section.vision_model_env, 'vision.vision_model_env'),
    vision_endpoint_env: requireString(section.vision_endpoint_env, 'vision.vision_endpoint_env'),
    observation_summary_enabled: requireBoolean(section.observation_summary_enabled, 'vision.observation_summary_enabled'),
    raw_frame_storage_enabled: requireBoolean(section.raw_frame_storage_enabled, 'vision.raw_frame_storage_enabled'),
    public_frame_logging_enabled: requireBoolean(section.public_frame_logging_enabled, 'vision.public_frame_logging_enabled'),
    private_observation_log_enabled: requireBoolean(section.private_observation_log_enabled, 'vision.private_observation_log_enabled'),
    ...(mode === 'chat' ? {
      latest_observation_max_age_ms: requireNumber(section.latest_observation_max_age_ms, 'vision.latest_observation_max_age_ms'),
      vlm_inference_max_attempts: requireNumber(section.vlm_inference_max_attempts, 'vision.vlm_inference_max_attempts'),
      vlm_inference_retry_delay_ms: requireNumber(section.vlm_inference_retry_delay_ms, 'vision.vlm_inference_retry_delay_ms'),
      vlm_max_consecutive_failures: requireNumber(section.vlm_max_consecutive_failures, 'vision.vlm_max_consecutive_failures'),
      webcam_device_env: requireString(section.webcam_device_env, 'vision.webcam_device_env'),
      webcam_device_default: requireString(section.webcam_device_default, 'vision.webcam_device_default'),
      webcam_backend: requireString(section.webcam_backend, 'vision.webcam_backend'),
      webcam_capture_command: requireString(section.webcam_capture_command, 'vision.webcam_capture_command'),
      webcam_capture_allow_env: requireString(section.webcam_capture_allow_env, 'vision.webcam_capture_allow_env'),
      chat_vision_allow_env: requireString(section.chat_vision_allow_env, 'vision.chat_vision_allow_env'),
      vlm_ssh_tunnel_enabled: requireBoolean(section.vlm_ssh_tunnel_enabled, 'vision.vlm_ssh_tunnel_enabled'),
      vlm_ssh_tunnel_target: requireString(section.vlm_ssh_tunnel_target, 'vision.vlm_ssh_tunnel_target'),
      vlm_ssh_tunnel_local_host: requireString(section.vlm_ssh_tunnel_local_host, 'vision.vlm_ssh_tunnel_local_host'),
      vlm_ssh_tunnel_local_port: requireNumber(section.vlm_ssh_tunnel_local_port, 'vision.vlm_ssh_tunnel_local_port'),
      vlm_ssh_tunnel_remote_host: requireString(section.vlm_ssh_tunnel_remote_host, 'vision.vlm_ssh_tunnel_remote_host'),
      vlm_ssh_tunnel_remote_port: requireNumber(section.vlm_ssh_tunnel_remote_port, 'vision.vlm_ssh_tunnel_remote_port'),
      vlm_ssh_tunnel_socket_name: requireString(section.vlm_ssh_tunnel_socket_name, 'vision.vlm_ssh_tunnel_socket_name'),
      vlm_ssh_tunnel_required_model: requireString(section.vlm_ssh_tunnel_required_model, 'vision.vlm_ssh_tunnel_required_model'),
      vlm_ssh_tunnel_check_timeout_ms: requireNumber(section.vlm_ssh_tunnel_check_timeout_ms, 'vision.vlm_ssh_tunnel_check_timeout_ms')
    } : {})
  });
}

function buildChatWorldVisionSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'chat_world_vision');

  return Object.freeze({
    enabled: requireBoolean(section.enabled, 'chat_world_vision.enabled'),
    source: requireString(section.source, 'chat_world_vision.source'),
    target_fps: requireNumber(section.target_fps, 'chat_world_vision.target_fps'),
    sight_scope: requireString(section.sight_scope, 'chat_world_vision.sight_scope'),
    used_as_game_world_eyes: requireBoolean(section.used_as_game_world_eyes, 'chat_world_vision.used_as_game_world_eyes'),
    nonblocking_audio_loop: requireBoolean(section.nonblocking_audio_loop, 'chat_world_vision.nonblocking_audio_loop'),
    self_echo_prevention: requireBoolean(section.self_echo_prevention, 'chat_world_vision.self_echo_prevention')
  });
}

function buildGameWorldVisionSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'game_world_vision');

  return Object.freeze({
    enabled: requireBoolean(section.enabled, 'game_world_vision.enabled'),
    source: requireString(section.source, 'game_world_vision.source'),
    target_fps: requireNumber(section.target_fps, 'game_world_vision.target_fps'),
    sight_scope: requireString(section.sight_scope, 'game_world_vision.sight_scope'),
    starts_only_with_game_mode: requireBoolean(section.starts_only_with_game_mode, 'game_world_vision.starts_only_with_game_mode')
  });
}

function buildPinealVisionSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'pineal_vision');

  return Object.freeze({
    enabled: requireBoolean(section.enabled, 'pineal_vision.enabled'),
    source: requireString(section.source, 'pineal_vision.source'),
    used_while_sleeping: requireBoolean(section.used_while_sleeping, 'pineal_vision.used_while_sleeping'),
    used_while_dreaming: requireBoolean(section.used_while_dreaming, 'pineal_vision.used_while_dreaming'),
    used_while_reflecting: requireBoolean(section.used_while_reflecting, 'pineal_vision.used_while_reflecting'),
    pause_external_eyes_while_sleeping: requireBoolean(section.pause_external_eyes_while_sleeping, 'pineal_vision.pause_external_eyes_while_sleeping'),
    public_transcript_visible: requireBoolean(section.public_transcript_visible, 'pineal_vision.public_transcript_visible'),
    spoken_aloud: requireBoolean(section.spoken_aloud, 'pineal_vision.spoken_aloud'),
    derive_from_memories: requireBoolean(section.derive_from_memories, 'pineal_vision.derive_from_memories'),
    derive_from_youtube_transcripts: requireBoolean(section.derive_from_youtube_transcripts, 'pineal_vision.derive_from_youtube_transcripts'),
    derive_from_conversations: requireBoolean(section.derive_from_conversations, 'pineal_vision.derive_from_conversations'),
    derive_from_minecraft_experience: requireBoolean(section.derive_from_minecraft_experience, 'pineal_vision.derive_from_minecraft_experience'),
    derive_from_emotions: requireBoolean(section.derive_from_emotions, 'pineal_vision.derive_from_emotions'),
    derive_from_personality: requireBoolean(section.derive_from_personality, 'pineal_vision.derive_from_personality'),
    derive_from_beliefs: requireBoolean(section.derive_from_beliefs, 'pineal_vision.derive_from_beliefs'),
    private_inner_vision_subdir: requireString(section.private_inner_vision_subdir, 'pineal_vision.private_inner_vision_subdir'),
    private_inner_vision_log_name: requireString(section.private_inner_vision_log_name, 'pineal_vision.private_inner_vision_log_name')
  });
}

function buildPathsSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'paths');

  return Object.freeze({
    state_root: requireString(section.state_root, 'paths.state_root'),
    tool_input_root: requireString(section.tool_input_root, 'paths.tool_input_root'),
    tool_output_root: requireString(section.tool_output_root, 'paths.tool_output_root'),
    runtime_root: requireString(section.runtime_root, 'paths.runtime_root'),
    dream_root: requireString(section.dream_root, 'paths.dream_root'),
    media_root: requireString(section.media_root, 'paths.media_root'),
    youtube_transcript_root: requireString(section.youtube_transcript_root, 'paths.youtube_transcript_root'),
    ...(mode === 'chat' ? {
      chat_runtime_root: requireString(section.chat_runtime_root, 'paths.chat_runtime_root'),
      chat_transcript_root: requireString(section.chat_transcript_root, 'paths.chat_transcript_root')
    } : {})
  });
}

function buildSleepSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'sleep');

  return Object.freeze({
    timezone: requireString(section.timezone, 'sleep.timezone'),
    start_hhmm: requireString(section.start_hhmm, 'sleep.start_hhmm'),
    end_hhmm: requireString(section.end_hhmm, 'sleep.end_hhmm'),
    idle_resume_seconds: requireNumber(section.idle_resume_seconds, 'sleep.idle_resume_seconds'),
    rem_offsets_minutes: requireObject(section.rem_offsets_minutes, 'sleep.rem_offsets_minutes'),
    lifecycle_status_poll_ms: requireNumber(section.lifecycle_status_poll_ms, 'sleep.lifecycle_status_poll_ms'),
    lifecycle_transition_notifications_enabled: requireBoolean(section.lifecycle_transition_notifications_enabled, 'sleep.lifecycle_transition_notifications_enabled')
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
    retry_num_predict: requireNumber(section.retry_num_predict, 'dream.retry_num_predict'),
    min_story_words: requireNumber(section.min_story_words, 'dream.min_story_words'),
    target_story_words: requireNumber(section.target_story_words, 'dream.target_story_words'),
    max_story_words: requireNumber(section.max_story_words, 'dream.max_story_words'),
    min_story_sentences: requireNumber(section.min_story_sentences, 'dream.min_story_sentences'),
    min_symbols: requireNumber(section.min_symbols, 'dream.min_symbols'),
    min_consolidation_words: requireNumber(section.min_consolidation_words, 'dream.min_consolidation_words'),
    min_reflection_words: requireNumber(section.min_reflection_words, 'dream.min_reflection_words'),
    recent_memory_hours: requireNumber(section.recent_memory_hours, 'dream.recent_memory_hours'),
    recent_memory_limit: requireNumber(section.recent_memory_limit, 'dream.recent_memory_limit'),
    long_term_memory_limit: requireNumber(section.long_term_memory_limit, 'dream.long_term_memory_limit'),
    knowledge_limit: requireNumber(section.knowledge_limit, 'dream.knowledge_limit'),
    grounding_memory_limit: requireNumber(section.grounding_memory_limit, 'dream.grounding_memory_limit'),
    grounding_knowledge_limit: requireNumber(section.grounding_knowledge_limit, 'dream.grounding_knowledge_limit'),
    recent_dream_avoidance_count: requireNumber(section.recent_dream_avoidance_count, 'dream.recent_dream_avoidance_count'),
    quality_regeneration_attempts: requireNumber(section.quality_regeneration_attempts, 'dream.quality_regeneration_attempts')
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
    private_thought_review_log_enabled: requireBoolean(section.private_thought_review_log_enabled, 'live_chat.private_thought_review_log_enabled'),
    public_response_streaming_enabled: requireBoolean(section.public_response_streaming_enabled, 'live_chat.public_response_streaming_enabled'),
    first_sentence_tts_enabled: requireBoolean(section.first_sentence_tts_enabled, 'live_chat.first_sentence_tts_enabled'),
    latency_events_enabled: requireBoolean(section.latency_events_enabled, 'live_chat.latency_events_enabled'),
    public_response_max_tokens: requireNumber(section.public_response_max_tokens, 'live_chat.public_response_max_tokens'),
    stream_timeout_ms: requireNumber(section.stream_timeout_ms, 'live_chat.stream_timeout_ms'),
    public_sentence_min_characters: requireNumber(section.public_sentence_min_characters, 'live_chat.public_sentence_min_characters'),
    latency_log_max_bytes: requireNumber(section.latency_log_max_bytes, 'live_chat.latency_log_max_bytes')
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
  if (mode !== 'chat') throw new Error('audio config is chat-mode only');
  return loadFlokiConfig(mode).audio;
}

function getTimeoutConfig(mode) {
  return loadFlokiConfig(mode).timeouts;
}

function getKnowledgeConfig(mode) {
  return loadFlokiConfig(mode).knowledge;
}

function getLiveChatConfig(mode) {
  if (mode !== 'chat') throw new Error('live chat config is chat-mode only');
  return loadFlokiConfig(mode).live_chat;
}

function getLifeClockConfig(mode) {
  return loadFlokiConfig(mode).life_clock;
}

function getVisionConfig(mode) {
  return loadFlokiConfig(mode).vision;
}

function getChatWorldVisionConfig(mode) {
  if (mode !== 'chat') throw new Error('chat_world_vision config is chat-mode only');
  return loadFlokiConfig(mode).chat_world_vision;
}

function getGameWorldVisionConfig(mode) {
  if (mode !== 'game') throw new Error('game_world_vision config is game-mode only');
  return loadFlokiConfig(mode).game_world_vision;
}

function getPinealVisionConfig(mode) {
  return loadFlokiConfig(mode).pineal_vision;
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
  getVisionConfig,
  getChatWorldVisionConfig,
  getGameWorldVisionConfig,
  getPinealVisionConfig,
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
      provider: requireString(section.provider, label + '.provider'),
      model,
      endpoint,
      enabled_now: section.enabled_now === true,
      mode_scope: requireString(section.mode_scope, label + '.mode_scope'),
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
    const config = {
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
      vision: Object.freeze(_requiredObject(raw.vision, 'vision')),
      pineal_vision: Object.freeze(_requiredObject(raw.pineal_vision, 'pineal_vision')),
      embodiment: Object.freeze(_requiredObject(raw.embodiment, 'embodiment')),
      paths: _normalizePaths(raw.paths),
      sleep: Object.freeze(_requiredObject(raw.sleep, 'sleep')),
      dream: Object.freeze(_requiredObject(raw.dream, 'dream')),
      timeouts: Object.freeze(_requiredObject(raw.timeouts, 'timeouts')),
      knowledge: Object.freeze(_requiredObject(raw.knowledge, 'knowledge')),
      life_clock: Object.freeze(_requiredObject(raw.life_clock, 'life_clock'))
    };
    if (mode === 'chat') {
      config.chat_world_vision = Object.freeze(_requiredObject(raw.chat_world_vision, 'chat_world_vision'));
      config.audio = Object.freeze(_requiredObject(raw.audio, 'audio'));
      config.live_chat = Object.freeze(_requiredObject(raw.live_chat, 'live_chat'));
    } else if (mode === 'game') {
      config.game_world_vision = Object.freeze(_requiredObject(raw.game_world_vision, 'game_world_vision'));
    }
    return Object.freeze(config);
  };
}
// FLOKI_V2_WEBCAM_CAPTURE_CONFIG_AUTHORITY_PATCH
// Expose webcam_capture from YAML through the public config authority.
// This keeps webcam runtime settings YAML-driven instead of hidden in source.
(function patchWebcamCaptureConfigAuthority() {
  const path = require('node:path');
  const { loadYamlFile } = require('./yaml-lite.cjs');

  const originalGetFlokiConfig = module.exports.getFlokiConfig;
  if (typeof originalGetFlokiConfig !== 'function') {
    throw new Error('getFlokiConfig must exist before webcam_capture authority patch');
  }

  const projectRoot = path.resolve(__dirname, '..', '..');

  function configPathForMode(mode) {
    if (mode === 'chat') return path.join(projectRoot, 'config', 'chat.config.yaml');
    if (mode === 'game') return path.join(projectRoot, 'config', 'game.config.yaml');
    throw new Error('unknown Floki config mode for webcam_capture: ' + mode);
  }

  function requiredObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('missing required YAML section: ' + label);
    }
    return Object.freeze({ ...value });
  }

  module.exports.getFlokiConfig = function getFlokiConfigWithWebcamCapture(mode = 'chat') {
    const config = originalGetFlokiConfig(mode);
    if (config.webcam_capture && typeof config.webcam_capture === 'object') {
      return config;
    }
    const raw = loadYamlFile(configPathForMode(mode));
    if (raw.webcam_capture === undefined) {
      return config;
    }
    return Object.freeze({
      ...config,
      webcam_capture: requiredObject(raw.webcam_capture, 'webcam_capture')
    });
  };
}());
