'use strict';

/**
 * Floki-v2 core_brain.
 *
 * The core brain is the only place where module graphs are assembled.
 * Chat and game mode each load a different YAML config.
 */

const path = require('node:path');

const { loadYamlFile } = require('../../src/config/yaml-lite.cjs');
const { makeUserTextEvent } = require('../../src/brain/brain-event-schema.cjs');
const { summarizeAffectForMemory } = require('../../src/brain/affect-state-schema.cjs');
const { statePath } = require('../../src/util/fs-safe.cjs');
const { newId } = require('../../src/util/ids.cjs');
const {
  normalizeChatWebcamVisionContext,
  buildChatRuntimeCapabilities
} = require('../../src/vision/chat-webcam-vision-context.cjs');

const { createThalamus } = require('../thalamus/index.cjs');
const { createTemporal } = require('../temporal/index.cjs');
const { createAmygdala } = require('../amygdala/index.cjs');
const { createEmotionsBase } = require('../emotions_base/index.cjs');
const { createHippocampus } = require('../hippocampus/index.cjs');
const { createPersonality } = require('../personality/index.cjs');
const { createPineal } = require('../pineal/index.cjs');
const { createFrontal } = require('../frontal/index.cjs');
const { createBroca } = require('../broca/index.cjs');

const { PROJECT_ROOT: ROOT, getLiveChatConfig, getVisionConfig } = require('../../src/config/floki-config.cjs');
const { createReleaseGate } = require('../../src/chat/public-response-stream.cjs');
const { retrieveKnowledgeContext } = require('../../src/chat/knowledge-context.cjs');
const CONFIG_VERSION = 'floki-v2-core-brain-config-v1';

const CHAT_REQUIRED_MODULES = Object.freeze([
  'thalamus',
  'temporal',
  'amygdala',
  'emotions_base',
  'hippocampus',
  'personality',
  'pineal',
  'frontal',
  'broca'
]);

const KNOWN_MODULES = Object.freeze([
  'thalamus',
  'temporal',
  'amygdala',
  'emotions_base',
  'hippocampus',
  'personality',
  'pineal',
  'frontal',
  'broca',
  'chat_world_senses',
  'chat_world_vision',
  'chat_world_hearing',
  'game_world_eyes',
  'game_world_body'
]);

const MODULE_REGISTRY = Object.freeze({
  thalamus: Object.freeze({
    factory: (options) => createThalamus(options),
    kind: 'brain'
  }),

  temporal: Object.freeze({
    factory: (options) => createTemporal(options),
    kind: 'brain'
  }),

  amygdala: Object.freeze({
    factory: (options) => createAmygdala(options),
    kind: 'brain'
  }),

  emotions_base: Object.freeze({
    factory: (options) => createEmotionsBase(options),
    kind: 'brain'
  }),

  hippocampus: Object.freeze({
    factory: (options) => createHippocampus(options),
    kind: 'brain'
  }),

  personality: Object.freeze({
    factory: (options) => createPersonality(options),
    kind: 'brain'
  }),

  pineal: Object.freeze({
    factory: (options) => createPineal(options),
    kind: 'brain'
  }),

  frontal: Object.freeze({
    factory: (options) => createFrontal({ ...options, model_config: options.config.models.cognition }),
    kind: 'brain'
  }),

  broca: Object.freeze({
    factory: (options) => createBroca(options),
    kind: 'brain'
  }),

  chat_world_senses: Object.freeze({
    factory: () => Object.freeze({
      module: 'chat_world_senses',
      kind: 'external_boundary',
      enabled_now: true,
      scope: 'chat_world_only',
      description: 'USB camera/mic are chat-world Maker-world senses only. They are not game-world eyes.'
    }),
    kind: 'boundary'
  })
});

function registeredModuleNames() {
  return Object.keys(MODULE_REGISTRY).sort();
}

function unregisteredKnownModuleNames() {
  return KNOWN_MODULES.filter((name) => !MODULE_REGISTRY[name]).sort();
}

function resolveEnvOrDefault(section, envKeyName, defaultKeyName) {
  const envName = section[envKeyName];

  if (envName && process.env[envName]) {
    return process.env[envName];
  }

  return section[defaultKeyName];
}

