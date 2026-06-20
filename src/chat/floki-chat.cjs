'use strict';

const readline = require('node:readline');

const {
  createCoreBrain,
  loadCoreBrainConfig,
  cognitionJsonFromOutput,
  speechJsonFromOutput,
  buildChatSmokeJson
} = require('../../brain/core_brain/index.cjs');
const { buildVisionStatus } = require('../vision/vision-status.cjs');
const { buildFlokiLifecycleStatus, printLifecycleStatus } = require('./floki-lifecycle-status.cjs');
const { recordWakeActivityIfSleeping } = require('./sleep-cycle.cjs');
const { stopScheduler } = require('./sleep-cycle-scheduler.cjs');
const { stopChatWebcamVisionService } = require('../vision/chat-webcam-vision-service.cjs');

function createRuntime(options = {}) {
  return createCoreBrain({
    mode: 'chat',
    smoke: options.smoke === true,
    session_id: options.session_id,
    diagnostics_path: options.diagnostics_path,
    persist_diagnostics: options.persist_diagnostics
  });
}

async function handleUserText(runtime, text, options = {}) {
  recordWakeActivityIfSleeping({ reason: 'typed_chat_activity' });
  return runtime.handleChatText(text, options);
}

function buildSmokeJson(runtime, result) {
  return buildChatSmokeJson(runtime, result);
}

function printStatus() {
  const config = loadCoreBrainConfig('chat');
  const visionStatus = buildVisionStatus({ active_mode: 'chat' });
  const lifecycleStatus = buildFlokiLifecycleStatus();

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_STATUS',
    mode: 'chat',
    core_brain_enabled_now: true,
    config_path: config.source_path,
    enabled_modules: Object.keys(config.modules).filter((name) => config.modules[name].enabled),
    cognition_model: config.models.cognition.model,
    vision_model: config.models.vision.model,
    vision_status: visionStatus,
    lifecycle_status: lifecycleStatus,
    chat_mode_uses_webcam_eyes: visionStatus.chat_mode_uses_webcam_eyes,
    game_mode_uses_first_person_game_view: visionStatus.game_mode_uses_first_person_game_view,
    pineal_mind_eye_used_for_dreams: visionStatus.pineal_mind_eye_used_for_dreams,
    webcam_used_as_game_world_eyes: false,
    desktop_automation_used_for_sight: false,
    mineflayer_used: false,
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
  console.log('Current stage: core_brain + qwen cognition + Broca speech. Minecraft game mode is separate.');
  console.log('Config: ' + runtime.config.source_path);
  console.log('Commands: /help, /status, /state, /sleep-status, /exit');

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
        console.log('  /status       show chat/core_brain/cognition/Broca status');
        console.log('  /state        show awake/sleep/REM lifecycle status');
        console.log('  /sleep-status show awake/sleep/REM lifecycle status');
        console.log('  /exit         close chat');
        console.log('Any other text is routed through core_brain using config/chat.config.yaml.');
        rl.prompt();
        return;
      }

      if (text === '/status') {
        printStatus();
        rl.prompt();
        return;
      }

      if (text === '/state' || text === '/sleep-status') {
        printLifecycleStatus();
        rl.prompt();
        return;
      }

      let streamedReply = null;
      const result = await handleUserText(runtime, text, {
        on_public_text(payload) {
          if (streamedReply !== null) return;
          streamedReply = payload.text;
          console.log('floki> ' + payload.text);
        }
      });
      const cognition = cognitionJsonFromOutput(result.cognitionOutput);
      const speech = speechJsonFromOutput(result.speechOutput);

      if (speech.enabled && streamedReply === null) {
        console.log('floki> ' + speech.text);
      }
      if (speech.enabled && streamedReply !== null && speech.text !== streamedReply) {
        throw new Error('final text-chat reply differs from streamed Broca-authorized reply');
      }

      console.log(JSON.stringify({
        ok: cognition.enabled && speech.enabled,
        marker: cognition.enabled && speech.enabled ? 'FLOKI_V2_CHAT_CORE_BRAIN_SPEECH_RECORDED' : 'FLOKI_V2_CHAT_CORE_BRAIN_SPEECH_FAILED',
        event_id: result.event.id,
        memory_id: result.memoryOutput.payload.record.id,
        cognition_output_id: cognition.output_id || null,
        speech_output_id: speech.output_id || null,
        speech: speech.enabled ? speech.text : speech.error,
        core_brain_enabled_now: true,
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
  runSmoke,
  stopScheduler,
  stopChatWebcamVisionService
};

if (require.main === module) {
  main();
}
