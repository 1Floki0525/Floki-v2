'use strict';

const readline = require('node:readline');

const { makeUserTextEvent } = require('../brain/brain-event-schema.cjs');
const { summarizeAffectForMemory } = require('../brain/affect-state-schema.cjs');
const { createThalamus } = require('../../brain/thalamus/index.cjs');
const { createTemporal } = require('../../brain/temporal/index.cjs');
const { createAmygdala } = require('../../brain/amygdala/index.cjs');
const { createEmotionsBase } = require('../../brain/emotions_base/index.cjs');
const { createHippocampus } = require('../../brain/hippocampus/index.cjs');
const { createPersonality } = require('../../brain/personality/index.cjs');
const { createPineal } = require('../../brain/pineal/index.cjs');
const { createFrontal } = require('../../brain/frontal/index.cjs');
const { createBroca } = require('../../brain/broca/index.cjs');
const { statePath } = require('../util/fs-safe.cjs');
const { newId } = require('../util/ids.cjs');
const models = require('../config/model-config.cjs');

function createRuntime(options = {}) {
  const sessionId = options.session_id || newId(options.smoke ? 'chatsmoke' : 'chatsession');
  const diagnosticsPath = options.diagnostics_path || statePath('diagnostics.jsonl');

  return {
    session_id: sessionId,
    diagnostics_path: diagnosticsPath,
    thalamus: createThalamus({ diagnostics_path: diagnosticsPath }),
    temporal: createTemporal({ diagnostics_path: diagnosticsPath }),
    amygdala: createAmygdala({ diagnostics_path: diagnosticsPath }),
    emotions: createEmotionsBase({ diagnostics_path: diagnosticsPath }),
    hippocampus: createHippocampus({ diagnostics_path: diagnosticsPath }),
    personality: createPersonality({ diagnostics_path: diagnosticsPath }),
    pineal: createPineal({ diagnostics_path: diagnosticsPath }),
    frontal: createFrontal({ diagnostics_path: diagnosticsPath }),
    broca: createBroca({ diagnostics_path: diagnosticsPath })
  };
}

function memoryMatchesForContext(recallOutput) {
  if (!recallOutput || !recallOutput.payload || !Array.isArray(recallOutput.payload.matches)) {
    return [];
  }

  return recallOutput.payload.matches.map(function(match) {
    const record = match.record || match;
    return {
      memory_id: record.id || null,
      summary: record.content && record.content.summary ? record.content.summary : '',
      tags: Array.isArray(record.tags) ? record.tags : [],
      affect: record.affect || {}
    };
  });
}

async function handleUserText(runtime, text) {
  const event = makeUserTextEvent(text, { trace_id: runtime.session_id });

  const routeOutput = runtime.thalamus.routeEvent(event);
  const understandingOutput = runtime.temporal.understandEvent(event);
  const salienceOutput = runtime.amygdala.computeSalience(event);
  const affectDelta = runtime.emotions.affectDeltaFromSalience(salienceOutput);
  const affectOutput = runtime.emotions.applyAffectDelta(affectDelta);
  const affectSummary = summarizeAffectForMemory(affectOutput.payload.state);

  const memoryOutput = runtime.hippocampus.rememberEvent(event, {
    stream: 'short_term',
    type: 'experience',
    tags: ['terminal_chat', 'qwen_cognition', 'broca_speech', understandingOutput.payload.intent_hint],
    importance: salienceOutput.payload.salience.memory_importance_hint,
    affect: {
      valence: affectSummary.valence,
      arousal: affectSummary.arousal
    }
  });

  const personalityOutput = runtime.personality.updateFromMemory(memoryOutput.payload.record);
  const identityOutput = runtime.pineal.updateFromMemory(memoryOutput.payload.record, personalityOutput.payload.current);

  const recallOutput = runtime.hippocampus.recall({
    text: text,
    streams: ['short_term', 'episodic', 'semantic', 'autobiographical'],
    limit: 5
  });

  const cognitionOutput = await runtime.frontal.runCognition({
    event: event,
    route: routeOutput.payload || null,
    understanding: understandingOutput.payload,
    salience: salienceOutput.payload,
    affect: affectSummary,
    memories: memoryMatchesForContext(recallOutput),
    personality: personalityOutput.payload.current,
    identity: identityOutput.payload.current
  });

  const speechOutput = runtime.broca.speakFromCognition(cognitionOutput, {
    parent_event_ids: [event.id],
    include_stage_truth: true
  });

  return {
    event,
    routeOutput,
    understandingOutput,
    salienceOutput,
    affectOutput,
    affectSummary,
    memoryOutput,
    personalityOutput,
    identityOutput,
    recallOutput,
    cognitionOutput,
    speechOutput
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

function buildSmokeJson(runtime, result) {
  const cognition = cognitionJsonFromOutput(result.cognitionOutput);
  const speech = speechJsonFromOutput(result.speechOutput);

  return {
    ok: cognition.enabled && speech.enabled,
    marker: cognition.enabled && speech.enabled ? 'FLOKI_V2_CHAT_BROCA_SHELL_PASS' : 'FLOKI_V2_CHAT_BROCA_SHELL_FAIL',
    session_id: runtime.session_id,
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
    broca_enabled_now: speech.enabled,
    affect_scaffold_enabled_now: true,
    reflective_emotion_enabled_now: cognition.enabled,
    cognition_enabled_now: cognition.enabled,
    minecraft_enabled_now: false
  };
}

function printStatus() {
  const config = models.getModelConfig();
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_STATUS',
    mode: 'chat',
    cognition_model: config.cognition.model,
    vision_model: config.vision.model,
    affect_scaffold_enabled_now: true,
    qwen_cognition_available_in_chat_now: true,
    broca_enabled_now: true,
    minecraft_enabled_now: false
  }, null, 2));
}