function normalizeModelSection(section, label) {
  if (!section || typeof section !== 'object') {
    throw new TypeError(label + ' model section missing');
  }

  const model = section.model;
  const endpoint = resolveEnvOrDefault(section, 'endpoint_env', 'endpoint_default');

  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error(label + ' model must be non-empty');
  }

  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new Error(label + ' endpoint must be non-empty');
  }

  return Object.freeze({
    provider: section.provider || 'ollama',
    model,
    endpoint,
    enabled_now: section.enabled_now === true,
    mode_scope: section.mode_scope || '',
    temperature: typeof section.temperature === 'number' ? section.temperature : 0.5,
    top_p: typeof section.top_p === 'number' ? section.top_p : 0.9,
    timeout_ms: typeof section.timeout_ms === 'number' ? section.timeout_ms : 120000,
    keep_alive: section.keep_alive || '24h',
    allow_thinking: false,
    expose_private_reasoning: false,
    store_raw_private_reasoning: false
  });
}

function configPathForMode(mode) {
  if (mode === 'chat') return path.join(ROOT, 'config', 'chat.config.yaml');
  if (mode === 'game') return path.join(ROOT, 'config', 'game.config.yaml');

  throw new Error('unknown core_brain mode: ' + mode);
}

function assertKnownYamlModules(rawModules) {
  const unknown = Object.keys(rawModules || {}).filter((name) => !KNOWN_MODULES.includes(name));

  if (unknown.length > 0) {
    throw new Error('unknown YAML module names: ' + unknown.join(', '));
  }

  return true;
}

function normalizeModules(rawModules) {
  if (!rawModules || typeof rawModules !== 'object') {
    throw new TypeError('modules section is required');
  }

  assertKnownYamlModules(rawModules);

  const normalized = {};

  for (const name of KNOWN_MODULES) {
    const moduleConfig = rawModules[name] || {};

    normalized[name] = Object.freeze({
      enabled: moduleConfig.enabled === true,
      required: moduleConfig.required === true
    });
  }

  return Object.freeze(normalized);
}

function enabledModuleNames(modules) {
  if (!modules || typeof modules !== 'object') return [];

  return KNOWN_MODULES.filter(function(name) {
    return modules[name] && modules[name].enabled === true;
  });
}

function disabledModuleNames(modules) {
  if (!modules || typeof modules !== 'object') return [];

  return KNOWN_MODULES.filter(function(name) {
    return !modules[name] || modules[name].enabled !== true;
  });
}

function missingRequiredModules(config) {
  const missing = [];

  if (!config || !config.modules) {
    return CHAT_REQUIRED_MODULES.slice();
  }

  if (config.mode === 'chat') {
    for (const name of CHAT_REQUIRED_MODULES) {
      if (!config.modules[name] || config.modules[name].enabled !== true) {
        missing.push(name);
      }
    }
  }

  return missing;
}

function enabledModulesWithoutFactories(config) {
  if (!config || !config.modules) return [];

  return enabledModuleNames(config.modules).filter((name) => !MODULE_REGISTRY[name]);
}

function validateCoreBrainConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('core brain config must be an object');
  }

  if (config.schema_version !== CONFIG_VERSION) {
    throw new Error('invalid core brain config schema_version: ' + config.schema_version);
  }

  if (config.mode !== 'chat' && config.mode !== 'game') {
    throw new Error('core brain config mode must be chat or game');
  }

  if (!config.models || typeof config.models !== 'object') {
    throw new Error('core brain config requires models section');
  }

  if (!config.models.cognition || !config.models.vision) {
    throw new Error('core brain config requires cognition and vision model sections');
  }

  if (!config.modules || typeof config.modules !== 'object') {
    throw new Error('core brain config requires modules section');
  }

  if (!config.policies || typeof config.policies !== 'object') {
    throw new Error('core brain config requires policies section');
  }

  if (typeof config.models.cognition.model !== 'string' || config.models.cognition.model.trim() === '') {
    throw new Error('chat/game config cognition model must be a non-empty YAML value');
  }

  if (typeof config.models.vision.model !== 'string' || config.models.vision.model.trim() === '') {
    throw new Error('chat/game config vision model must be a non-empty YAML value');
  }

  if (config.policies.usb_camera_as_game_world_eyes === true) {
    throw new Error('USB camera must never be configured as game-world eyes');
  }

  if (config.policies.raw_private_reasoning_storage !== false) {
    throw new Error('raw private reasoning storage must stay disabled');
  }

  const missing = missingRequiredModules(config);
  if (missing.length > 0) {
    throw new Error('missing required modules for ' + config.mode + ': ' + missing.join(', '));
  }

  const noFactory = enabledModulesWithoutFactories(config);
  if (noFactory.length > 0) {
    throw new Error('enabled modules without registered factories: ' + noFactory.join(', '));
  }

  if (config.mode === 'chat') {
    if (config.modules.game_world_body && config.modules.game_world_body.enabled === true) {
      throw new Error('chat mode must not enable game_world_body');
    }

    if (config.modules.game_world_eyes && config.modules.game_world_eyes.enabled === true) {
      throw new Error('chat mode must not enable game_world_eyes');
    }
  }

  if (config.mode === 'game') {
    if (config.modules.chat_world_vision && config.modules.chat_world_vision.enabled === true) {
      throw new Error('game mode must not enable chat_world_vision');
    }

    if (config.modules.chat_world_hearing && config.modules.chat_world_hearing.enabled === true) {
      throw new Error('game mode must not enable chat_world_hearing');
    }
  }

  return true;
}

function loadCoreBrainConfig(modeOrPath) {
  const filePath = typeof modeOrPath === 'string' && modeOrPath.endsWith('.yaml')
    ? modeOrPath
    : configPathForMode(modeOrPath);

  const raw = loadYamlFile(filePath);

  const config = {
    schema_version: raw.schema_version,
    mode: raw.mode,
    models: Object.freeze({
      cognition: normalizeModelSection(raw.models.cognition, 'cognition'),
      vision: normalizeModelSection(raw.models.vision, 'vision')
    }),
    modules: normalizeModules(raw.modules),
    policies: Object.freeze({ ...(raw.policies || {}) }),
    source_path: filePath
  };

  validateCoreBrainConfig(config);
  return Object.freeze(config);
}

function instantiateModule(name, options) {
  const registration = MODULE_REGISTRY[name];

  if (!registration || typeof registration.factory !== 'function') {
    throw new Error('No module factory registered for enabled module: ' + name);
  }

  return registration.factory(options);
}

function buildModules(config, options) {
  const instances = {};

  for (const name of enabledModuleNames(config.modules)) {
    instances[name] = instantiateModule(name, {
      ...options,
      config
    });
  }

  return Object.freeze(instances);
}

function requireModule(core, name) {
  const module = core.modules[name];

  if (!module) {
    throw new Error('core_brain missing required module: ' + name);
  }

  return module;
}

function memoryMatchesForContext(recallOutput, excludedMemoryIds = []) {
  if (!recallOutput || !recallOutput.payload || !Array.isArray(recallOutput.payload.matches)) {
    return [];
  }

  const excluded = new Set(Array.isArray(excludedMemoryIds) ? excludedMemoryIds.filter(Boolean) : []);
  return recallOutput.payload.matches.map(function(match) {
    const record = match.record || match;
    if (excluded.has(record.id)) return null;

    return {
      memory_id: record.id || null,
      summary: record.content && record.content.summary ? record.content.summary : '',
      tags: Array.isArray(record.tags) ? record.tags : [],
      affect: record.affect || {}
    };
  }).filter(Boolean);
}

