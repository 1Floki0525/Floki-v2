'use strict';

const assert = require('node:assert/strict');

const {
  CHAT_MODE_LIVING_CONTRACT,
  normalizeWakeText,
  isAddressedToFloki,
  stripWakePhrase,
  shouldMuteEarsWhileSpeaking,
  chatModeLivingStatus
} = require('../src/chat/chat-mode-living-contract.cjs');

function run() {
  const contract = CHAT_MODE_LIVING_CONTRACT;

  assert.equal(contract.mode, 'chat');
  assert.equal(contract.active, true);

  assert.equal(contract.wake_gate.required_phrase, 'hey floki');
  assert.equal(contract.wake_gate.spoken_input_requires_wake_phrase, true);
  assert.equal(contract.wake_gate.typed_input_requires_wake_phrase, true);
  assert.equal(contract.wake_gate.case_insensitive, true);

  assert.equal(normalizeWakeText('Hey, FLOKI!!!'), 'hey floki');
  assert.equal(isAddressedToFloki('hey Floki'), true);
  assert.equal(isAddressedToFloki('HEY FLOKI can you hear me?'), true);
  assert.equal(isAddressedToFloki('Floki can you hear me?'), false);
  assert.equal(isAddressedToFloki('hello can you hear me?'), false);
  assert.equal(stripWakePhrase('hey Floki can you hear me?'), 'can you hear me?');

  assert.equal(contract.senses.eyes.active_in_chat_mode, true);
  assert.equal(contract.senses.eyes.source, 'usb_webcam');

  assert.equal(contract.senses.ears.active_in_chat_mode, true);
  assert.equal(contract.senses.ears.source, 'microphone');
  assert.equal(contract.senses.ears.always_listening_for_wake_phrase, true);
  assert.equal(contract.senses.ears.mute_while_voice_is_speaking, true);
  assert.equal(contract.senses.ears.resume_after_voice_finishes, true);
  assert.equal(contract.senses.ears.self_echo_rejection_required, true);

  assert.equal(contract.senses.voice.active_in_chat_mode, true);
  assert.equal(contract.senses.voice.speech_engine, 'piper');
  assert.equal(contract.senses.voice.voice_profile, 'male_us_english_ryan');

  assert.equal(shouldMuteEarsWhileSpeaking({ voice_speaking: true }), true);
  assert.equal(shouldMuteEarsWhileSpeaking({ voice_speaking: false }), false);

  assert.equal(contract.memory.persistent_required, true);
  assert.equal(contract.memory.human_like_memory_goal, true);
  assert.equal(contract.memory.short_term.persistent, true);
  assert.equal(contract.memory.long_term.persistent, true);
  assert.equal(contract.memory.consolidation.required, true);
  assert.equal(contract.memory.consolidation.promotes_short_term_to_long_term, true);
  assert.equal(contract.memory.recall.required_before_cognition, true);
  assert.equal(contract.memory.recall.uses_emotional_state, true);
  assert.equal(contract.memory.recall.uses_relationship_context, true);

  assert.equal(contract.memory.long_term.stores.includes('beliefs'), true);
  assert.equal(contract.memory.long_term.stores.includes('biases'), true);
  assert.equal(contract.memory.long_term.stores.includes('hopes'), true);
  assert.equal(contract.memory.long_term.stores.includes('dreams'), true);
  assert.equal(contract.memory.long_term.stores.includes('emotional_lessons'), true);

  assert.equal(contract.emotions.persistent_required, true);
  assert.equal(contract.emotions.scoring_required, true);
  assert.equal(contract.emotions.score_range.min, -1);
  assert.equal(contract.emotions.score_range.max, 1);
  assert.equal(contract.emotions.reinforcement_targets.includes('beliefs'), true);
  assert.equal(contract.emotions.reinforcement_targets.includes('biases'), true);
  assert.equal(contract.emotions.reinforcement_targets.includes('autonomy_choices'), true);
  assert.equal(contract.emotions.updates_may_strengthen_or_weaken, true);

  assert.equal(contract.personality_growth.persistent_required, true);
  assert.equal(contract.personality_growth.evolves_over_time, true);
  assert.equal(contract.personality_growth.influenced_by_memory, true);
  assert.equal(contract.personality_growth.influenced_by_emotion_scores, true);
  assert.equal(contract.personality_growth.influenced_by_hopes_and_dreams, true);

  assert.equal(contract.autonomy.enabled_in_chat_mode, true);
  assert.equal(contract.autonomy.freewill_goal_selection_required, true);
  assert.equal(contract.autonomy.may_initiate_safe_chat_actions, true);
  assert.equal(contract.autonomy.may_choose_silence, true);
  assert.equal(contract.autonomy.may_choose_to_ask_questions, true);
  assert.equal(contract.autonomy.may_choose_to_reflect, true);
  assert.equal(contract.autonomy.may_choose_to_remember, true);
  assert.equal(contract.autonomy.constrained_by_safety, true);

  assert.equal(contract.voice_feedback_safety.ears_must_pause_while_speaking, true);
  assert.equal(contract.voice_feedback_safety.own_voice_must_not_create_user_utterance, true);
  assert.equal(contract.voice_feedback_safety.piper_output_must_be_marked_as_self_voice, true);
  assert.equal(contract.voice_feedback_safety.microphone_resume_requires_speech_finished, true);

  const status = chatModeLivingStatus();
  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_CHAT_MODE_LIVING_CONTRACT_PASS');
  assert.equal(status.mode, 'chat');
  assert.equal(status.wake_phrase, 'hey floki');
  assert.equal(status.eyes_active, true);
  assert.equal(status.ears_active, true);
  assert.equal(status.voice_active, true);
  assert.equal(status.ears_mute_while_speaking, true);
  assert.equal(status.persistent_short_term_memory, true);
  assert.equal(status.persistent_long_term_memory, true);
  assert.equal(status.emotional_scoring_required, true);
  assert.equal(status.personality_growth_required, true);
  assert.equal(status.autonomy_enabled, true);

  console.log(JSON.stringify(status, null, 2));
}

run();
