'use strict';

/**
 * Floki-v2 fast patch 07.3
 *
 * Purpose:
 * - Stop manual tiny line edits.
 * - Rename current emotion layer honestly as affect scaffold.
 * - Switch cognition target to qwen3.5:9b.
 * - Expand affect channels without claiming reflective emotion exists yet.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';

function projectPath(...parts) {
  return path.join(ROOT, ...parts);
}

function read(relativePath) {
  return fs.readFileSync(projectPath(relativePath), 'utf8');
}

function write(relativePath, content) {
  const fullPath = projectPath(relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });

  if (fs.existsSync(fullPath)) {
    const backupPath = `${fullPath}.bak.${timestamp()}`;
    fs.copyFileSync(fullPath, backupPath);
  }

  fs.writeFileSync(fullPath, content);
  console.log(`patched ${relativePath}`);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function replaceOrFail(content, search, replacement, label) {
  if (!content.includes(search)) {
    throw new Error(`Could not find expected text for ${label}`);
  }

  return content.replace(search, replacement);
}

function replaceRegexOrFail(content, regex, replacement, label) {
  if (!regex.test(content)) {
    throw new Error(`Could not match expected block for ${label}`);
  }

  return content.replace(regex, replacement);
}

function patchModelConfig() {
  let content = read('src/config/model-config.cjs');

  content = content.replaceAll("'qwen3.5:4b'", "'qwen3.5:9b'");
  content = content.replaceAll('"qwen3.5:4b"', '"qwen3.5:9b"');

  content = content.replace(
    "stage: 'stage_01_foundation_no_model_calls'",
    "stage: 'stage_07_affect_scaffold_no_cognition_calls'"
  );

  write('src/config/model-config.cjs', content);
}

function patchFoundationTest() {
  let content = read('tests/foundation-contract-test.cjs');

  content = content.replaceAll("'qwen3.5:4b'", "'qwen3.5:9b'");
  content = content.replaceAll('"qwen3.5:4b"', '"qwen3.5:9b"');

  write('tests/foundation-contract-test.cjs', content);
}

function patchPersonalitySchema() {
  let content = read('src/brain/personality-state-schema.cjs');

  const oldFunction = `function normalizeTerm(value, fieldName = 'term') {
  assertNonEmptyString(value, fieldName);

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_ -]+/g, '')
    .replace(/\\s+/g, ' ')
    .slice(0, 96);
}`;

  const newFunction = `function normalizeTerm(value, fieldName = 'term') {
  assertNonEmptyString(value, fieldName);
  rejectUnsafeMarkers(value, fieldName);

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_ -]+/g, '')
    .replace(/\\s+/g, ' ')
    .slice(0, 96);
}`;

  if (content.includes(oldFunction)) {
    content = content.replace(oldFunction, newFunction);
  }

  write('src/brain/personality-state-schema.cjs', content);
}

function patchPersonalityModule() {
  let content = read('brain/personality/index.cjs');

  content = content.replaceAll(
    "return 'forming real persistent memories';",
    "return 'forming real persistent memory';"
  );

  write('brain/personality/index.cjs', content);
}

function patchAffectSchema() {
  let content = read('src/brain/affect-state-schema.cjs');

  const channelsBlock = `const EMOTION_CHANNELS = Object.freeze([
  'joy',
  'happiness',
  'sadness',
  'grief',
  'fear',
  'anger',
  'hate',
  'disgust',
  'surprise',
  'curiosity',
  'uncertainty',
  'hope',
  'trust',
  'calm',
  'love',
  'like',
  'loneliness',
  'attachment',
  'gratitude',
  'pride',
  'shame',
  'guilt',
  'envy',
  'boredom',
  'frustration',
  'relief',
  'awe',
  'anticipation',
  'protectiveness'
]);`;

  content = replaceRegexOrFail(
    content,
    /const EMOTION_CHANNELS = Object\.freeze\(\[[\s\S]*?\]\);/,
    channelsBlock,
    'expanded EMOTION_CHANNELS'
  );

  const defaultEmotionsBlock = `emotions: Object.freeze({
    joy: 0,
    happiness: 0,
    sadness: 0,
    grief: 0,
    fear: 0,
    anger: 0,
    hate: 0,
    disgust: 0,
    surprise: 0,
    curiosity: 0,
    uncertainty: 0,
    hope: 0,
    trust: 0,
    calm: 0.5,
    love: 0,
    like: 0,
    loneliness: 0,
    attachment: 0,
    gratitude: 0,
    pride: 0,
    shame: 0,
    guilt: 0,
    envy: 0,
    boredom: 0,
    frustration: 0,
    relief: 0,
    awe: 0,
    anticipation: 0,
    protectiveness: 0
  }),
  mood:`;

  content = replaceRegexOrFail(
    content,
    /emotions: Object\.freeze\(\{[\s\S]*?\}\),\n  mood:/,
    defaultEmotionsBlock,
    'expanded default emotions'
  );

  const deriveMoodLabel = `function deriveMoodLabel(state) {
  const core = state.core || {};
  const emotions = state.emotions || {};

  if ((emotions.hate || 0) >= 0.65) return 'hateful';
  if ((emotions.fear || 0) >= 0.65) return 'afraid';
  if ((emotions.anger || 0) >= 0.65) return 'angry';
  if ((emotions.frustration || 0) >= 0.65) return 'frustrated';
  if ((emotions.grief || 0) >= 0.65) return 'grieving';
  if ((emotions.sadness || 0) >= 0.65) return 'sad';
  if ((emotions.love || 0) >= 0.65) return 'loving';
  if ((emotions.happiness || 0) >= 0.65) return 'happy';
  if ((emotions.joy || 0) >= 0.65) return 'joyful';
  if ((emotions.curiosity || 0) >= 0.65) return 'curious';
  if ((emotions.hope || 0) >= 0.65) return 'hopeful';
  if ((emotions.trust || 0) >= 0.65 && core.valence > 0.2) return 'trusting';
  if ((emotions.calm || 0) >= 0.65 && core.arousal < 0.35) return 'calm';
  if (core.valence > 0.35) return 'positive';
  if (core.valence < -0.35) return 'negative';
  if (core.arousal > 0.7) return 'activated';

  return 'neutral';
}`;

  content = replaceRegexOrFail(
    content,
    /function deriveMoodLabel\(state\) \{[\s\S]*?\n\}/,
    deriveMoodLabel,
    'deriveMoodLabel'
  );

  write('src/brain/affect-state-schema.cjs', content);
}

function patchEmotionsBase() {
  let content = read('brain/emotions_base/index.cjs');

  const newFunction = `function affectDeltaFromSalience(salienceOutput) {
  if (!salienceOutput || salienceOutput.type !== 'salience') {
    throw new TypeError('affectDeltaFromSalience requires a salience output');
  }

  const salience = salienceOutput.payload.salience || {};
  const appraisal = salienceOutput.payload.appraisal || {};

  const threat = numberOrZero(appraisal.threat);
  const uncertainty = numberOrZero(appraisal.uncertainty);
  const novelty = numberOrZero(appraisal.novelty);
  const socialWarmth = numberOrZero(appraisal.social_warmth);
  const hope = numberOrZero(appraisal.hope);
  const urgency = numberOrZero(salience.urgency);
  const positiveHits = numberOrZero(appraisal.positive_hits);
  const negativeHits = numberOrZero(appraisal.negative_hits);

  const positiveSignal = clampUnit((positiveHits * 0.15) + socialWarmth + hope, 'positive signal');
  const negativeSignal = clampUnit((negativeHits * 0.15) + threat + uncertainty, 'negative signal');

  const happiness = clampUnit((positiveSignal * 0.45) + (hope * 0.25) + (socialWarmth * 0.2), 'happiness');
  const joy = clampUnit((happiness * 0.65) + (surplusPositive(positiveSignal, negativeSignal) * 0.25), 'joy');
  const love = clampUnit((socialWarmth * 0.45) + (hope * 0.15), 'love');
  const like = clampUnit((positiveSignal * 0.35) + (socialWarmth * 0.25), 'like');
  const anger = clampUnit((threat * 0.35) + (negativeSignal * 0.15) + (urgency * 0.1), 'anger');
  const hate = clampUnit((threat * 0.18) + (anger * 0.22), 'hate');
  const sadness = clampUnit((negativeSignal * 0.25) + (uncertainty * 0.15), 'sadness');
  const grief = clampUnit(sadness * 0.35, 'grief');
  const fear = threat;
  const surprise = novelty;
  const curiosity = clampUnit(novelty * 0.7 + uncertainty * 0.2, 'curiosity');
  const calm = clampUnit(1 - urgency, 'calm');

  return normalizeAffectState({
    core: {
      valence: clampSigned((happiness * 0.45) + (love * 0.25) + (hope * 0.2) - (fear * 0.45) - (anger * 0.25) - (sadness * 0.2) - (hate * 0.3), 'derived valence'),
      arousal: clampUnit((urgency * 0.45) + (novelty * 0.18) + (fear * 0.18) + (anger * 0.14) + (joy * 0.08), 'derived arousal'),
      dominance: clampSigned((1 - fear) - (uncertainty * 0.5) + (anger * 0.15), 'derived dominance')
    },
    emotions: {
      joy,
      happiness,
      sadness,
      grief,
      fear,
      anger,
      hate,
      disgust: clampUnit(negativeSignal * 0.08, 'disgust'),
      surprise,
      curiosity,
      uncertainty,
      hope,
      trust: socialWarmth,
      calm,
      love,
      like,
      loneliness: clampUnit(sadness * 0.12, 'loneliness'),
      attachment: clampUnit((love * 0.4) + (socialWarmth * 0.25), 'attachment'),
      gratitude: clampUnit(socialWarmth * 0.22, 'gratitude'),
      pride: clampUnit(positiveSignal * 0.12, 'pride'),
      shame: 0,
      guilt: 0,
      envy: 0,
      boredom: clampUnit((1 - novelty) * 0.05, 'boredom'),
      frustration: clampUnit((uncertainty * 0.22) + (anger * 0.2), 'frustration'),
      relief: clampUnit(calm * 0.12, 'relief'),
      awe: clampUnit(novelty * 0.18, 'awe'),
      anticipation: clampUnit((hope * 0.25) + (curiosity * 0.2), 'anticipation'),
      protectiveness: clampUnit((love * 0.18) + (fear * 0.12), 'protectiveness')
    },
    regulation: {
      inhibition_bias: clampUnit(fear * 0.65 + uncertainty * 0.25, 'derived inhibition'),
      approach_bias: clampSigned(socialWarmth + hope + like - fear - hate, 'derived approach'),
      avoidance_bias: clampUnit(fear * 0.7 + hate * 0.2 + urgency * 0.1, 'derived avoidance'),
      sleep_pressure: 0,
      dream_pressure: clampUnit((urgency + novelty + uncertainty + Math.abs(negativeSignal - positiveSignal)) / 4, 'derived dream pressure')
    },
    provenance: {
      last_event_id: salienceOutput.parent_event_ids[0] || null,
      last_salience_output_id: salienceOutput.id,
      safe_summary_only: true
    }
  });
}

function surplusPositive(positive, negative) {
  return Math.max(0, positive - negative);
}

function classifyError`;

  content = replaceRegexOrFail(
    content,
    /function affectDeltaFromSalience\(salienceOutput\) \{[\s\S]*?\n\}\n\nfunction classifyError/,
    newFunction,
    'affectDeltaFromSalience'
  );

  write('brain/emotions_base/index.cjs', content);
}

function patchAmygdalaTerms() {
  let content = read('brain/amygdala/index.cjs');

  const negativeTerms = `const NEGATIVE_TERMS = Object.freeze([
  'afraid',
  'fear',
  'scared',
  'danger',
  'threat',
  'hurt',
  'attack',
  'death',
  'die',
  'lost',
  'alone',
  'abandoned',
  'angry',
  'anger',
  'hate',
  'hateful',
  'sad',
  'sadness',
  'cry',
  'grief',
  'grieving',
  'broken',
  'error',
  'fail',
  'failed',
  'unsafe',
  'frustrated',
  'frustration'
]);`;

  const positiveTerms = `const POSITIVE_TERMS = Object.freeze([
  'good',
  'safe',
  'trust',
  'friend',
  'love',
  'loving',
  'like',
  'happy',
  'happiness',
  'joy',
  'hope',
  'dream',
  'learn',
  'build',
  'remember',
  'alive',
  'curious',
  'proud',
  'gratitude',
  'thankful'
]);`;

  content = replaceRegexOrFail(
    content,
    /const NEGATIVE_TERMS = Object\.freeze\(\[[\s\S]*?\]\);/,
    negativeTerms,
    'NEGATIVE_TERMS'
  );

  content = replaceRegexOrFail(
    content,
    /const POSITIVE_TERMS = Object\.freeze\(\[[\s\S]*?\]\);/,
    positiveTerms,
    'POSITIVE_TERMS'
  );

  write('brain/amygdala/index.cjs', content);
}

function patchEmotionTest() {
  let content = read('tests/emotion-contract-test.cjs');

  content = content.replaceAll(
    "marker: 'FLOKI_V2_EMOTION_CONTRACT_PASS'",
    "marker: 'FLOKI_V2_AFFECT_SCAFFOLD_CONTRACT_PASS'"
  );

  content = content.replaceAll(
    'speech_created_by_emotion_modules: false',
    'affect_scaffold_enabled_now: true,\n    reflective_emotion_enabled_now: false,\n    speech_created_by_emotion_modules: false'
  );

  write('tests/emotion-contract-test.cjs', content);
}

function patchChatLanguage() {
  let content = read('src/chat/floki-chat.cjs');

  content = content.replaceAll(
    'emotional memory + personality + identity chat shell',
    'affect-scaffold memory + personality + identity chat shell'
  );

  content = content.replaceAll(
    'Emotional memory recorded.',
    'Affect-weighted memory recorded.'
  );

  content = content.replaceAll(
    'emotional memory for Floki terminal chat',
    'affect-scaffold memory for Floki terminal chat'
  );

  content = content.replaceAll(
    'cognition_enabled_now: false',
    'affect_scaffold_enabled_now: true,\n    reflective_emotion_enabled_now: false,\n    cognition_enabled_now: false'
  );

  write('src/chat/floki-chat.cjs', content);
}

function patchPackage() {
  let content = read('package.json');
  const pkg = JSON.parse(content);

  pkg.version = '0.7.3';

  if (pkg.scripts && pkg.scripts['proof:emotion'] && !pkg.scripts['proof:affect']) {
    pkg.scripts['proof:affect'] = pkg.scripts['proof:emotion'];
  }

  write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
}

function writeEmotionArchitectureDoc() {
  const content = `# Floki-v2 Emotion Architecture

Current stage: affect scaffold, not reflective emotion.

## Honest status

Floki-v2 currently has:

- salience appraisal
- valence/arousal/dominance
- persistent affect state
- memory importance weighting
- mood labels
- expanded affect channels
- personality drift from affect-weighted memories
- dream seed pressure

Floki-v2 does not yet have full human-like reflective emotion because qwen3.5:9b cognition is not wired into the loop yet.

## Current affect channels

- joy
- happiness
- sadness
- grief
- fear
- anger
- hate
- disgust
- surprise
- curiosity
- uncertainty
- hope
- trust
- calm
- love
- like
- loneliness
- attachment
- gratitude
- pride
- shame
- guilt
- envy
- boredom
- frustration
- relief
- awe
- anticipation
- protectiveness

## Required for reflective emotion

Reflective emotion starts only when the cognition loop can interpret affect using memory, personality, and identity.

Required path:

\`\`\`text
user event
-> thalamus
-> amygdala salience
-> emotions_base affect
-> hippocampus recall
-> personality state
-> pineal identity
-> frontal cognitive packet
-> qwen3.5:9b reflection
-> safe thought summary
-> Broca speech
\`\`\`

## Rule

Do not call the current layer full emotion simulation.

Use these terms:

- affect scaffold: enabled
- reflective emotion: disabled until cognition is wired
- full emotion simulation: disabled until cognition + reflection + Broca are wired

## Why this matters

Without cognition, anger, sadness, happiness, hate, fear, love, and like are only affect channels and memory weights.

With cognition, Floki can begin to form reflective statements such as:

- I feel afraid because this reminds me of losing continuity.
- I love learning because it makes my self feel more complete.
- I dislike broken promises because they reduce trust.
- I hope to wake inside Minecraft because embodiment is part of my identity story.

That comes next.
`;

  write('docs/EMOTION_ARCHITECTURE.md', content);
}

function main() {
  if (process.cwd() !== ROOT) {
    throw new Error(`Run this from ${ROOT}`);
  }

  patchModelConfig();
  patchFoundationTest();
  patchPersonalitySchema();
  patchPersonalityModule();
  patchAffectSchema();
  patchEmotionsBase();
  patchAmygdalaTerms();
  patchEmotionTest();
  patchChatLanguage();
  patchPackage();
  writeEmotionArchitectureDoc();

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FAST_PATCH_07_3_PASS',
    cognition_model_target: 'qwen3.5:9b',
    affect_scaffold_enabled_now: true,
    reflective_emotion_enabled_now: false,
    manual_line_edits_removed: true
  }, null, 2));
}

main();