async function handleChatText(core, text, options = {}) {
  if (core.mode !== 'chat') {
    throw new Error('handleChatText is only valid for chat mode core_brain');
  }

  const event = makeUserTextEvent(text, { trace_id: core.session_id });
  const chatWebcamVision = normalizeChatWebcamVisionContext(options.chat_webcam_vision || {});
  const runtimeCapabilities = buildChatRuntimeCapabilities(chatWebcamVision);
  const liveChat = getLiveChatConfig('chat');
  const visionConfig = getVisionConfig('chat');
  const visionQuestion = options.vision_question === true;
  const visionHardwareQuestion = options.vision_hardware_question === true;
  const visionResponseContract = Object.freeze({
    question: visionQuestion,
    hardware_question: visionHardwareQuestion,
    require_narrative: visionConfig.cognition_scene_require_narrative === true,
    scene_instruction: visionConfig.cognition_scene_instruction,
    unavailable_instruction: visionConfig.cognition_unavailable_instruction,
    prohibited_terms: Object.freeze(Object.values(visionConfig.prohibited_public_vision_terms))
  });
  const trace = options.latency_trace || null;

  const thalamus = requireModule(core, 'thalamus');
  const temporal = requireModule(core, 'temporal');
  const amygdala = requireModule(core, 'amygdala');
  const emotions = requireModule(core, 'emotions_base');
  const hippocampus = requireModule(core, 'hippocampus');
  const personality = requireModule(core, 'personality');
  const pineal = requireModule(core, 'pineal');
  const frontal = requireModule(core, 'frontal');
  const broca = requireModule(core, 'broca');

  const routeOutput = thalamus.routeEvent(event);
  const understandingOutput = temporal.understandEvent(event);
  const salienceOutput = amygdala.computeSalience(event);
  const emotionEnabled = options.emotion_enabled !== false;
  let affectOutput;
  let affectSummary;

  if (emotionEnabled) {
    const affectDelta = emotions.affectDeltaFromSalience(salienceOutput);
    affectOutput = emotions.applyAffectDelta(affectDelta);
    affectSummary = summarizeAffectForMemory(
      affectOutput.payload.state
    );
  } else {
    const frozenAffectState = emotions.loadAffectState({
      persist_diagnostics: false
    });
    affectSummary = summarizeAffectForMemory(frozenAffectState);
    affectOutput = Object.freeze({
      id: null,
      type: 'affect_snapshot',
      source: 'emotions_base',
      payload: Object.freeze({
        previous: affectSummary,
        current: affectSummary,
        state: frozenAffectState
      }),
      diagnostics: Object.freeze({
        module: 'emotions_base',
        status: 'emotion_stopped',
        affect_write_performed: false
      })
    });
  }

  const memoryEnabled = options.memory_enabled !== false;
  let memoryOutput;
  let personalityOutput;
  let identityOutput;
  let recallOutput;
  let memoryMatches;
  let knowledgeContext;

  if (memoryEnabled) {
    memoryOutput = hippocampus.rememberEvent(event, {
      stream: 'short_term',
      type: 'experience',
      tags: ['terminal_chat', 'core_brain', 'qwen_cognition', 'broca_speech', understandingOutput.payload.intent_hint],
      importance: salienceOutput.payload.salience.memory_importance_hint,
      affect: {
        valence: affectSummary.valence,
        arousal: affectSummary.arousal
      }
    });

    personalityOutput = personality.updateFromMemory(
      memoryOutput.payload.record
    );
    identityOutput = pineal.updateFromMemory(
      memoryOutput.payload.record,
      personalityOutput.payload.current,
      { runtime_capabilities: runtimeCapabilities }
    );

    recallOutput = hippocampus.recall({
      text,
      streams: ['short_term', 'episodic', 'semantic', 'autobiographical'],
      limit: 5
    });
    memoryMatches = memoryMatchesForContext(
      recallOutput,
      [memoryOutput.payload.record.id]
    );
    knowledgeContext = retrieveKnowledgeContext(text, { limit: 8 });
  } else {
    const personalityState = personality.loadPersonalityState({
      persist_diagnostics: false
    });
    const identityState = pineal.loadIdentityState({
      persist_diagnostics: false
    });
    const personalityCurrent =
      personality.summarizePersonality(personalityState);
    const identityCurrent =
      pineal.summarizeIdentity(identityState);

    memoryOutput = Object.freeze({
      id: null,
      type: 'memory_disabled',
      source: 'hippocampus',
      payload: Object.freeze({
        disabled: true,
        record: null
      }),
      diagnostics: Object.freeze({
        module: 'hippocampus',
        status: 'memory_stopped',
        writes_performed: false
      })
    });
    personalityOutput = Object.freeze({
      id: null,
      type: 'personality_snapshot',
      source: 'personality',
      payload: Object.freeze({
        previous: personalityCurrent,
        current: personalityCurrent,
        state: personalityState
      })
    });
    identityOutput = Object.freeze({
      id: null,
      type: 'identity_snapshot',
      source: 'pineal',
      payload: Object.freeze({
        previous: identityCurrent,
        current: identityCurrent,
        state: identityState
      })
    });
    recallOutput = Object.freeze({
      id: null,
      type: 'memory_recall_disabled',
      source: 'hippocampus',
      payload: Object.freeze({
        disabled: true,
        matches: Object.freeze([])
      })
    });
    memoryMatches = Object.freeze([]);
    knowledgeContext = Object.freeze({
      knowledge_retrieval_run_now: false,
      persistent_knowledge_used: false,
      knowledge_chunk_count_total: 0,
      knowledge_matches: Object.freeze([]),
      memory_enabled: false,
      model_called_now: false,
      network_called_now: false,
      chat_mode_only: true,
      game_mode_started: false
    });
  }
  if (trace) trace.emit('memory_context_ready', { memory_match_count: memoryMatches.length, knowledge_match_count: knowledgeContext.knowledge_matches.length });

  const brocaContext = {
    parent_event_ids: [event.id],
    include_stage_truth: true,
    chat_webcam_vision: chatWebcamVision,
    runtime_capabilities: runtimeCapabilities,
    vision_response_contract: visionResponseContract,
    tone: 'plain',
    audience: 'user'
  };

  const releaseGate = createReleaseGate({
    signal: options.signal,
    minimum_sentence_characters: Number(liveChat.public_sentence_min_characters || 12),
    authorize(candidate) {
      return broca.authorizePublicText(candidate, brocaContext);
    },
    on_public_text(payload) {
      if (trace) trace.emit('first_safe_public_text', { safe_public_text_length: payload.text.length });
      if (typeof options.on_public_text === 'function') options.on_public_text(payload);
    },
    on_first_sentence(payload) {
      if (trace) trace.emit('first_safe_sentence', { safe_public_text_length: payload.text.length });
      if (typeof options.on_first_sentence === 'function') options.on_first_sentence(payload);
    }
  });

  const streamingEnabled = options.streaming_enabled !== undefined
    ? options.streaming_enabled === true
    : liveChat.public_response_streaming_enabled === true;

  const cognitionOutput = await frontal.runCognition({
    event,
    route: routeOutput.payload || null,
    understanding: understandingOutput.payload,
    salience: salienceOutput.payload,
    affect: affectSummary,
    memories: memoryMatches,
    persistent_chat_memory: options.persistent_chat_memory || null,
    knowledge_context: knowledgeContext,
    emotional_reinforcement: options.emotional_reinforcement || null,
    soul: options.soul_context || null,
    chat_webcam_vision: chatWebcamVision,
    vision_response_contract: visionResponseContract,
    personality: personalityOutput.payload.current,
    identity: identityOutput.payload.current,
    core_brain: {
      mode: core.mode,
      config_path: core.config.source_path,
      enabled_modules: core.enabled_module_names,
      registry_modules: registeredModuleNames()
    }
  }, {
    model_config: options.model_config,
    streaming_enabled: streamingEnabled,
    timeout_ms: Number(liveChat.stream_timeout_ms || core.config.models.cognition.timeout_ms),
    num_predict: Number(liveChat.public_response_max_tokens || 220),
    signal: options.signal,
    post_json: options.post_json,
    post_json_stream: options.post_json_stream,
    released_public_text: releaseGate.authorized_text,
    on_model_dispatched(info) {
      if (trace) trace.emit('model_dispatched', {
        configured_model: info.model,
        configured_endpoint: info.endpoint,
        prompt_character_count: info.prompt_character_count,
        schema_enabled: info.schema_enabled,
        streaming_enabled: info.streaming_enabled
      });
      if (typeof options.on_model_dispatched === 'function') options.on_model_dispatched(info);
    },
    on_first_chunk(info) {
      if (trace) trace.emit('first_response_chunk');
      if (typeof options.on_first_chunk === 'function') options.on_first_chunk(info);
    },
    on_public_candidate(candidate) {
      releaseGate.release(candidate.text, brocaContext);
    },
    on_final_model_output(info) {
      const stats = info.raw_stats || {};
      if (trace) trace.emit('final_model_output', {
        ollama_total_duration: stats.total_duration,
        ollama_load_duration: stats.load_duration,
        ollama_prompt_eval_count: stats.prompt_eval_count,
        ollama_prompt_eval_duration: stats.prompt_eval_duration,
        ollama_eval_count: stats.eval_count,
        ollama_eval_duration: stats.eval_duration,
        ollama_done_reason: stats.done_reason
      });
      if (typeof options.on_final_model_output === 'function') options.on_final_model_output(info);
    },
    on_schema_valid(info) {
      if (trace) trace.emit('schema_valid');
      if (typeof options.on_schema_valid === 'function') options.on_schema_valid(info);
    }
  });

  const speechOutput = broca.speakFromCognition(cognitionOutput, brocaContext);
  if (speechOutput && speechOutput.type === 'speech') {
    const finalText = speechOutput.payload && typeof speechOutput.payload.text === 'string'
      ? speechOutput.payload.text.trim()
      : '';
    const releasedText = releaseGate.authorized_text();
    if (releasedText && finalText !== releasedText) {
      throw new Error('final Broca speech differs from already released public response');
    }
    if (!releaseGate.was_released() && finalText) {
      releaseGate.release(finalText, brocaContext);
    }
    if (trace) trace.emit('broca_ready', { safe_public_text_length: finalText.length });
  }

  return {
    event,
    routeOutput,
    understandingOutput,
    salienceOutput,
    affectOutput,
    affectSummary,
    emotionEnabled,
    memoryOutput,
    memoryEnabled,
    personalityOutput,
    identityOutput,
    recallOutput,
    memoryMatches,
    knowledgeContext,
    cognitionOutput,
    speechOutput,
    chatWebcamVision,
    runtimeCapabilities,
    publicResponseReleased: releaseGate.was_released(),
    publicResponseText: releaseGate.authorized_text(),
    firstSafeSentence: releaseGate.first_sentence()
  };
}

