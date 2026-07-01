'use strict';

/**
 * Floki-v2 config authority layer.
 *
 * Single source of truth for all runtime configuration.
 * Loads config/chat.config.yaml or config/game.config.yaml
 * and provides typed accessors for every config section.
 *
 * No module should hardcode operational config values.
 * Model selection comes only from YAML. Non-model operational settings
 * may use environment overrides declared explicitly in YAML.
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
    configDraft.detection = buildDetectionSection(raw.detection, mode);
    configDraft.chat_world_vision = buildChatWorldVisionSection(raw.chat_world_vision, mode);
    configDraft.wake_gate = buildWakeGateSection(raw.wake_gate, mode);
    configDraft.audio = buildAudioSection(raw.audio, mode);
    configDraft.live_chat = buildLiveChatSection(raw.live_chat, mode);
    configDraft.interface_yaml = buildInterfaceYamlSection(raw.interface, mode);
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

  const model = section.model;
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

  let directQuestionPhrases = null;
  let prohibitedPublicVisionTerms = null;
  let visionHardwareQuestionPhrases = null;
  if (mode === 'chat') {
    directQuestionPhrases = requireObject(section.direct_question_phrases, 'vision.direct_question_phrases');
    prohibitedPublicVisionTerms = requireObject(section.prohibited_public_vision_terms, 'vision.prohibited_public_vision_terms');
    visionHardwareQuestionPhrases = requireObject(section.vision_hardware_question_phrases, 'vision.vision_hardware_question_phrases');
    for (const [key, value] of Object.entries(directQuestionPhrases)) {
      requireString(value, 'vision.direct_question_phrases.' + key);
    }
    for (const [key, value] of Object.entries(prohibitedPublicVisionTerms)) {
      requireString(value, 'vision.prohibited_public_vision_terms.' + key);
    }
    for (const [key, value] of Object.entries(visionHardwareQuestionPhrases)) {
      requireString(value, 'vision.vision_hardware_question_phrases.' + key);
    }
  }

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
    vision_endpoint_env: requireString(section.vision_endpoint_env, 'vision.vision_endpoint_env'),
    observation_summary_enabled: requireBoolean(section.observation_summary_enabled, 'vision.observation_summary_enabled'),
    raw_frame_storage_enabled: requireBoolean(section.raw_frame_storage_enabled, 'vision.raw_frame_storage_enabled'),
    public_frame_logging_enabled: requireBoolean(section.public_frame_logging_enabled, 'vision.public_frame_logging_enabled'),
    private_observation_log_enabled: requireBoolean(section.private_observation_log_enabled, 'vision.private_observation_log_enabled'),
    ...(mode === 'chat' ? {
      latest_observation_max_age_ms: requireNumber(section.latest_observation_max_age_ms, 'vision.latest_observation_max_age_ms'),
      vlm_inference_max_attempts: requireNumber(section.vlm_inference_max_attempts, 'vision.vlm_inference_max_attempts'),
      detection_continue_during_vlm: requireBoolean(section.detection_continue_during_vlm, 'vision.detection_continue_during_vlm'),
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
      vlm_ssh_tunnel_check_timeout_ms: requireNumber(section.vlm_ssh_tunnel_check_timeout_ms, 'vision.vlm_ssh_tunnel_check_timeout_ms'),
    desired_state_gates_required_for_start: requireString(section.desired_state_gates_required_for_start, 'vision.desired_state_gates_required_for_start'),
    sleep_overrides_vision_start: requireBoolean(section.sleep_overrides_vision_start, 'vision.sleep_overrides_vision_start'),
    vision_camera_stop_timeout_ms: requireNumber(section.vision_camera_stop_timeout_ms, 'vision.vision_camera_stop_timeout_ms'),
    vision_camera_availability_probe_timeout_ms: requireNumber(section.vision_camera_availability_probe_timeout_ms, 'vision.vision_camera_availability_probe_timeout_ms'),
      vision_question_max_age_ms: requireNumber(section.vision_question_max_age_ms, 'vision.vision_question_max_age_ms'),
      vision_question_wait_ms: requireNumber(section.vision_question_wait_ms, 'vision.vision_question_wait_ms'),
      cognition_scene_max_detected_objects: requireNumber(section.cognition_scene_max_detected_objects, 'vision.cognition_scene_max_detected_objects'),
      cognition_scene_require_narrative: requireBoolean(section.cognition_scene_require_narrative, 'vision.cognition_scene_require_narrative'),
      cognition_scene_instruction: requireString(section.cognition_scene_instruction, 'vision.cognition_scene_instruction'),
      cognition_unavailable_instruction: requireString(section.cognition_unavailable_instruction, 'vision.cognition_unavailable_instruction'),
      prohibited_public_vision_terms: Object.freeze({ ...prohibitedPublicVisionTerms }),
      vision_hardware_question_phrases: Object.freeze({ ...visionHardwareQuestionPhrases }),
      direct_question_phrases: Object.freeze({ ...directQuestionPhrases })
    } : {})
  });
}

function buildDetectionSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'detection');

  const detection = requireObject(section, 'detection');
  const prompts = detection.grounding_dino_prompts;

  if (prompts !== undefined) {
    requireObject(prompts, 'detection.grounding_dino_prompts');
  }

  return Object.freeze({
    ...detection,
    ...(prompts === undefined
      ? {}
      : {
          grounding_dino_prompts: Object.freeze({ ...prompts })
        })
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

function buildInterfaceYamlSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'interface');
  const conn = requireObject(section.connection, 'interface.connection');
  return Object.freeze({
    settings_version: requireNumber(section.settings_version, 'interface.settings_version'),
    connection: Object.freeze({
      transport: requireString(conn.transport, 'interface.connection.transport'),
      local_api_url: requireString(conn.local_api_url, 'interface.connection.local_api_url'),
      local_ws_url: requireString(conn.local_ws_url, 'interface.connection.local_ws_url'),
      auto_reconnect: requireBoolean(conn.auto_reconnect, 'interface.connection.auto_reconnect'),
      reconnect_delay_ms: requireNumber(conn.reconnect_delay_ms, 'interface.connection.reconnect_delay_ms'),
      reconnect_jitter_ms: requireNumber(conn.reconnect_jitter_ms, 'interface.connection.reconnect_jitter_ms'),
      reconnect_backoff_max_ms: requireNumber(conn.reconnect_backoff_max_ms, 'interface.connection.reconnect_backoff_max_ms'),
      max_reconnect_attempts: requireNumber(conn.max_reconnect_attempts, 'interface.connection.max_reconnect_attempts'),
      request_timeout_ms: requireNumber(conn.request_timeout_ms, 'interface.connection.request_timeout_ms'),
      mock_mode: requireBoolean(conn.mock_mode, 'interface.connection.mock_mode')
    })
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
      text_root: requireString(section.text_root, 'paths.text_root'),
      chat_runtime_root: requireString(section.chat_runtime_root, 'paths.chat_runtime_root'),
      chat_transcript_root: requireString(section.chat_transcript_root, 'paths.chat_transcript_root'),
      youtube_cookies_file: requireString(section.youtube_cookies_file, 'paths.youtube_cookies_file')
    } : {})
  });
}

function validateTimezone(value, fieldName) {
  const timezone = requireString(value, fieldName);
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(0));
  } catch (error) {
    throw new Error(fieldName + ' must be a valid IANA timezone: ' + error.message);
  }
  return timezone;
}

function buildSleepSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'sleep');

  const remIntervalMinutes = requireNumber(section.rem_interval_minutes, 'sleep.rem_interval_minutes');
  if (remIntervalMinutes <= 0) throw new Error('sleep.rem_interval_minutes must be greater than zero');

  return Object.freeze({
    timezone: validateTimezone(section.timezone, 'sleep.timezone'),
    start_hhmm: requireString(section.start_hhmm, 'sleep.start_hhmm'),
    end_hhmm: requireString(section.end_hhmm, 'sleep.end_hhmm'),
    idle_resume_seconds: requireNumber(section.idle_resume_seconds, 'sleep.idle_resume_seconds'),
    rem_interval_minutes: remIntervalMinutes,
    rem_offsets_minutes: requireObject(section.rem_offsets_minutes, 'sleep.rem_offsets_minutes'),
    lifecycle_status_poll_ms: requireNumber(section.lifecycle_status_poll_ms, 'sleep.lifecycle_status_poll_ms'),
    ...(mode === 'chat' ? {
      scheduler_tick_ms: requireNumber(section.scheduler_tick_ms, 'sleep.scheduler_tick_ms'),
      scheduler_heartbeat_refresh_ms: requireNumber(section.scheduler_heartbeat_refresh_ms, 'sleep.scheduler_heartbeat_refresh_ms'),
      scheduler_heartbeat_stale_ms: requireNumber(section.scheduler_heartbeat_stale_ms, 'sleep.scheduler_heartbeat_stale_ms')
    } : {}),
    lifecycle_transition_notifications_enabled: requireBoolean(section.lifecycle_transition_notifications_enabled, 'sleep.lifecycle_transition_notifications_enabled'),
    manual_nap_duration_minutes: requireNumber(section.manual_nap_duration_minutes, 'sleep.manual_nap_duration_minutes'),
    manual_nap_rem_offset_minutes: (() => { const value = requireNumber(section.manual_nap_rem_offset_minutes, 'sleep.manual_nap_rem_offset_minutes'); if (value < 0) throw new Error('sleep.manual_nap_rem_offset_minutes must be zero or greater'); return value; })(),
    manual_nap_max_rem_cycles: requireNumber(section.manual_nap_max_rem_cycles, 'sleep.manual_nap_max_rem_cycles'),
    manual_nap_dream_max_retry_count: requireNumber(section.manual_nap_dream_max_retry_count, 'sleep.manual_nap_dream_max_retry_count')
  });
}

function requireNoveltyThresholds(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(fieldName + ' must be an object');
  }
  const keys = [
    'opening_similarity',
    'narrative_arc_similarity',
    'scene_progression_similarity',
    'ending_similarity',
    'paraphrase_similarity',
    'symbol_sequence_similarity'
  ];
  const out = {};
  for (const key of keys) {
    const num = Number(value[key]);
    if (!Number.isFinite(num)) {
      throw new TypeError(fieldName + '.' + key + ' must be a finite number');
    }
    out[key] = num;
  }
  return Object.freeze(out);
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
    ...(mode === 'chat' ? {
      retry_temperature_step: requireNumber(section.retry_temperature_step, 'dream.retry_temperature_step'),
      retry_temperature_max: requireNumber(section.retry_temperature_max, 'dream.retry_temperature_max'),
      retry_top_p_step: requireNumber(section.retry_top_p_step, 'dream.retry_top_p_step'),
      retry_top_p_max: requireNumber(section.retry_top_p_max, 'dream.retry_top_p_max')
    } : {}),
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
    quality_regeneration_attempts: requireNumber(section.quality_regeneration_attempts, 'dream.quality_regeneration_attempts'),
    quality_retry_backoff_seconds: requireNumber(section.quality_retry_backoff_seconds, 'dream.quality_retry_backoff_seconds'),
    quality_retry_backoff_max_seconds: requireNumber(section.quality_retry_backoff_max_seconds, 'dream.quality_retry_backoff_max_seconds'),
    max_dream_retry_per_cycle: requireNumber(section.max_dream_retry_per_cycle, 'dream.max_dream_retry_per_cycle'),
    max_quality_retry_per_cycle: requireNumber(section.max_quality_retry_per_cycle, 'dream.max_quality_retry_per_cycle'),
    novelty_thresholds: requireNoveltyThresholds(section.novelty_thresholds, 'dream.novelty_thresholds')
  });
}

function buildWakeGateSection(section, mode) {
  if (!section) failMissingYamlKey(mode, 'wake_gate');
  const wakeGate = requireObject(section, 'wake_gate');
  const acceptedMap = requireObject(wakeGate.accepted_phrases, 'wake_gate.accepted_phrases');
  const acceptedPhrases = {};
  for (const [key, value] of Object.entries(acceptedMap)) {
    acceptedPhrases[key] = requireString(value, 'wake_gate.accepted_phrases.' + key);
  }
  if (Object.keys(acceptedPhrases).length === 0) {
    throw new Error('wake_gate.accepted_phrases must contain at least one configured phrase');
  }
  return Object.freeze({
    required_phrase: requireString(wakeGate.required_phrase, 'wake_gate.required_phrase'),
    accepted_phrases: Object.freeze(acceptedPhrases),
    spoken_input_requires_wake_phrase: requireBoolean(wakeGate.spoken_input_requires_wake_phrase, 'wake_gate.spoken_input_requires_wake_phrase'),
    typed_input_requires_wake_phrase: requireBoolean(wakeGate.typed_input_requires_wake_phrase, 'wake_gate.typed_input_requires_wake_phrase'),
    case_insensitive: requireBoolean(wakeGate.case_insensitive, 'wake_gate.case_insensitive'),
    trim_punctuation: requireBoolean(wakeGate.trim_punctuation, 'wake_gate.trim_punctuation'),
    may_ignore_unaddressed_background_speech: requireBoolean(wakeGate.may_ignore_unaddressed_background_speech, 'wake_gate.may_ignore_unaddressed_background_speech')
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
    live_loop_turns: requireNumber(section.live_loop_turns, 'audio.live_loop_turns'),
    live_loop_restart_seconds: requireNumber(section.live_loop_restart_seconds, 'audio.live_loop_restart_seconds'),
    recorder_max_restarts: requireNumber(section.recorder_max_restarts, 'audio.recorder_max_restarts'),
    recorder_restart_backoff_max_ms: requireNumber(section.recorder_restart_backoff_max_ms, 'audio.recorder_restart_backoff_max_ms'),
    recorder_stop_timeout_ms: requireNumber(section.recorder_stop_timeout_ms, 'audio.recorder_stop_timeout_ms'),
    microphone_readiness_poll_ms: requireNumber(section.microphone_readiness_poll_ms, 'audio.microphone_readiness_poll_ms'),
    microphone_readiness_timeout_ms: requireNumber(section.microphone_readiness_timeout_ms, 'audio.microphone_readiness_timeout_ms'),
    vad_frame_samples: requireNumber(section.vad_frame_samples, 'audio.vad_frame_samples'),
    pre_roll_ms: requireNumber(section.pre_roll_ms, 'audio.pre_roll_ms'),
    post_roll_ms: requireNumber(section.post_roll_ms, 'audio.post_roll_ms'),
    attention_scan_enabled: requireBoolean(section.attention_scan_enabled, 'audio.attention_scan_enabled'),
    attention_scan_window_ms: requireNumber(section.attention_scan_window_ms, 'audio.attention_scan_window_ms'),
    attention_scan_interval_ms: requireNumber(section.attention_scan_interval_ms, 'audio.attention_scan_interval_ms'),
    attention_followup_interval_ms: requireNumber(section.attention_followup_interval_ms, 'audio.attention_followup_interval_ms'),
    attention_scan_min_audio_ms: requireNumber(section.attention_scan_min_audio_ms, 'audio.attention_scan_min_audio_ms'),
    attention_scan_min_rms: requireNumber(section.attention_scan_min_rms, 'audio.attention_scan_min_rms'),
    attention_command_settle_ms: requireNumber(section.attention_command_settle_ms, 'audio.attention_command_settle_ms'),
    attention_command_max_wait_ms: requireNumber(section.attention_command_max_wait_ms, 'audio.attention_command_max_wait_ms'),
    wake_command_continuation_ms: requireNumber(section.wake_command_continuation_ms, 'audio.wake_command_continuation_ms'),
    attention_direct_dedupe_ms: requireNumber(section.attention_direct_dedupe_ms, 'audio.attention_direct_dedupe_ms'),
    attention_history_limit: requireNumber(section.attention_history_limit, 'audio.attention_history_limit'),
    attention_max_pending_scans: requireNumber(section.attention_max_pending_scans, 'audio.attention_max_pending_scans'),
    vad_start_threshold: requireNumber(section.vad_start_threshold, 'audio.vad_start_threshold'),
    vad_end_threshold: requireNumber(section.vad_end_threshold, 'audio.vad_end_threshold'),
    vad_start_frames: requireNumber(section.vad_start_frames, 'audio.vad_start_frames'),
    vad_end_frames: requireNumber(section.vad_end_frames, 'audio.vad_end_frames'),
    max_utterance_seconds: requireNumber(section.max_utterance_seconds, 'audio.max_utterance_seconds'),
    ambient_rms_start_threshold: requireNumber(section.ambient_rms_start_threshold, 'audio.ambient_rms_start_threshold'),
    ambient_rms_end_threshold: requireNumber(section.ambient_rms_end_threshold, 'audio.ambient_rms_end_threshold'),
    ambient_start_frames: requireNumber(section.ambient_start_frames, 'audio.ambient_start_frames'),
    ambient_end_frames: requireNumber(section.ambient_end_frames, 'audio.ambient_end_frames'),
    ambient_min_event_ms: requireNumber(section.ambient_min_event_ms, 'audio.ambient_min_event_ms'),
    ambient_max_event_seconds: requireNumber(section.ambient_max_event_seconds, 'audio.ambient_max_event_seconds'),
    proof_capture_seconds: requireNumber(section.proof_capture_seconds, 'audio.proof_capture_seconds'),
    whisper_model_size: requireString(section.whisper_model_size, 'audio.whisper_model_size'),
    whisper_server_enabled: requireBoolean(section.whisper_server_enabled, 'audio.whisper_server_enabled'),
    whisper_server_host: requireString(section.whisper_server_host, 'audio.whisper_server_host'),
    whisper_server_port: requireNumber(section.whisper_server_port, 'audio.whisper_server_port'),
    whisper_server_start_timeout_ms: requireNumber(section.whisper_server_start_timeout_ms, 'audio.whisper_server_start_timeout_ms'),
    whisper_singleton_enforced: requireBoolean(section.whisper_singleton_enforced, 'audio.whisper_singleton_enforced'),
    whisper_singleton_lock_file: requireString(section.whisper_singleton_lock_file, 'audio.whisper_singleton_lock_file'),
    whisper_process_root: requireString(section.whisper_process_root, 'audio.whisper_process_root'),
    whisper_server_probe_path: requireString(section.whisper_server_probe_path, 'audio.whisper_server_probe_path'),
    whisper_server_probe_timeout_ms: requireNumber(section.whisper_server_probe_timeout_ms, 'audio.whisper_server_probe_timeout_ms'),
    whisper_server_probe_request_timeout_ms: requireNumber(section.whisper_server_probe_request_timeout_ms, 'audio.whisper_server_probe_request_timeout_ms'),
    whisper_server_probe_poll_ms: requireNumber(section.whisper_server_probe_poll_ms, 'audio.whisper_server_probe_poll_ms'),
    whisper_process_stop_timeout_ms: requireNumber(section.whisper_process_stop_timeout_ms, 'audio.whisper_process_stop_timeout_ms'),
    whisper_process_stop_poll_ms: requireNumber(section.whisper_process_stop_poll_ms, 'audio.whisper_process_stop_poll_ms'),
    whisper_error_tail_chars: requireNumber(section.whisper_error_tail_chars, 'audio.whisper_error_tail_chars'),
    voice_lock_ttl_ms: requireNumber(section.voice_lock_ttl_ms, 'audio.voice_lock_ttl_ms'),
    piper_voice_name: requireString(section.piper_voice_name, 'audio.piper_voice_name'),
    piper_voice_size: requireString(section.piper_voice_size, 'audio.piper_voice_size'),
    rolling_buffer_seconds: requireNumber(section.rolling_buffer_seconds, 'audio.rolling_buffer_seconds'),
    vad_speech_threshold: requireNumber(section.vad_speech_threshold, 'audio.vad_speech_threshold'),
    vad_endpoint_silence_ms: requireNumber(section.vad_endpoint_silence_ms, 'audio.vad_endpoint_silence_ms'),
    vad_min_speech_ms: requireNumber(section.vad_min_speech_ms, 'audio.vad_min_speech_ms'),
    vad_max_speech_seconds: requireNumber(section.vad_max_speech_seconds, 'audio.vad_max_speech_seconds'),
    vad_frame_size_ms: requireNumber(section.vad_frame_size_ms, 'audio.vad_frame_size_ms'),
    whisper_language: requireString(section.whisper_language, 'audio.whisper_language'),
    whisper_beam_size: requireNumber(section.whisper_beam_size, 'audio.whisper_beam_size'),
    whisper_max_concurrent: requireNumber(section.whisper_max_concurrent, 'audio.whisper_max_concurrent'),
    ambient_classify_enabled: requireBoolean(section.ambient_classify_enabled, 'audio.ambient_classify_enabled'),
    ambient_classify_interval_ms: requireNumber(section.ambient_classify_interval_ms, 'audio.ambient_classify_interval_ms'),
    ambient_min_segment_ms: requireNumber(section.ambient_min_segment_ms, 'audio.ambient_min_segment_ms'),
    hearing_stale_event_ms: requireNumber(section.hearing_stale_event_ms, 'audio.hearing_stale_event_ms'),
    hearing_duplicate_window_ms: requireNumber(section.hearing_duplicate_window_ms, 'audio.hearing_duplicate_window_ms'),
    hearing_freshness_max_age_ms: requireNumber(section.hearing_freshness_max_age_ms, 'audio.hearing_freshness_max_age_ms'),
    piper_incremental_enabled: requireBoolean(section.piper_incremental_enabled, 'audio.piper_incremental_enabled'),
    piper_playback_command: requireString(section.piper_playback_command, 'audio.piper_playback_command'),
    audio_drain_timeout_ms: requireNumber(section.audio_drain_timeout_ms, 'audio.audio_drain_timeout_ms'),
    ambient_memory_rate_limit_per_minute: requireNumber(section.ambient_memory_rate_limit_per_minute, 'audio.ambient_memory_rate_limit_per_minute'),
    ambient_memory_backoff_seconds: requireNumber(section.ambient_memory_backoff_seconds, 'audio.ambient_memory_backoff_seconds'),
    ambient_memory_failure_log_max_chars: requireNumber(section.ambient_memory_failure_log_max_chars, 'audio.ambient_memory_failure_log_max_chars'),
    ambient_memory_failure_log_name: requireString(section.ambient_memory_failure_log_name, 'audio.ambient_memory_failure_log_name'),
    max_frame_queue_size: requireNumber(section.max_frame_queue_size, 'audio.max_frame_queue_size'),
    whisper_drain_timeout_ms: requireNumber(section.whisper_drain_timeout_ms, 'audio.whisper_drain_timeout_ms')
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
    ...(mode === 'chat' ? {
      autoload_blocking_on_chat_local_start: requireBoolean(section.autoload_blocking_on_chat_local_start, 'knowledge.autoload_blocking_on_chat_local_start'),
      sleep_consolidation_enabled: requireBoolean(section.sleep_consolidation_enabled, 'knowledge.sleep_consolidation_enabled'),
      sleep_consolidation_max_chunks_per_night: requireNumber(section.sleep_consolidation_max_chunks_per_night, 'knowledge.sleep_consolidation_max_chunks_per_night'),
      sleep_consolidation_summary_chars: requireNumber(section.sleep_consolidation_summary_chars, 'knowledge.sleep_consolidation_summary_chars')
    } : {}),
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
    runtime_start_timeout_ms: requireNumber(section.runtime_start_timeout_ms, 'live_chat.runtime_start_timeout_ms'),
    runtime_start_poll_ms: requireNumber(section.runtime_start_poll_ms, 'live_chat.runtime_start_poll_ms'),
    runtime_host: requireString(section.runtime_host, 'live_chat.runtime_host'),
    runtime_port: requireNumber(section.runtime_port, 'live_chat.runtime_port'),
    runtime_heartbeat_ms: requireNumber(section.runtime_heartbeat_ms, 'live_chat.runtime_heartbeat_ms'),
    runtime_watchdog_poll_ms: requireNumber(section.runtime_watchdog_poll_ms, 'live_chat.runtime_watchdog_poll_ms'),
    runtime_watchdog_request_timeout_ms: requireNumber(section.runtime_watchdog_request_timeout_ms, 'live_chat.runtime_watchdog_request_timeout_ms'),
    runtime_watchdog_consecutive_failure_limit: requireNumber(section.runtime_watchdog_consecutive_failure_limit, 'live_chat.runtime_watchdog_consecutive_failure_limit'),
    electron_shutdown_grace_ms: requireNumber(section.electron_shutdown_grace_ms, 'live_chat.electron_shutdown_grace_ms'),
    renderer_unresponsive_grace_ms: requireNumber(section.renderer_unresponsive_grace_ms, 'live_chat.renderer_unresponsive_grace_ms'),
    public_sentence_min_characters: requireNumber(section.public_sentence_min_characters, 'live_chat.public_sentence_min_characters'),
    latency_log_max_bytes: requireNumber(section.latency_log_max_bytes, 'live_chat.latency_log_max_bytes'),
    history_limit: requireNumber(section.history_limit, 'live_chat.history_limit'),
    transcript_tail_max: requireNumber(section.transcript_tail_max, 'live_chat.transcript_tail_max'),
    neural_event_max_display_chars: requireNumber(section.neural_event_max_display_chars, 'live_chat.neural_event_max_display_chars'),
    audio_voice_lock_ttl_ms: requireNumber(section.audio_voice_lock_ttl_ms, 'live_chat.audio_voice_lock_ttl_ms'),
    piper_text_max_chars: requireNumber(section.piper_text_max_chars, 'live_chat.piper_text_max_chars'),
    piper_request_timeout_ms: requireNumber(section.piper_request_timeout_ms, 'live_chat.piper_request_timeout_ms'),
    control_action_defer_ms: requireNumber(section.control_action_defer_ms, 'live_chat.control_action_defer_ms')
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

function getWakeGateConfig(mode) {
  if (mode !== 'chat') throw new Error('wake gate config is chat-mode only');
  return loadFlokiConfig(mode).wake_gate;
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

function getDetectionConfig(mode) {
  if (mode !== 'chat') {
    throw new Error('detection config is chat-mode only');
  }

  return loadFlokiConfig(mode).detection;
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

function getInterfaceYamlConfig(mode) {
  if (mode !== 'chat') throw new Error('interface yaml config is chat-mode only');
  return loadFlokiConfig(mode).interface_yaml;
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
  getWakeGateConfig,
  getAudioConfig,
  getTimeoutConfig,
  getKnowledgeConfig,
  getLiveChatConfig,
  getLifeClockConfig,
  getVisionConfig,
  getDetectionConfig,
  getChatWorldVisionConfig,
  getGameWorldVisionConfig,
  getPinealVisionConfig,
  getInterfaceYamlConfig,
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
    const model = section && section.model;
    const endpoint = _resolveEnvOrDefault(section, 'endpoint_env', 'endpoint_default');
    if (typeof model !== 'string' || model.trim() === '') throw new Error(label + '.model must be configured in YAML');
    if (typeof endpoint !== 'string' || endpoint.trim() === '') throw new Error(label + '.endpoint must be configured in YAML');
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
      const detection = _requiredObject(raw.detection, 'detection');
      const prompts = detection.grounding_dino_prompts;
      if (prompts !== undefined) {
        _requiredObject(prompts, 'detection.grounding_dino_prompts');
      }
      config.detection = Object.freeze({
        ...detection,
        ...(prompts === undefined
          ? {}
          : {
              grounding_dino_prompts: Object.freeze({ ...prompts })
            })
      });
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

// FLOKI_V2_RECURSIVE_SELF_IMPROVEMENT_CONFIG_BEGIN
function getSelfImprovementConfig(mode = 'chat') {
  const raw = loadRawYaml(mode);
  const section = requireObject(raw.self_improvement, 'self_improvement');
  const numberFromMap = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };
  const commandTimeoutOverrides = (() => {
    const rawMap = section.command_timeout_overrides_ms;
    if (typeof rawMap !== 'string' || !rawMap.trim()) return Object.freeze({});
    const out = {};
    for (const pair of rawMap.split('|')) {
      const [key, value] = pair.split('=');
      if (!key || !value) continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) out[key.trim()] = parsed;
    }
    return Object.freeze(out);
  })();
  const stringValue = (name) => requireString(section[name], 'self_improvement.' + name);
  const numberValue = (name) => requireNumber(section[name], 'self_improvement.' + name);
  const booleanValue = (name) => requireBoolean(section[name], 'self_improvement.' + name);
  return Object.freeze({
    enabled: booleanValue('enabled'),
    auto_start: booleanValue('auto_start'),
    approval_required: booleanValue('approval_required'),
    idle_seconds: numberValue('idle_seconds'),
    poll_ms: numberValue('poll_ms'),
    cooldown_seconds: numberValue('cooldown_seconds'),
    worker_preemption_poll_ms: numberValue('worker_preemption_poll_ms'),
    ui_poll_ms: numberValue('ui_poll_ms'),
    activity_stream_max_bytes: numberValue('activity_stream_max_bytes'),
    activity_stream_max_events: numberValue('activity_stream_max_events'),
    run_now_ack_timeout_ms: numberValue('run_now_ack_timeout_ms'),
    run_now_ack_poll_ms: numberValue('run_now_ack_poll_ms'),
    context_window: numberValue('context_window'),
    model_thinking_enabled: booleanValue('model_thinking_enabled'),
    agent_message_history_max_chars:
      numberValue('agent_message_history_max_chars'),
    agent_recent_message_count: numberValue('agent_recent_message_count'),
    max_agent_iterations: numberValue('max_agent_iterations'),
    discovery_tool_limit: numberValue('discovery_tool_limit'),
    research_tool_limit: numberValue('research_tool_limit'),
    repeated_tool_signature_limit: numberValue('repeated_tool_signature_limit'),
    objective_selection_deadline_iteration: numberValue('objective_selection_deadline_iteration'),
    implementation_start_deadline_iteration: numberValue('implementation_start_deadline_iteration'),
    search_only_streak_limit: numberValue('search_only_streak_limit'),
    failed_lookup_limit: numberValue('failed_lookup_limit'),
    max_no_change_iterations: numberValue('max_no_change_iterations'),
    focused_verification_failure_limit: numberValue('focused_verification_failure_limit'),
    focused_repair_no_progress_iteration_limit:
      numberValue('focused_repair_no_progress_iteration_limit'),
    max_command_ms: numberValue('max_command_ms'),
    max_changed_files: numberValue('max_changed_files'),
    max_patch_bytes: numberValue('max_patch_bytes'),
    minimum_available_memory_mb: numberValue('minimum_available_memory_mb'),
    candidate_id_max_length: numberValue('candidate_id_max_length'),
    approval_token_bytes: numberValue('approval_token_bytes'),
    atomic_temp_random_bytes: numberValue('atomic_temp_random_bytes'),
    run_id_random_bytes: numberValue('run_id_random_bytes'),
    run_id_prefix: stringValue('run_id_prefix'),
    prior_candidate_history_limit: numberValue('prior_candidate_history_limit'),
    occupied_candidate_statuses: stringValue('occupied_candidate_statuses'),
    candidate_dedup_strong_objective_similarity_min:
      numberValue('candidate_dedup_strong_objective_similarity_min'),
    candidate_dedup_strong_hypothesis_similarity_min:
      numberValue('candidate_dedup_strong_hypothesis_similarity_min'),
    candidate_dedup_focused_test_objective_similarity_min:
      numberValue('candidate_dedup_focused_test_objective_similarity_min'),
    candidate_dedup_focused_test_file_overlap_min:
      numberValue('candidate_dedup_focused_test_file_overlap_min'),
    candidate_dedup_focused_test_text_similarity_min:
      numberValue('candidate_dedup_focused_test_text_similarity_min'),
    candidate_dedup_moderate_objective_similarity_min:
      numberValue('candidate_dedup_moderate_objective_similarity_min'),
    candidate_dedup_moderate_hypothesis_similarity_min:
      numberValue('candidate_dedup_moderate_hypothesis_similarity_min'),
    candidate_dedup_high_file_overlap_min:
      numberValue('candidate_dedup_high_file_overlap_min'),
    max_pending_review_candidates: numberValue('max_pending_review_candidates'),
    sandbox_engine: stringValue('sandbox_engine'),
    image_name: stringValue('image_name'),
    container_base_image: stringValue('container_base_image'),
    container_node_version: stringValue('container_node_version'),
    container_node_dist_base_url: stringValue('container_node_dist_base_url'),
    container_browser_deb_url: stringValue('container_browser_deb_url'),
    container_browser_command_path: stringValue('container_browser_command_path'),
    container_apt_packages: stringValue('container_apt_packages'),
    context7_package_name: stringValue('context7_package_name'),
    context7_package_version: stringValue('context7_package_version'),
    container_hostname: stringValue('container_hostname'),
    container_name_prefix: stringValue('container_name_prefix'),
    persistent_container_enabled: booleanValue('persistent_container_enabled'),
    persistent_container_name: stringValue('persistent_container_name'),
    persistent_container_user: stringValue('persistent_container_user'),
    persistent_project_workspace_path: stringValue('persistent_project_workspace_path'),
    persistent_source_mirror_directory_name: stringValue('persistent_source_mirror_directory_name'),
    persistent_workspace_root_mount_path: stringValue('persistent_workspace_root_mount_path'),
    persistent_container_idle_command: stringValue('persistent_container_idle_command'),
    workspace_mount_path: stringValue('workspace_mount_path'),
    outbox_mount_path: stringValue('outbox_mount_path'),
    self_context_mount_path: stringValue('self_context_mount_path'),
    container_config_path: stringValue('container_config_path'),
    container_tmp_path: stringValue('container_tmp_path'),
    tmpfs_options: stringValue('tmpfs_options'),
    network_mode: stringValue('network_mode'),
    host_gateway_name: stringValue('host_gateway_name'),
    host_gateway_mapping: stringValue('host_gateway_mapping'),
    loopback_hostnames: stringValue('loopback_hostnames'),
    cap_drop: stringValue('cap_drop'),
    security_opt: stringValue('security_opt'),
    workspace_mount_options: stringValue('workspace_mount_options'),
    outbox_mount_options: stringValue('outbox_mount_options'),
    self_context_mount_options: stringValue('self_context_mount_options'),
    config_mount_options: stringValue('config_mount_options'),
    container_stop_timeout_seconds: numberValue('container_stop_timeout_seconds'),
    container_stop_command_timeout_ms: numberValue('container_stop_command_timeout_ms'),
    podman_command_timeout_ms: numberValue('podman_command_timeout_ms'),
    podman_output_buffer_bytes: numberValue('podman_output_buffer_bytes'),
    image_build_timeout_ms: numberValue('image_build_timeout_ms'),
    cpu_limit: numberValue('cpu_limit'),
    memory_limit: stringValue('memory_limit'),
    pids_limit: numberValue('pids_limit'),
    container_smoke_command: stringValue('container_smoke_command'),
    general_web_enabled: booleanValue('general_web_enabled'),
    context7_enabled: booleanValue('context7_enabled'),
    research_corpus_catalog_relative_path: stringValue('research_corpus_catalog_relative_path'),
    research_corpus_search_default_limit: numberValue('research_corpus_search_default_limit'),
    research_corpus_search_max_limit: numberValue('research_corpus_search_max_limit'),
    research_corpus_fetch_max_chars: numberValue('research_corpus_fetch_max_chars'),
    workspace_root: stringValue('workspace_root'),
    candidate_root: stringValue('candidate_root'),
    outbox_root: stringValue('outbox_root'),
    runtime_root: stringValue('runtime_root'),
    status_file_name: stringValue('status_file_name'),
    worker_pid_file_name: stringValue('worker_pid_file_name'),
    pause_file_name: stringValue('pause_file_name'),
    run_request_file_name: stringValue('run_request_file_name'),
    current_container_file_name: stringValue('current_container_file_name'),
    audit_file_name: stringValue('audit_file_name'),
    approval_token_file_name: stringValue('approval_token_file_name'),
    promotion_lock_file_name: stringValue('promotion_lock_file_name'),
    worker_log_name: stringValue('worker_log_name'),
    promotion_log_name: stringValue('promotion_log_name'),
    restart_log_name: stringValue('restart_log_name'),
    snapshot_metadata_file_name: stringValue('snapshot_metadata_file_name'),
    snapshot_evidence_subdir: stringValue('snapshot_evidence_subdir'),
    snapshot_runtime_evidence_file_name: stringValue('snapshot_runtime_evidence_file_name'),
    self_context_directory_name: stringValue('self_context_directory_name'),
    self_context_manifest_file_name: stringValue('self_context_manifest_file_name'),
    self_context_index_file_name: stringValue('self_context_index_file_name'),
    self_context_search_default_limit:
      numberValue('self_context_search_default_limit'),
    self_context_search_max_limit: numberValue('self_context_search_max_limit'),
    self_context_result_max_chars: numberValue('self_context_result_max_chars'),
    self_context_index_chunk_chars:
      numberValue('self_context_index_chunk_chars'),
    snapshot_exclude_patterns: stringValue('snapshot_exclude_patterns'),
    snapshot_sanitized_npmrc_lines: stringValue('snapshot_sanitized_npmrc_lines'),
    snapshot_command_timeout_ms: numberValue('snapshot_command_timeout_ms'),
    snapshot_rsync_timeout_ms: numberValue('snapshot_rsync_timeout_ms'),
    snapshot_output_buffer_bytes: numberValue('snapshot_output_buffer_bytes'),
    snapshot_git_user_name: stringValue('snapshot_git_user_name'),
    snapshot_git_user_email: stringValue('snapshot_git_user_email'),
    snapshot_git_commit_message: stringValue('snapshot_git_commit_message'),
    protected_path_prefixes: stringValue('protected_path_prefixes'),
    allow_existing_test_changes: booleanValue('allow_existing_test_changes'),
    verification_command_1: stringValue('verification_command_1'),
    verification_command_2: stringValue('verification_command_2'),
    verification_command_3: stringValue('verification_command_3'),
    sandbox_verification_command_1:
      stringValue('sandbox_verification_command_1'),
    sandbox_verification_command_2:
      stringValue('sandbox_verification_command_2'),
    sandbox_verification_command_3:
      stringValue('sandbox_verification_command_3'),
    promotion_test_timeout_ms: numberValue('promotion_test_timeout_ms'),
    promotion_command_timeout_ms: numberValue('promotion_command_timeout_ms'),
    promotion_output_buffer_bytes: numberValue('promotion_output_buffer_bytes'),
    promotion_stage_prefix: stringValue('promotion_stage_prefix'),
    promotion_stage_exclude_patterns: stringValue('promotion_stage_exclude_patterns'),
    promotion_rsync_timeout_ms: numberValue('promotion_rsync_timeout_ms'),
    promotion_git_apply_timeout_ms: numberValue('promotion_git_apply_timeout_ms'),
    promotion_cleanup_command: stringValue('promotion_cleanup_command'),
    promotion_cleanup_timeout_ms: numberValue('promotion_cleanup_timeout_ms'),
    promotion_restart_command: stringValue('promotion_restart_command'),
    promotion_restart_delay_seconds: numberValue('promotion_restart_delay_seconds'),
    dependency_install_locked_command: stringValue('dependency_install_locked_command'),
    dependency_install_unlocked_command: stringValue('dependency_install_unlocked_command'),
    interface_project_path: stringValue('interface_project_path'),
    rollback_build_command_1: stringValue('rollback_build_command_1'),
    rollback_build_command_2: stringValue('rollback_build_command_2'),
    agent_shell_output_buffer_bytes: numberValue('agent_shell_output_buffer_bytes'),
    agent_git_output_buffer_bytes: numberValue('agent_git_output_buffer_bytes'),
    agent_git_show_buffer_bytes: numberValue('agent_git_show_buffer_bytes'),
    agent_command_audit_max_chars: numberValue('agent_command_audit_max_chars'),
    agent_tool_result_max_chars: numberValue('agent_tool_result_max_chars'),
    agent_terminal_preview_max_chars: numberValue('agent_terminal_preview_max_chars'),
    agent_test_output_tail_chars: numberValue('agent_test_output_tail_chars'),
    agent_min_command_timeout_ms: numberValue('agent_min_command_timeout_ms'),
    agent_fetch_default_timeout_ms: numberValue('agent_fetch_default_timeout_ms'),
    agent_fetch_max_timeout_ms: numberValue('agent_fetch_max_timeout_ms'),
    agent_fetch_default_max_chars: numberValue('agent_fetch_default_max_chars'),
    agent_http_user_agent: stringValue('agent_http_user_agent'),
    agent_http_accept: stringValue('agent_http_accept'),
    browser_command: stringValue('browser_command'),
    browser_profile_root: stringValue('browser_profile_root'),
    browser_flags: stringValue('browser_flags'),
    browser_virtual_time_budget_ms: numberValue('browser_virtual_time_budget_ms'),
    browser_timeout_ms: numberValue('browser_timeout_ms'),
    browser_output_buffer_bytes: numberValue('browser_output_buffer_bytes'),
    browser_default_max_chars: numberValue('browser_default_max_chars'),
    browser_max_chars: numberValue('browser_max_chars'),
    web_search_url_template: stringValue('web_search_url_template'),
    web_search_redirect_base_url: stringValue('web_search_redirect_base_url'),
    web_search_default_limit: numberValue('web_search_default_limit'),
    web_search_max_limit: numberValue('web_search_max_limit'),
    web_search_max_chars: numberValue('web_search_max_chars'),
    github_search_url_template: stringValue('github_search_url_template'),
    github_search_default_limit: numberValue('github_search_default_limit'),
    github_search_max_limit: numberValue('github_search_max_limit'),
    github_search_max_chars: numberValue('github_search_max_chars'),
    arxiv_search_url_template: stringValue('arxiv_search_url_template'),
    arxiv_search_default_limit: numberValue('arxiv_search_default_limit'),
    arxiv_search_max_limit: numberValue('arxiv_search_max_limit'),
    arxiv_search_max_chars: numberValue('arxiv_search_max_chars'),
    arxiv_summary_max_chars: numberValue('arxiv_summary_max_chars'),
    crossref_search_url_template: stringValue('crossref_search_url_template'),
    crossref_search_default_limit: numberValue('crossref_search_default_limit'),
    crossref_search_max_limit: numberValue('crossref_search_max_limit'),
    crossref_search_max_chars: numberValue('crossref_search_max_chars'),
    context7_call_timeout_ms: numberValue('context7_call_timeout_ms'),
    context7_protocol_version: stringValue('context7_protocol_version'),
    context7_client_name: stringValue('context7_client_name'),
    context7_client_version: stringValue('context7_client_version'),
    ollama_chat_path: stringValue('ollama_chat_path'),
    ollama_stream: booleanValue('ollama_stream'),
    default_objective: stringValue('default_objective'),
    service_start_attempts: numberValue('service_start_attempts'),
    service_start_poll_seconds: numberValue('service_start_poll_seconds'),
    service_start_log_tail_lines: numberValue('service_start_log_tail_lines'),
    service_stop_attempts: numberValue('service_stop_attempts'),
    service_stop_poll_seconds: numberValue('service_stop_poll_seconds'),
    service_stop_command_timeout_seconds: numberValue('service_stop_command_timeout_seconds'),
    agent_home_path: stringValue('agent_home_path'),
    agent_npm_cache_path: stringValue('agent_npm_cache_path'),
    agent_pip_cache_path: stringValue('agent_pip_cache_path'),
    persistent_dependency_cache_root: stringValue('persistent_dependency_cache_root'),
    persistent_dependency_cache_marker_file: stringValue('persistent_dependency_cache_marker_file'),
    dependency_fingerprint_algorithm: stringValue('dependency_fingerprint_algorithm'),
    selection_rescue_max_attempts: numberValue('selection_rescue_max_attempts'),
    selection_rescue_temperature: numberValue('selection_rescue_temperature'),
    selection_rescue_thinking_enabled: booleanValue('selection_rescue_thinking_enabled'),
    container_agent_path: stringValue('container_agent_path'),
    browser_profile_prefix: stringValue('browser_profile_prefix'),
    github_accept: stringValue('github_accept'),
    arxiv_accept: stringValue('arxiv_accept'),
    crossref_accept: stringValue('crossref_accept'),
    image_source_label: stringValue('image_source_label'),
    image_source_files: stringValue('image_source_files'),
    image_fingerprint_algorithm: stringValue('image_fingerprint_algorithm'),
    model_proxy_root: stringValue('model_proxy_root'),
    model_proxy_socket_name: stringValue('model_proxy_socket_name'),
    model_proxy_mount_path: stringValue('model_proxy_mount_path'),
    model_proxy_mount_options: stringValue('model_proxy_mount_options'),
    model_proxy_health_path: stringValue('model_proxy_health_path'),
    model_proxy_start_timeout_ms: numberValue('model_proxy_start_timeout_ms'),
    model_proxy_request_timeout_ms: numberValue('model_proxy_request_timeout_ms'),
    model_response_max_bytes: numberValue('model_response_max_bytes'),
    model_proxy_connection_header: stringValue('model_proxy_connection_header'),
    model_request_max_bytes: numberValue('model_request_max_bytes'),
    sandbox_log_file_name: stringValue('sandbox_log_file_name'),
    sandbox_error_tail_chars: numberValue('sandbox_error_tail_chars'),
    failure_requires_new_activity: booleanValue('failure_requires_new_activity'),
    environment_check_command_timeout_ms: numberValue('environment_check_command_timeout_ms'),
    shell_command_progress_interval_ms: numberValue('shell_command_progress_interval_ms'),
    shell_command_stalled_threshold_ms: numberValue('shell_command_stalled_threshold_ms'),
    iteration_wall_clock_budget_ms: numberValue('iteration_wall_clock_budget_ms'),
    command_timeout_overrides_ms: commandTimeoutOverrides,
    agent_git_show_timeout_ms: numberValue('agent_git_show_timeout_ms'),
    agent_ollama_request_max_attempts: numberValue('agent_ollama_request_max_attempts'),
    agent_ollama_request_retry_backoff_ms: numberValue('agent_ollama_request_retry_backoff_ms'),
    worker_heartbeat_file_name: stringValue('worker_heartbeat_file_name'),
    sandbox_heartbeat_file_name: stringValue('sandbox_heartbeat_file_name'),
    sandbox_heartbeat_refresh_ms: numberValue('sandbox_heartbeat_refresh_ms'),
    sandbox_heartbeat_stale_ms: numberValue('sandbox_heartbeat_stale_ms'),
    model_queue_depth: numberValue('model_queue_depth'),
    model_queue_timeout_ms: numberValue('model_queue_timeout_ms'),
    model_queue_request_timeout_ms: numberValue('model_queue_request_timeout_ms'),
    model_queue_per_request_cancel_enabled: booleanValue('model_queue_per_request_cancel_enabled'),
    promote_deny_during_active_sandbox: booleanValue('promote_deny_during_active_sandbox'),
    // === RSI autonomy v2 / Stage 1: repository intelligence ===
    repo_intelligence_enabled: booleanValue('repo_intelligence_enabled'),
    repo_intelligence_index_root: stringValue('repo_intelligence_index_root'),
    repo_intelligence_map_file_name: stringValue('repo_intelligence_map_file_name'),
    repo_intelligence_scan_roots: stringValue('repo_intelligence_scan_roots'),
    repo_intelligence_scan_extensions: stringValue('repo_intelligence_scan_extensions'),
    repo_intelligence_exclude_patterns: stringValue('repo_intelligence_exclude_patterns'),
    repo_intelligence_max_files: numberValue('repo_intelligence_max_files'),
    repo_intelligence_max_file_bytes: numberValue('repo_intelligence_max_file_bytes'),
    repo_intelligence_read_range_default_lines: numberValue('repo_intelligence_read_range_default_lines'),
    repo_intelligence_read_range_max_lines: numberValue('repo_intelligence_read_range_max_lines'),
    repo_intelligence_read_range_max_chars: numberValue('repo_intelligence_read_range_max_chars'),
    repo_intelligence_symbol_result_limit: numberValue('repo_intelligence_symbol_result_limit'),
    repo_intelligence_reference_result_limit: numberValue('repo_intelligence_reference_result_limit'),
    repo_intelligence_map_summary_max_files: numberValue('repo_intelligence_map_summary_max_files'),
    repo_intelligence_log_window_default_lines: numberValue('repo_intelligence_log_window_default_lines'),
    repo_intelligence_log_window_max_lines: numberValue('repo_intelligence_log_window_max_lines'),
    repo_intelligence_log_window_max_chars: numberValue('repo_intelligence_log_window_max_chars'),
    repo_intelligence_git_diff_max_chars: numberValue('repo_intelligence_git_diff_max_chars'),
    repo_intelligence_protected_path_prefixes: stringValue('repo_intelligence_protected_path_prefixes'),
    repo_intelligence_generated_path_prefixes: stringValue('repo_intelligence_generated_path_prefixes'),
    repo_intelligence_runtime_entry_points: stringValue('repo_intelligence_runtime_entry_points'),
    repo_intelligence_config_transport_namespace: stringValue('repo_intelligence_config_transport_namespace'),
    repo_intelligence_config_template_file: stringValue('repo_intelligence_config_template_file'),
    repo_intelligence_config_loader_file: stringValue('repo_intelligence_config_loader_file'),
    repo_intelligence_candidate_history_limit: numberValue('repo_intelligence_candidate_history_limit'),
    repo_intelligence_denial_history_limit: numberValue('repo_intelligence_denial_history_limit'),
    // === RSI autonomy v2 / Stage 1: progressive skills ===
    skills_enabled: booleanValue('skills_enabled'),
    skills_root: stringValue('skills_root'),
    skills_manifest_file_name: stringValue('skills_manifest_file_name'),
    skills_instruction_file_name: stringValue('skills_instruction_file_name'),
    skills_max_active: numberValue('skills_max_active'),
    skills_match_score_threshold: numberValue('skills_match_score_threshold'),
    skills_instruction_max_chars: numberValue('skills_instruction_max_chars'),
    // === RSI autonomy v2 / Stage 1: role-separated contexts ===
    role_sequence: stringValue('role_sequence'),
    role_self_reflector_temperature: numberValue('role_self_reflector_temperature'),
    role_self_reflector_top_p: numberValue('role_self_reflector_top_p'),
    role_self_reflector_context_budget_chars: numberValue('role_self_reflector_context_budget_chars'),
    role_self_reflector_can_write: booleanValue('role_self_reflector_can_write'),
    role_self_reflector_tools: stringValue('role_self_reflector_tools'),
    role_goal_selector_temperature: numberValue('role_goal_selector_temperature'),
    role_goal_selector_top_p: numberValue('role_goal_selector_top_p'),
    role_goal_selector_context_budget_chars: numberValue('role_goal_selector_context_budget_chars'),
    role_goal_selector_can_write: booleanValue('role_goal_selector_can_write'),
    role_goal_selector_tools: stringValue('role_goal_selector_tools'),
    role_researcher_temperature: numberValue('role_researcher_temperature'),
    role_researcher_top_p: numberValue('role_researcher_top_p'),
    role_researcher_context_budget_chars: numberValue('role_researcher_context_budget_chars'),
    role_researcher_can_write: booleanValue('role_researcher_can_write'),
    role_researcher_tools: stringValue('role_researcher_tools'),
    role_repo_investigator_temperature: numberValue('role_repo_investigator_temperature'),
    role_repo_investigator_top_p: numberValue('role_repo_investigator_top_p'),
    role_repo_investigator_context_budget_chars: numberValue('role_repo_investigator_context_budget_chars'),
    role_repo_investigator_can_write: booleanValue('role_repo_investigator_can_write'),
    role_repo_investigator_tools: stringValue('role_repo_investigator_tools'),
    role_implementer_temperature: numberValue('role_implementer_temperature'),
    role_implementer_top_p: numberValue('role_implementer_top_p'),
    role_implementer_context_budget_chars: numberValue('role_implementer_context_budget_chars'),
    role_implementer_can_write: booleanValue('role_implementer_can_write'),
    role_implementer_tools: stringValue('role_implementer_tools'),
    role_verifier_temperature: numberValue('role_verifier_temperature'),
    role_verifier_top_p: numberValue('role_verifier_top_p'),
    role_verifier_context_budget_chars: numberValue('role_verifier_context_budget_chars'),
    role_verifier_can_write: booleanValue('role_verifier_can_write'),
    role_verifier_tools: stringValue('role_verifier_tools'),
    role_critic_temperature: numberValue('role_critic_temperature'),
    role_critic_top_p: numberValue('role_critic_top_p'),
    role_critic_context_budget_chars: numberValue('role_critic_context_budget_chars'),
    role_critic_can_write: booleanValue('role_critic_can_write'),
    role_critic_tools: stringValue('role_critic_tools'),
    role_memory_curator_temperature: numberValue('role_memory_curator_temperature'),
    role_memory_curator_top_p: numberValue('role_memory_curator_top_p'),
    role_memory_curator_context_budget_chars: numberValue('role_memory_curator_context_budget_chars'),
    role_memory_curator_can_write: booleanValue('role_memory_curator_can_write'),
    role_memory_curator_tools: stringValue('role_memory_curator_tools'),
    // === RSI autonomy v2 / Stage 2: state machine, goals, capsules, evals ===
    state_machine_phase_sequence: stringValue('state_machine_phase_sequence'),
    state_machine_phase_roles: stringValue('state_machine_phase_roles'),
    state_machine_mandatory_phases: stringValue('state_machine_mandatory_phases'),
    state_machine_repair_loop_phase: stringValue('state_machine_repair_loop_phase'),
    state_machine_repair_source_phase: stringValue('state_machine_repair_source_phase'),
    state_machine_max_repair_iterations: numberValue('state_machine_max_repair_iterations'),
    state_machine_max_phase_transitions: numberValue('state_machine_max_phase_transitions'),
    goal_min_proposals: numberValue('goal_min_proposals'),
    goal_max_proposals: numberValue('goal_max_proposals'),
    goal_id_prefix: stringValue('goal_id_prefix'),
    goal_objective_max_chars: numberValue('goal_objective_max_chars'),
    goal_reason_max_chars: numberValue('goal_reason_max_chars'),
    memory_capsule_personal_sources: stringValue('memory_capsule_personal_sources'),
    memory_capsule_engineering_sources: stringValue('memory_capsule_engineering_sources'),
    memory_capsule_max_items_per_section: numberValue('memory_capsule_max_items_per_section'),
    memory_capsule_item_max_chars: numberValue('memory_capsule_item_max_chars'),
    memory_capsule_total_max_chars: numberValue('memory_capsule_total_max_chars'),
    denial_eval_root: stringValue('denial_eval_root'),
    denial_eval_id_prefix: stringValue('denial_eval_id_prefix'),
    denial_eval_min_objective_overlap: numberValue('denial_eval_min_objective_overlap'),
    // === RSI autonomy v2 / Stage 3: run kinds & candidate types ===
    allowed_rsi_run_kinds: stringValue('allowed_rsi_run_kinds'),
    default_rsi_run_kind: stringValue('default_rsi_run_kind'),
    rsi_run_kind_candidate_types: stringValue('rsi_run_kind_candidate_types'),
    code_patch_promoter_accepted_candidate_types: stringValue('code_patch_promoter_accepted_candidate_types'),
    // === RSI autonomy v2 / Stage 4: training architecture (QLoRA) ===
    training_enabled: booleanValue('training_enabled'),
    manual_training_enabled: booleanValue('manual_training_enabled'),
    nightly_training_enabled: booleanValue('nightly_training_enabled'),
    hf_master_path: stringValue('hf_master_path'),
    hf_master_required_files: stringValue('hf_master_required_files'),
    adapter_root: stringValue('adapter_root'),
    dataset_root: stringValue('dataset_root'),
    training_runtime_root: stringValue('training_runtime_root'),
    training_container_image: stringValue('training_container_image'),
    training_base_cuda_image: stringValue('training_base_cuda_image'),
    training_python_packages: stringValue('training_python_packages'),
    training_torch_packages: stringValue('training_torch_packages'),
    training_torch_index_url: stringValue('training_torch_index_url'),
    training_venv_path: stringValue('training_venv_path'),
    training_gpu_device_args: stringValue('training_gpu_device_args'),
    persistent_root_proof_path: stringValue('persistent_root_proof_path'),
    training_shell_command: stringValue('training_shell_command'),
    training_sleep_scheduler_stop_script: stringValue('training_sleep_scheduler_stop_script'),
    training_sleep_scheduler_start_script: stringValue('training_sleep_scheduler_start_script'),
    training_gpu_process_query_command: stringValue('training_gpu_process_query_command'),
    training_gpu_process_query_args: stringValue('training_gpu_process_query_args'),
    training_exclusive_status_label: stringValue('training_exclusive_status_label'),
    training_gpu_probe_args: stringValue('training_gpu_probe_args'),
    training_gpu_probe_command: stringValue('training_gpu_probe_command'),
    training_cdi_generate_args: stringValue('training_cdi_generate_args'),
    training_cdi_podman_spec_version: stringValue('training_cdi_podman_spec_version'),
    training_cdi_generated_spec_path: stringValue('training_cdi_generated_spec_path'),
    training_gpu_runtime_mode: stringValue('training_gpu_runtime_mode'),
    training_cdi_device_name: stringValue('training_cdi_device_name'),
    training_cdi_spec_path: stringValue('training_cdi_spec_path'),
    training_cdi_refresh_service: stringValue('training_cdi_refresh_service'),
    training_cdi_refresh_path_service: stringValue('training_cdi_refresh_path_service'),
    training_nvidia_ctk_command: stringValue('training_nvidia_ctk_command'),
    training_nvidia_toolkit_packages: stringValue('training_nvidia_toolkit_packages'),
    training_nvidia_toolkit_gpg_url: stringValue('training_nvidia_toolkit_gpg_url'),
    training_nvidia_toolkit_repo_list_url: stringValue('training_nvidia_toolkit_repo_list_url'),
    training_nvidia_toolkit_keyring_path: stringValue('training_nvidia_toolkit_keyring_path'),
    training_nvidia_toolkit_repo_path: stringValue('training_nvidia_toolkit_repo_path'),
    training_cdi_generation_timeout_ms: numberValue('training_cdi_generation_timeout_ms'),
    training_gpu_query_timeout_ms: numberValue('training_gpu_query_timeout_ms'),
    training_gpu_quiesce_timeout_ms: numberValue('training_gpu_quiesce_timeout_ms'),
    training_gpu_quiesce_poll_ms: numberValue('training_gpu_quiesce_poll_ms'),
    training_expected_gpu_name: stringValue('training_expected_gpu_name'),
    training_expected_compute_capability_major: numberValue('training_expected_compute_capability_major'),
    training_expected_compute_capability_minor: numberValue('training_expected_compute_capability_minor'),
    training_require_bf16: booleanValue('training_require_bf16'),
    training_disable_tqdm: booleanValue('training_disable_tqdm'),
    training_cpu_limit: numberValue('training_cpu_limit'),
    training_memory_limit: stringValue('training_memory_limit'),
    training_pids_limit: numberValue('training_pids_limit'),
    training_timeout_ms: numberValue('training_timeout_ms'),
    training_container_name_prefix: stringValue('training_container_name_prefix'),
    training_container_workdir: stringValue('training_container_workdir'),
    training_adapter_mount_path: stringValue('training_adapter_mount_path'),
    training_dataset_mount_path: stringValue('training_dataset_mount_path'),
    training_hf_master_mount_path: stringValue('training_hf_master_mount_path'),
    training_config_mount_path: stringValue('training_config_mount_path'),
    training_config_file_name: stringValue('training_config_file_name'),
    qlora_load_in_4bit: booleanValue('qlora_load_in_4bit'),
    qlora_bnb_4bit_quant_type: stringValue('qlora_bnb_4bit_quant_type'),
    qlora_bnb_4bit_compute_dtype: stringValue('qlora_bnb_4bit_compute_dtype'),
    qlora_bnb_4bit_use_double_quant: booleanValue('qlora_bnb_4bit_use_double_quant'),
    qlora_rank: numberValue('qlora_rank'),
    qlora_alpha: numberValue('qlora_alpha'),
    qlora_dropout: numberValue('qlora_dropout'),
    qlora_target_modules: stringValue('qlora_target_modules'),
    qlora_learning_rate: numberValue('qlora_learning_rate'),
    qlora_batch_size: numberValue('qlora_batch_size'),
    qlora_gradient_accumulation_steps: numberValue('qlora_gradient_accumulation_steps'),
    qlora_max_seq_length: numberValue('qlora_max_seq_length'),
    qlora_num_train_epochs: numberValue('qlora_num_train_epochs'),
    qlora_max_steps: numberValue('qlora_max_steps'),
    qlora_warmup_ratio: numberValue('qlora_warmup_ratio'),
    qlora_weight_decay: numberValue('qlora_weight_decay'),
    qlora_lr_scheduler_type: stringValue('qlora_lr_scheduler_type'),
    qlora_optimizer: stringValue('qlora_optimizer'),
    qlora_seed: numberValue('qlora_seed'),
    qlora_logging_steps: numberValue('qlora_logging_steps'),
    training_checkpoint_interval_steps: numberValue('training_checkpoint_interval_steps'),
    dataset_min_records: numberValue('dataset_min_records'),
    dataset_max_records: numberValue('dataset_max_records'),
    dataset_min_record_chars: numberValue('dataset_min_record_chars'),
    dataset_max_record_chars: numberValue('dataset_max_record_chars'),
    dataset_id_prefix: stringValue('dataset_id_prefix'),
    dataset_sources: stringValue('dataset_sources'),
    dataset_hash_algorithm: stringValue('dataset_hash_algorithm'),
    dataset_manifest_file_name: stringValue('dataset_manifest_file_name'),
    dataset_records_file_name: stringValue('dataset_records_file_name'),
    adapter_version_prefix: stringValue('adapter_version_prefix'),
    adapter_id_prefix: stringValue('adapter_id_prefix'),
    adapter_manifest_file_name: stringValue('adapter_manifest_file_name'),
    gguf_export_quantization: stringValue('gguf_export_quantization'),
    gguf_export_file_name_format: stringValue('gguf_export_file_name_format'),
    ollama_candidate_tag_format: stringValue('ollama_candidate_tag_format'),
    rollback_retention_count: numberValue('rollback_retention_count'),
    // === RSI autonomy v2 / Stage 5: GPU ownership + training resource mode ===
    gpu_owners: stringValue('gpu_owners'),
    gpu_default_owner: stringValue('gpu_default_owner'),
    gpu_ownership_lock_file: stringValue('gpu_ownership_lock_file'),
    gpu_ownership_acquire_timeout_ms: numberValue('gpu_ownership_acquire_timeout_ms'),
    ollama_unload_endpoints: stringValue('ollama_unload_endpoints'),
    ollama_ps_path: stringValue('ollama_ps_path'),
    ollama_unload_path: stringValue('ollama_unload_path'),
    ollama_unload_keep_alive_seconds: numberValue('ollama_unload_keep_alive_seconds'),
    ollama_unload_timeout_ms: numberValue('ollama_unload_timeout_ms'),
    ollama_reload_timeout_ms: numberValue('ollama_reload_timeout_ms'),
    nightly_ollama_reload_policy: stringValue('nightly_ollama_reload_policy'),
    nightly_ollama_guard_poll_ms: numberValue('nightly_ollama_guard_poll_ms'),
    training_suspend_workers: stringValue('training_suspend_workers'),
    training_keep_alive_workers: stringValue('training_keep_alive_workers'),
    runtime_transition_timeout_ms: numberValue('runtime_transition_timeout_ms'),
    wake_restoration_timeout_ms: numberValue('wake_restoration_timeout_ms'),
    // === RSI autonomy v2 / Stage 6 ===
    training_scheduler_tick_ms: numberValue('training_scheduler_tick_ms'),
    nightly_training_session_file_name: stringValue('nightly_training_session_file_name'),
    nightly_training_max_steps: numberValue('nightly_training_max_steps'),
    nightly_training_save_total_limit: numberValue('nightly_training_save_total_limit'),
    nightly_training_checkpoint_timeout_ms: numberValue('nightly_training_checkpoint_timeout_ms'),
    nightly_training_checkpoint_poll_ms: numberValue('nightly_training_checkpoint_poll_ms'),
    hf_rem_container_name_prefix: stringValue('hf_rem_container_name_prefix'),
    hf_rem_runtime_mount_path: stringValue('hf_rem_runtime_mount_path'),
    hf_rem_request_file_name: stringValue('hf_rem_request_file_name'),
    hf_rem_response_file_name: stringValue('hf_rem_response_file_name'),
    training_source_fingerprint_files: stringValue('training_source_fingerprint_files'),
    training_image_fingerprint_label: stringValue('training_image_fingerprint_label'),
    training_container_context_dir: stringValue('training_container_context_dir'),
    training_container_apt_packages: stringValue('training_container_apt_packages'),
    training_entrypoint: stringValue('training_entrypoint'),
    training_script_path: stringValue('training_script_path'),
    training_debian_frontend: stringValue('training_debian_frontend'),
    training_pip_no_cache_dir: stringValue('training_pip_no_cache_dir'),
    training_hf_hub_offline: stringValue('training_hf_hub_offline'),
    training_transformers_offline: stringValue('training_transformers_offline'),
    training_run_id_prefix: stringValue('training_run_id_prefix'),
    training_required_artifact_files: stringValue('training_required_artifact_files'),
    training_default_objective: stringValue('training_default_objective'),
    training_status_objective: stringValue('training_status_objective'),
    training_candidate_summary: stringValue('training_candidate_summary'),
    training_candidate_risk_level: stringValue('training_candidate_risk_level'),
    training_adapter_output_dir_name: stringValue('training_adapter_output_dir_name'),
    training_log_file_name: stringValue('training_log_file_name'),
    training_metrics_file_name: stringValue('training_metrics_file_name'),
    training_checkpoint_dir_prefix: stringValue('training_checkpoint_dir_prefix'),
    training_trainer_state_file_name: stringValue('training_trainer_state_file_name'),
    training_optimizer_state_file_name: stringValue('training_optimizer_state_file_name'),
    training_lr_scheduler_state_file_name: stringValue('training_lr_scheduler_state_file_name'),
    training_rng_state_file_name: stringValue('training_rng_state_file_name'),
    training_device_map: stringValue('training_device_map'),
    training_report_to: stringValue('training_report_to'),
    manual_training_mode: stringValue('manual_training_mode'),
    manual_training_resume_policy: stringValue('manual_training_resume_policy'),
    qlora_bias: stringValue('qlora_bias'),
    qlora_task_type: stringValue('qlora_task_type'),
    qlora_save_strategy: stringValue('qlora_save_strategy'),
    qlora_dataset_text_field: stringValue('qlora_dataset_text_field'),
    nightly_training_run_id_prefix: stringValue('nightly_training_run_id_prefix'),
    nightly_training_control_file_name: stringValue('nightly_training_control_file_name'),
    nightly_training_control_response_file_name: stringValue('nightly_training_control_response_file_name'),
    nightly_training_mode: stringValue('nightly_training_mode'),
    nightly_training_resume_policy: stringValue('nightly_training_resume_policy'),
    nightly_training_checkpoint_request_id_prefix: stringValue('nightly_training_checkpoint_request_id_prefix'),
    nightly_training_default_objective: stringValue('nightly_training_default_objective'),
    nightly_training_candidate_objective: stringValue('nightly_training_candidate_objective'),
    hf_rem_runtime_subdir: stringValue('hf_rem_runtime_subdir'),
    hf_rem_log_file_name: stringValue('hf_rem_log_file_name'),
    hf_rem_id_prefix: stringValue('hf_rem_id_prefix'),
    hf_rem_adapter_mount_path: stringValue('hf_rem_adapter_mount_path'),
    hf_rem_entrypoint: stringValue('hf_rem_entrypoint'),
    hf_rem_inference_script_path: stringValue('hf_rem_inference_script_path'),
    hf_rem_network_mode: stringValue('hf_rem_network_mode'),
    hf_rem_required_adapter_files: stringValue('hf_rem_required_adapter_files'),
    hf_rem_system_prompt: stringValue('hf_rem_system_prompt'),
    hf_rem_model_identity_prefix: stringValue('hf_rem_model_identity_prefix'),
    hf_rem_master_identity: stringValue('hf_rem_master_identity'),
    hf_rem_device_map: stringValue('hf_rem_device_map'),
    live_cognition_provider: stringValue('live_cognition_provider'),
    code_improvement_provider: stringValue('code_improvement_provider'),
    manual_training_provider: stringValue('manual_training_provider'),
    nightly_training_provider: stringValue('nightly_training_provider'),
    vision_provider: stringValue('vision_provider'),
    training_tokenizer_use_fast: booleanValue('training_tokenizer_use_fast'),
    hf_rem_tokenizer_use_fast: booleanValue('hf_rem_tokenizer_use_fast'),
    hf_rem_do_sample: booleanValue('hf_rem_do_sample'),
    training_run_id_random_bytes: numberValue('training_run_id_random_bytes'),
    training_log_tail_max_chars: numberValue('training_log_tail_max_chars'),
    manual_training_segment_number: numberValue('manual_training_segment_number'),
    nightly_training_run_id_random_bytes: numberValue('nightly_training_run_id_random_bytes'),
    nightly_training_checkpoint_request_random_bytes: numberValue('nightly_training_checkpoint_request_random_bytes'),
    nightly_training_container_stop_timeout_seconds: numberValue('nightly_training_container_stop_timeout_seconds'),
    nightly_training_container_stop_timeout_floor_ms: numberValue('nightly_training_container_stop_timeout_floor_ms'),
    nightly_training_min_completed_steps: numberValue('nightly_training_min_completed_steps'),
    hf_rem_id_random_bytes: numberValue('hf_rem_id_random_bytes'),
    hf_rem_temperature: numberValue('hf_rem_temperature'),
    hf_rem_top_p: numberValue('hf_rem_top_p'),
    hf_rem_max_new_tokens: numberValue('hf_rem_max_new_tokens'),
    hf_rem_repetition_penalty: numberValue('hf_rem_repetition_penalty'),
    rsi_ui_candidate_render_limit: numberValue('rsi_ui_candidate_render_limit'),
    rsi_terminal_event_limit: numberValue('rsi_terminal_event_limit'),
    rsi_terminal_at_bottom_threshold_px: numberValue('rsi_terminal_at_bottom_threshold_px'),
    rsi_terminal_poll_ms: numberValue('rsi_terminal_poll_ms'),
    rsi_terminal_initial_activity_limit: numberValue('rsi_terminal_initial_activity_limit'),
    rsi_terminal_incremental_activity_limit: numberValue('rsi_terminal_incremental_activity_limit'),
    rsi_terminal_safe_string_max_chars: numberValue('rsi_terminal_safe_string_max_chars'),
    rsi_terminal_output_max_lines: numberValue('rsi_terminal_output_max_lines'),
    rsi_terminal_output_max_line_chars: numberValue('rsi_terminal_output_max_line_chars'),
    rsi_terminal_code_max_lines: numberValue('rsi_terminal_code_max_lines'),
    rsi_terminal_code_max_line_chars: numberValue('rsi_terminal_code_max_line_chars'),
    rsi_terminal_command_max_chars: numberValue('rsi_terminal_command_max_chars'),
    rsi_terminal_output_max_chars: numberValue('rsi_terminal_output_max_chars'),
    rsi_terminal_success_output_max_lines: numberValue('rsi_terminal_success_output_max_lines'),
    rsi_terminal_failure_output_max_lines: numberValue('rsi_terminal_failure_output_max_lines'),
    rsi_terminal_diff_max_chars: numberValue('rsi_terminal_diff_max_chars'),
    rsi_terminal_selection_error_max_chars: numberValue('rsi_terminal_selection_error_max_chars'),
    rsi_terminal_selection_error_max_lines: numberValue('rsi_terminal_selection_error_max_lines'),
    rsi_terminal_selection_error_line_max_chars: numberValue('rsi_terminal_selection_error_line_max_chars'),
    rsi_terminal_summary_max_chars: numberValue('rsi_terminal_summary_max_chars'),
    activity_stream_default_events: numberValue('activity_stream_default_events'),
    activity_stream_initial_events: numberValue('activity_stream_initial_events'),
    activity_stream_min_events: numberValue('activity_stream_min_events'),
    // === RSI autonomy v2 / Stage 6: REM / training scheduler ===
    nightly_rem_provider: stringValue('nightly_rem_provider'),
    manual_nap_rem_provider: stringValue('manual_nap_rem_provider'),
    hf_rem_inference_endpoint: stringValue('hf_rem_inference_endpoint'),
    hf_rem_inference_timeout_ms: numberValue('hf_rem_inference_timeout_ms'),
    training_rem_claim_file: stringValue('training_rem_claim_file'),
    training_segment_min_seconds: numberValue('training_segment_min_seconds'),
    training_checkpoint_before_rem: booleanValue('training_checkpoint_before_rem')
  });
}
module.exports.getSelfImprovementConfig = getSelfImprovementConfig;
// FLOKI_V2_RECURSIVE_SELF_IMPROVEMENT_CONFIG_END
