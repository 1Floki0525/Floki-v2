'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  getPathConfig,
  getPinealVisionConfig
} = require('../config/floki-config.cjs');

function safeItems(value, limit = 8) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function privateInnerVisionLogPath(options = {}) {
  const mode = options.mode || 'chat';
  const paths = getPathConfig(mode);
  const pineal = getPinealVisionConfig(mode);
  const root = path.resolve(options.inner_vision_root || paths.dream_root);
  return path.join(root, pineal.private_inner_vision_subdir, pineal.private_inner_vision_log_name);
}

function buildInnerVisionSummary(inputs = {}) {
  const dreams = safeItems(inputs.dreams);
  const thoughts = safeItems(inputs.thoughts);
  const memories = safeItems(inputs.memories);
  const conversations = safeItems(inputs.conversations);
  const youtube = safeItems(inputs.youtube_transcripts || inputs.youtube_knowledge);
  const minecraft = safeItems(inputs.minecraft_experience || inputs.minecraft_memories);
  const emotions = safeItems(inputs.emotions);
  const personality = safeItems(inputs.personality);
  const beliefs = safeItems(inputs.beliefs);
  const parts = [
    dreams.length ? 'dream traces: ' + dreams.join('; ') : '',
    thoughts.length ? 'thought traces: ' + thoughts.join('; ') : '',
    memories.length ? 'memory echoes: ' + memories.join('; ') : '',
    conversations.length ? 'conversation residue: ' + conversations.join('; ') : '',
    youtube.length ? 'learned transcript imagery: ' + youtube.join('; ') : '',
    minecraft.length ? 'minecraft memory imagery: ' + minecraft.join('; ') : '',
    emotions.length ? 'emotional lighting: ' + emotions.join('; ') : '',
    personality.length ? 'personality texture: ' + personality.join('; ') : '',
    beliefs.length ? 'belief anchors: ' + beliefs.join('; ') : ''
  ].filter(Boolean);

  return parts.length
    ? parts.join(' | ')
    : 'quiet private inner field with no external-world observation claim';
}

function createPinealMindEyeScene(options = {}) {
  const mode = options.mode || 'chat';
  const pineal = getPinealVisionConfig(mode);
  if (pineal.enabled !== true) {
    throw new Error('pineal_vision.enabled must be true for mind-eye scene generation');
  }

  return Object.freeze({
    created_at: options.created_at || new Date().toISOString(),
    source: 'pineal_mind_eye',
    scene_summary: buildInnerVisionSummary(options),
    dreams_used: true,
    thoughts_used: true,
    memories_used: pineal.derive_from_memories === true,
    youtube_transcripts_used: pineal.derive_from_youtube_transcripts === true,
    conversations_used: pineal.derive_from_conversations === true,
    minecraft_experience_used: pineal.derive_from_minecraft_experience === true,
    emotions_used: pineal.derive_from_emotions === true,
    personality_used: pineal.derive_from_personality === true,
    beliefs_used: pineal.derive_from_beliefs === true,
    internal_reality: true,
    external_world_observation: false,
    public_transcript_visible: pineal.public_transcript_visible,
    spoken_aloud: pineal.spoken_aloud,
    private_inner_vision: true,
    chat_mode_only: mode !== 'game',
    game_mode_started: false
  });
}

function appendPrivateInnerVision(scene, options = {}) {
  if (options.write_private_inner_vision === false) {
    return Object.freeze({ written: false, reason: 'write_disabled', private_inner_vision_file: null });
  }
  const file = options.private_inner_vision_file || privateInnerVisionLogPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(scene) + '\n', 'utf8');
  return Object.freeze({
    written: true,
    private_inner_vision_file: file
  });
}

function runPinealMindEye(options = {}) {
  const scene = createPinealMindEyeScene(options);
  const write = appendPrivateInnerVision(scene, options);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_PINEAL_MIND_EYE_CONTRACT_PASS',
    scene,
    private_inner_vision_written: write.written === true,
    private_inner_vision_file: write.private_inner_vision_file || null,
    internal_reality: true,
    external_world_observation: false,
    public_transcript_visible: false,
    spoken_aloud: false,
    webcam_used: false,
    minecraft_first_person_used: false,
    private_thought_leaked_to_public_transcript: false,
    chat_mode_only: options.mode !== 'game',
    game_mode_started: false
  });
}

module.exports = {
  safeItems,
  privateInnerVisionLogPath,
  buildInnerVisionSummary,
  createPinealMindEyeScene,
  appendPrivateInnerVision,
  runPinealMindEye
};