function cognitionJsonFromOutput(cognitionOutput) {
  if (!cognitionOutput || cognitionOutput.type !== 'model_response_summary') {
    return {
      enabled: false,
      error: cognitionOutput && cognitionOutput.failure ? cognitionOutput.failure.message : 'cognition output missing or failed'
    };
  }

  return {
    enabled: true,
    output_id: cognitionOutput.id,
    model: cognitionOutput.payload.model,
    safe_thought_summary: cognitionOutput.payload.cognition.safe_thought_summary,
    felt_interpretation: cognitionOutput.payload.cognition.felt_interpretation,
    memory_links: Array.isArray(cognitionOutput.payload.cognition.memory_links) ? cognitionOutput.payload.cognition.memory_links.slice() : [],
    personality_implications: Array.isArray(cognitionOutput.payload.cognition.personality_implications) ? cognitionOutput.payload.cognition.personality_implications.slice() : [],
    identity_implications: Array.isArray(cognitionOutput.payload.cognition.identity_implications) ? cognitionOutput.payload.cognition.identity_implications.slice() : [],
    new_memory_summary: cognitionOutput.payload.cognition.new_memory_summary || '',
    response_intent_for_broca: cognitionOutput.payload.cognition.response_intent_for_broca,
    normalized_model_json: cognitionOutput.payload.normalized_model_json === true,
    raw_private_reasoning_stored: cognitionOutput.payload.raw_private_reasoning_stored === true
  };
}

