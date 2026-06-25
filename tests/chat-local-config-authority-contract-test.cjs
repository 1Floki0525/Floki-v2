"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cfg = require("../src/config/floki-config.cjs");

const REQUIRED_SECTIONS = [
  "models",
  "modules",
  "policies",
  "vision",
  "chat_world_vision",
  "pineal_vision",
  "embodiment",
  "paths",
  "sleep",
  "dream",
  "wake_gate",
  "audio",
  "timeouts",
  "knowledge",
  "live_chat",
  "life_clock",
];

function nonEmptyString(value, label) {
  assert.equal(typeof value, "string", label + " must be a string");
  assert.ok(value.trim().length > 0, label + " must not be empty");
}

function finiteNumber(value, label) {
  assert.equal(Number.isFinite(value), true, label + " must be a finite number");
}

function run() {
  assert.equal(process.version, "v24.17.0", "Node v24.17.0 is required");

  const chatPath = path.join(cfg.PROJECT_ROOT, "config", "chat.config.yaml");
  assert.equal(fs.existsSync(chatPath), true);

  cfg.clearConfigCache();
  const chat = cfg.loadFlokiConfig("chat");

  assert.equal(chat.mode, "chat");
  assert.equal(chat.schema_version, "floki-v2-core-brain-config-v1");
  for (const section of REQUIRED_SECTIONS) {
    assert.ok(chat[section] && typeof chat[section] === "object", "chat." + section + " is required");
  }

  assert.equal(Object.prototype.hasOwnProperty.call(chat, "game_world_vision"), false);
  assert.ok(chat.chat_world_vision);
  assert.ok(chat.audio);
  assert.ok(chat.live_chat);

  const cognitionModel = chat.models.cognition.model;
  const visionModel = chat.models.vision.model;
  nonEmptyString(cognitionModel, "chat cognition model");
  nonEmptyString(visionModel, "chat vision model");

  const oldCognition = process.env.FLOKI_COGNITION_MODEL;
  const oldVision = process.env.FLOKI_VISION_MODEL;
  process.env.FLOKI_COGNITION_MODEL = "environment-must-not-select-a-model";
  process.env.FLOKI_VISION_MODEL = "environment-must-not-select-a-model";
  cfg.clearConfigCache();
  const environmentAttempt = cfg.loadFlokiConfig("chat");
  assert.equal(environmentAttempt.models.cognition.model, cognitionModel);
  assert.equal(environmentAttempt.models.vision.model, visionModel);
  if (oldCognition === undefined) delete process.env.FLOKI_COGNITION_MODEL;
  else process.env.FLOKI_COGNITION_MODEL = oldCognition;
  if (oldVision === undefined) delete process.env.FLOKI_VISION_MODEL;
  else process.env.FLOKI_VISION_MODEL = oldVision;
  cfg.clearConfigCache();

  const models = cfg.getModelConfig("chat");
  const paths = cfg.getPathConfig("chat");
  const sleep = cfg.getSleepConfig("chat");
  const dream = cfg.getDreamConfig("chat");
  const audio = cfg.getAudioConfig("chat");
  const timeouts = cfg.getTimeoutConfig("chat");
  const knowledge = cfg.getKnowledgeConfig("chat");
  const liveChat = cfg.getLiveChatConfig("chat");
  const lifeClock = cfg.getLifeClockConfig("chat");
  const vision = cfg.getVisionConfig("chat");
  const chatVision = cfg.getChatWorldVisionConfig("chat");
  const pineal = cfg.getPinealVisionConfig("chat");

  nonEmptyString(models.cognition.model, "models.cognition.model");
  nonEmptyString(models.vision.model, "models.vision.model");
  nonEmptyString(paths.chat_runtime_root, "paths.chat_runtime_root");
  nonEmptyString(paths.dream_root, "paths.dream_root");
  nonEmptyString(sleep.timezone, "sleep.timezone");
  finiteNumber(sleep.scheduler_tick_ms, "sleep.scheduler_tick_ms");
  finiteNumber(sleep.scheduler_heartbeat_refresh_ms, "sleep.scheduler_heartbeat_refresh_ms");
  finiteNumber(sleep.scheduler_heartbeat_stale_ms, "sleep.scheduler_heartbeat_stale_ms");
  finiteNumber(dream.temperature, "dream.temperature");
  finiteNumber(dream.quality_regeneration_attempts, "dream.quality_regeneration_attempts");
  finiteNumber(audio.mic_rate, "audio.mic_rate");
  finiteNumber(audio.wake_command_continuation_ms, "audio.wake_command_continuation_ms");
  finiteNumber(timeouts.ollama_http_ms, "timeouts.ollama_http_ms");
  assert.equal(typeof knowledge.autoload_enabled, "boolean");
  assert.equal(typeof liveChat.warm_cognition_on_start, "boolean");
  finiteNumber(lifeClock.ticks_per_second, "life_clock.ticks_per_second");
  assert.equal(vision.external_eyes_source, "webcam");
  assert.equal(chatVision.used_as_game_world_eyes, false);
  assert.equal(pineal.public_transcript_visible, false);

  console.log(JSON.stringify({
    ok: true,
    marker: "FLOKI_CHAT_LOCAL_CONFIG_AUTHORITY_PASS",
    config_source: "config/chat.config.yaml",
    environment_model_override_blocked: true,
    required_chat_sections_verified: REQUIRED_SECTIONS.length,
    other_modes_loaded: false,
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: "FLOKI_CHAT_LOCAL_CONFIG_AUTHORITY_FAIL",
    error: error.stack || error.message,
    other_modes_loaded: false,
  }, null, 2));
  process.exit(1);
}