async function runSmoke() {
  const runtime = createRuntime({ smoke: true });
  const result = await handleUserText(runtime, 'Smoke test: Floki should remember, learn, speak, and form hope before Minecraft embodiment.');
  const json = buildSmokeJson(runtime, result);
  console.log(JSON.stringify(json, null, 2));
  if (!json.ok) process.exit(1);
}

async function runInteractive() {
  const runtime = createRuntime();

  console.log('FLOKI_V2_TERMINAL_CHAT_READY');
  console.log('session: ' + runtime.session_id);
  console.log('Current stage: qwen cognition + Broca speech chat shell. Minecraft game mode is separate.');
  console.log('Commands: /help, /status, /exit');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'you> '
  });

  rl.prompt();

  rl.on('line', async function(line) {
    const text = line.trim();

    try {
      if (!text) {
        rl.prompt();
        return;
      }

      if (text === '/exit' || text === '/quit') {
        rl.close();
        return;
      }

      if (text === '/help') {
        console.log('Commands:');
        console.log('  /status  show chat/cognition/Broca status');
        console.log('  /exit    close chat');
        console.log('Any other text is routed through memory, affect scaffold, personality, identity, qwen3.5:9b cognition, and Broca speech.');
        rl.prompt();
        return;
      }

      if (text === '/status') {
        printStatus();
        rl.prompt();
        return;
      }

      const result = await handleUserText(runtime, text);
      const cognition = cognitionJsonFromOutput(result.cognitionOutput);
      const speech = speechJsonFromOutput(result.speechOutput);

      if (speech.enabled) {
        console.log('floki> ' + speech.text);
      }

      console.log(JSON.stringify({
        ok: cognition.enabled && speech.enabled,
        marker: cognition.enabled && speech.enabled ? 'FLOKI_V2_CHAT_BROCA_SPEECH_RECORDED' : 'FLOKI_V2_CHAT_BROCA_SPEECH_FAILED',
        event_id: result.event.id,
        memory_id: result.memoryOutput.payload.record.id,
        cognition_output_id: cognition.output_id || null,
        speech_output_id: speech.output_id || null,
        speech: speech.enabled ? speech.text : speech.error,
        broca_enabled_now: speech.enabled,
        cognition_enabled_now: cognition.enabled,
        reflective_emotion_enabled_now: cognition.enabled,
        minecraft_enabled_now: false
      }, null, 2));
    } catch (error) {
      console.error(JSON.stringify({
        ok: false,
        marker: 'FLOKI_V2_CHAT_ERROR',
        error: error.message
      }, null, 2));
    }

    rl.prompt();
  });

  rl.on('close', function() {
    console.log('FLOKI_V2_TERMINAL_CHAT_CLOSED');
  });
}

function main() {
  if (process.argv.includes('--smoke')) {
    runSmoke().catch(function(error) {
      console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_CHAT_BROCA_SHELL_FAIL', error: error.message }, null, 2));
      process.exit(1);
    });
    return;
  }

  if (process.argv.includes('--status')) {
    printStatus();
    return;
  }

  runInteractive().catch(function(error) {
    console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_CHAT_START_FAIL', error: error.message }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  createRuntime,
  handleUserText,
  buildSmokeJson,
  runSmoke
};

main();