function speechJsonFromOutput(speechOutput) {
  if (!speechOutput || speechOutput.type !== 'speech') {
    return {
      enabled: false,
      error: speechOutput && speechOutput.failure ? speechOutput.failure.message : 'speech output missing or failed'
    };
  }

  return {
    enabled: true,
    output_id: speechOutput.id,
    text: speechOutput.payload.text,
    tone: speechOutput.payload.tone,
    audience: speechOutput.payload.audience
  };
}

function buildChatSmokeJson(core, result) {
  const cognition = cognitionJsonFromOutput(result.cognitionOutput);
  const speech = speechJsonFromOutput(result.speechOutput);

  return {
    ok: cognition.enabled && speech.enabled,
    marker: cognition.enabled && speech.enabled ? 'FLOKI_V2_CHAT_BROCA_SHELL_PASS' : 'FLOKI_V2_CHAT_BROCA_SHELL_FAIL',
    session_id: core.session_id,
    mode: core.mode,
    config_path: core.config.source_path,
    enabled_modules: core.enabled_module_names,
    registry_modules: registeredModuleNames(),
    event_id: result.event.id,
    memory_id: result.memoryOutput.payload.record.id,
    personality_output_id: result.personalityOutput.id,
    identity_output_id: result.identityOutput.id,
    cognition_output_id: cognition.output_id || null,
    speech_output_id: speech.output_id || null,
    salience: {
      urgency: result.salienceOutput.payload.salience.urgency,
      attention_priority: result.salienceOutput.payload.salience.attention_priority,
      memory_importance_hint: result.salienceOutput.payload.salience.memory_importance_hint
    },
    affect: result.affectSummary,
    cognition: cognition.enabled ? {
      model: cognition.model,
      safe_thought_summary: cognition.safe_thought_summary,
      felt_interpretation: cognition.felt_interpretation,
      response_intent_for_broca: cognition.response_intent_for_broca,
      normalized_model_json: cognition.normalized_model_json,
      raw_private_reasoning_stored: cognition.raw_private_reasoning_stored
    } : { error: cognition.error },
    speech: speech.enabled ? {
      text: speech.text,
      tone: speech.tone,
      audience: speech.audience
    } : { error: speech.error },
    core_brain_enabled_now: true,
    broca_enabled_now: speech.enabled,
    affect_scaffold_enabled_now: true,
    reflective_emotion_enabled_now: cognition.enabled,
    cognition_enabled_now: cognition.enabled,
    minecraft_enabled_now: false
  };
}

function createCoreBrain(options = {}) {
  const mode = options.mode || 'chat';
  const config = options.config || loadCoreBrainConfig(options.config_path || mode);
  validateCoreBrainConfig(config);

  const sessionId = options.session_id || newId(options.smoke ? 'chatsmoke' : mode + 'session');
  const diagnosticsPath = options.diagnostics_path || statePath('diagnostics.jsonl');

  const core = {
    module: 'core_brain',
    mode: config.mode,
    session_id: sessionId,
    diagnostics_path: diagnosticsPath,
    config,
    enabled_module_names: enabledModuleNames(config.modules),
    disabled_module_names: disabledModuleNames(config.modules),
    registered_module_names: registeredModuleNames(),
    unregistered_known_module_names: unregisteredKnownModuleNames(),
    modules: null
  };

  core.modules = buildModules(config, {
    diagnostics_path: diagnosticsPath,
    persist_diagnostics: options.persist_diagnostics,
    config
  });

  core.getModule = function(name) {
    return core.modules[name] || null;
  };

  core.requireModule = function(name) {
    return requireModule(core, name);
  };

  core.handleChatText = function(text, localOptions = {}) {
    return handleChatText(core, text, localOptions);
  };

  return Object.freeze(core);
}

module.exports = {
  CONFIG_VERSION,
  KNOWN_MODULES,
  CHAT_REQUIRED_MODULES,
  MODULE_REGISTRY,
  registeredModuleNames,
  unregisteredKnownModuleNames,
  configPathForMode,
  assertKnownYamlModules,
  normalizeModelSection,
  normalizeModules,
  loadCoreBrainConfig,
  validateCoreBrainConfig,
  enabledModuleNames,
  disabledModuleNames,
  missingRequiredModules,
  enabledModulesWithoutFactories,
  createCoreBrain,
  handleChatText,
  cognitionJsonFromOutput,
  speechJsonFromOutput,
  buildChatSmokeJson
};
