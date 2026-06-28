'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadYamlFile } = require('../src/config/yaml-lite.cjs');
const {
  configuredProhibitedPublicVisionTerms
} = require('../src/runtime/chat-local-runtime.cjs');
const {
  upsertChatTranscriptTurn,
  readChatTranscriptTail,
  appendPrivateThoughtRecord
} = require('../src/chat/chat-transcript.cjs');
const {
  buildRemCycles,
  beginManualNap,
  claimDueRemCycle,
  finishRemCycle,
  readManualNapState
} = require('../src/chat/manual-nap.cjs');
const { createLiveAudioService } = require('../src/senses/live-audio-service.cjs');
const { createChatLocalInterfaceApi, INTERFACE_TAB_CONTRACT } = require('../src/runtime/chat-local-interface-api.cjs');

function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        const value = predicate();
        if (value) { resolve(value); return; }
      } catch (error) { reject(error); return; }
      if (Date.now() - started >= timeoutMs) { reject(new Error('timed out waiting for behavioral condition')); return; }
      setTimeout(check, 5);
    };
    check();
  });
}

function makeRecorder(frameBytes, created) {
  const child = new EventEmitter();
  child.pid = 40000 + created.length;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { setImmediate(() => child.emit('close', 0, 'SIGTERM')); return true; };
  created.push(child);
  setTimeout(() => child.stdout.emit('data', Buffer.alloc(frameBytes)), 5);
  return child;
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-chat-local-final-repair-'));
  const transcriptDir = path.join(temp, 'interface');
  const stateFile = path.join(temp, 'manual-nap.json');
  const fixtureFile = path.join(temp, 'chat.config.yaml');

  try {
    let fixtureText = fs.readFileSync(path.join(__dirname, '../config/chat.config.yaml.temp'), 'utf8');
    const setYamlScalar = (key, value) => {
      const expression = new RegExp('^(\\s*' + key + ':\\s*).+$', 'm');
      if (!expression.test(fixtureText)) throw new Error('temporary YAML fixture is missing ' + key);
      fixtureText = fixtureText.replace(expression, '$1' + String(value));
    };
    setYamlScalar('manual_nap_duration_minutes', 0.06);
    setYamlScalar('rem_interval_minutes', 0.02);
    setYamlScalar('manual_nap_rem_offset_minutes', 0.02);
    setYamlScalar('manual_nap_max_rem_cycles', 2);
    setYamlScalar('microphone_readiness_poll_ms', 5);
    setYamlScalar('microphone_readiness_timeout_ms', 250);
    setYamlScalar('recorder_stop_timeout_ms', 100);
    setYamlScalar('vad_start_frames', 1);
    setYamlScalar('vad_end_frames', 1);
    setYamlScalar('pre_roll_ms', 0);
    setYamlScalar('post_roll_ms', 0);
    setYamlScalar('attention_scan_enabled', 'false');
    setYamlScalar('quality_retry_backoff_seconds', 1);
    setYamlScalar('quality_retry_backoff_max_seconds', 2);
    fs.writeFileSync(fixtureFile, fixtureText, 'utf8');
    const fixture = loadYamlFile(fixtureFile);

    // 1-2. Sight grounding preserves a rich scene for cognition and strips internal framing from summaries.
    const scene = {
      available: true,
      fresh: true,
      observation_summary: 'A lived-in room contains two people near a couch, a chair, a cup, wall decorations, and an open doorway.',
      detected_people_count: 2,
      detected_objects: [
        { label: 'chair', count: 1 },
        { label: 'cup', count: 1 },
        { label: 'couch', count: 1 },
        { label: 'wall decoration', count: 2 },
        { label: 'doorway', count: 1 }
      ]
    };
    assert.match(scene.observation_summary, /open doorway/i);
    assert.equal(scene.detected_objects.length, 5);
    for (const phrase of configuredProhibitedPublicVisionTerms(fixture.vision)) {
      assert.equal(scene.observation_summary.toLowerCase().includes(phrase), false, phrase);
    }

    // 3-7. Exercise the real audio service callback path: split wake continuation,
    // partial-to-final replacement, transcript-before-cognition/TTS, and mic lock/reopen.
    const timeline = [];
    const recorders = [];
    const transcripts = [];
    const whisperTexts = ['Hey Floki', 'what can you see?'];
    let speakingHandler = null;
    let directTurns = 0;
    const frameBytes = Number(fixture.audio.vad_frame_samples) * Number(fixture.audio.mic_channels) * 2;

    const whisper = {
      status: () => ({ ready: true, backend: 'fixture' }),
      start: async () => undefined,
      stop: async () => undefined,
      transcribe: async () => {
        const text = whisperTexts.shift();
        if (!text) throw new Error('unexpected extra Whisper transcription');
        return { speech_text: text, raw_text: text, ambient_labels: [] };
      }
    };
    const piper = {
      status: () => ({ ready: true, playback_ready: true }),
      refreshReadiness: () => undefined,
      setOnSpeakingChange(handler) { speakingHandler = handler; },
      async speak() {
        timeline.push('tts-playback');
        await speakingHandler(true);
        await speakingHandler(false);
        return { ok: true };
      },
      interrupt: async () => ({ ok: true })
    };

    const service = createLiveAudioService({
      runtime_dir: path.join(temp, 'audio-runtime'),
      voice_lock_file: path.join(temp, 'voice-lock.json'),
      initial_awake: true,
      audio_config: fixture.audio,
      wake_gate_config: fixture.wake_gate,
      interface_settings: { voice: { showPartialTranscription: true, speakerEnabled: true } },
      deps: {
        whisper,
        piper,
        disable_vad_worker: true,
        recorder_factory: () => makeRecorder(frameBytes, recorders)
      },
      on_transcript(event) {
        timeline.push('transcript-' + event.phase);
        const written = upsertChatTranscriptTurn({
          id: 'speech-' + event.id,
          role: 'user',
          text: event.text,
          input_modality: 'spoken',
          output_modality: 'none',
          source: 'focused_behavior_test',
          transcript_state: event.phase
        }, { transcript_dir: transcriptDir });
        transcripts.push(written.entry);
      },
      on_cognition_start() { timeline.push('cognition-start'); },
      on_tts_start() { timeline.push('tts-start'); },
      on_microphone_lifecycle(event) {
        timeline.push('mic-' + event.phase);
        if (event.phase === 'closed_for_tts') {
          assert.equal(event.microphone_open, false);
          assert.equal(event.speaking, true);
        }
        if (event.phase === 'reopened_after_tts') {
          assert.equal(event.microphone_open, true);
          assert.equal(event.fresh_pcm_received, true);
        }
      },
      async on_direct_speech(input) {
        directTurns += 1;
        timeline.push('direct-turn');
        assert.equal(input.raw_text, 'Hey Floki, what can you see?');
        assert.equal(input.request_text, 'what can you see?');
        return { ok: true, reply: 'I am forming a grounded response from the scene.' };
      }
    });

    await service.start();
    const frame = Buffer.alloc(frameBytes);
    for (const probability of [0.95, 0.05, 0.05]) service.injectVadProbability(frame, probability);
    await waitFor(() => timeline.includes('transcript-partial') || (service.status().last_error && (() => { throw new Error('audio error: ' + service.status().last_error + ' timeline=' + JSON.stringify(timeline)); })()));
    assert.equal(directTurns, 0, 'wake phrase alone must not create a cognition turn');
    assert.equal(service.status().microphone_open, true, 'microphone must stay active while waiting for continuation');

    for (const probability of [0.95, 0.05, 0.05]) service.injectVadProbability(frame, probability);
    await waitFor(() => timeline.includes('mic-reopened_after_tts') || (service.status().last_error && (() => { throw new Error('audio error: ' + service.status().last_error + ' timeline=' + JSON.stringify(timeline)); })()));
    await service.stop();

    assert.equal(directTurns, 1);
    assert.ok(timeline.indexOf('transcript-final') < timeline.indexOf('cognition-start'));
    assert.ok(timeline.indexOf('transcript-final') < timeline.indexOf('tts-start'));
    assert.ok(timeline.indexOf('mic-closed_for_tts') < timeline.indexOf('mic-reopened_after_tts'));
    const transcript = readChatTranscriptTail(20, { transcript_dir: transcriptDir });
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0].text, 'Hey Floki, what can you see?');
    assert.equal(transcript[0].transcript_state, 'final');
    assert.equal(transcripts.some((entry) => entry.transcript_state === 'partial'), true);
    assert.equal(transcripts.at(-1).transcript_state, 'final');

    // 8-9. The authoritative backend returns only persisted, natural first-person inner events.
    appendPrivateThoughtRecord({ text: 'I hear the Maker asking what I can see.', category: 'hearing' }, { transcript_dir: transcriptDir });
    appendPrivateThoughtRecord({ text: 'I notice two people and a cup nearby.', category: 'perception' }, { transcript_dir: transcriptDir });
    const api = createChatLocalInterfaceApi({
      runtime_dir: temp,
      transcript_options: { transcript_dir: transcriptDir },
      status: () => ({ api_ready: true, websocket_ready: true, memory_loaded: true, brain_loaded: true, lifecycle: { is_awake: true }, hearing: {} })
    });
    const neural = api.buildNeuralEvents(20);
    assert.equal(neural.length, 2);
    assert.equal(neural.every((entry) => /^I\b/.test(entry.summary)), true);
    assert.equal(neural.some((entry) => /payload|trace id|process id|marker|transport|file path|\{\s*"/i.test(entry.summary)), false);
    assert.equal(neural.every((entry) => Object.keys(entry).every((key) => !['traceId', 'processId', 'payload', 'filePath', 'marker'].includes(key))), true);

    // Every visible tab is declared against the one authoritative backend contract.
    const coverage = api.coverage();
    assert.equal(coverage.connected, true);
    assert.equal(coverage.backend_owners, 1);
    assert.equal(coverage.mock_mode, false);
    assert.deepEqual(Object.keys(coverage.tabs).sort(), Object.keys(INTERFACE_TAB_CONTRACT).sort());
    for (const [tab, contract] of Object.entries(coverage.tabs)) {
      assert.ok(contract.reads.length + contract.writes.length + contract.live_events.length > 0, tab);
    }
    assert.equal(api.getTranscript(20).length, 1);

    // 10-14. Accelerated nap schedule is derived from temporary YAML and starts REM at offset zero.
    const start = '2026-06-23T20:00:00.000Z';
    const wake = new Date(new Date(start).getTime() + Number(fixture.sleep.manual_nap_duration_minutes) * 60000).toISOString();
    const expected = buildRemCycles(start, wake, fixture.sleep.manual_nap_rem_offset_minutes, fixture.sleep.rem_interval_minutes, [], { max_rem_cycles: fixture.sleep.manual_nap_max_rem_cycles });
    assert.equal(expected.length, 2);
    assert.equal(expected[0].scheduled_at, new Date(new Date(start).getTime() + Number(fixture.sleep.manual_nap_rem_offset_minutes) * 60000).toISOString());
    assert.equal(expected.some((cycle) => cycle.scheduled_at === wake), false);

    let nap = beginManualNap({ state_file: stateFile, now: start, sleep_config: fixture.sleep });
    assert.equal(nap.rem_cycles.length, 2);
    assert.equal(claimDueRemCycle({ state_file: stateFile, now: start, sleep_config: fixture.sleep }), null, 'no REM is due at nap start');
    const firstRemAt = expected[0].scheduled_at;
    let claim = claimDueRemCycle({ state_file: stateFile, now: firstRemAt, sleep_config: fixture.sleep });
    assert.equal(claim.cycle.cycle_number, 1);
    assert.equal(claimDueRemCycle({ state_file: stateFile, now: firstRemAt, sleep_config: fixture.sleep }), null, 'a claimed cycle cannot be duplicated');

    nap = finishRemCycle({ regeneration_needed: true, last_error: 'quality retry' }, null, {
      state_file: stateFile,
      now: new Date(new Date(firstRemAt).getTime() + 10).toISOString(),
      sleep_config: fixture.sleep,
      dream_config: fixture.dream
    });
    assert.equal(nap.rem_cycles.filter((cycle) => cycle.status === 'complete').length, 0);
    assert.equal(nap.rem_cycles[0].status, 'pending');
    assert.equal(claimDueRemCycle({ state_file: stateFile, now: new Date(new Date(start).getTime() + 20).toISOString(), sleep_config: fixture.sleep }), null);

    const retryAt = new Date(nap.rem_cycles[0].next_retry_at).getTime() + 1;
    claim = claimDueRemCycle({ state_file: stateFile, now: new Date(retryAt).toISOString(), sleep_config: fixture.sleep });
    assert.equal(claim.cycle.cycle_number, 1);
    nap = finishRemCycle({ dream_txt_file: '/tmp/dream.txt', dream_metadata_file: '/tmp/dream.json' }, null, {
      state_file: stateFile,
      now: new Date(retryAt + 10).toISOString(),
      sleep_config: fixture.sleep,
      dream_config: fixture.dream
    });
    assert.equal(nap.rem_cycles.filter((cycle) => cycle.status === 'complete').length, 1);
    assert.equal(readManualNapState({ state_file: stateFile, now: new Date(new Date(wake).getTime() - 1).toISOString(), sleep_config: fixture.sleep }).rem_cycles.length, 2);
    const woken = readManualNapState({ state_file: stateFile, now: wake, sleep_config: fixture.sleep });
    assert.equal(woken.active, false);
    assert.equal(woken.rem_cycles.length, 2);
    assert.equal(woken.nightly_schedule_modified, false);

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_CHAT_LOCAL_FINAL_PRODUCTION_REPAIR_PASS',
      embodied_sight: true,
      spoken_transcript_before_cognition_and_tts: true,
      split_wake_single_turn: true,
      microphone_tts_lock_and_fresh_reopen: true,
      neural_stream_natural: true,
      rem_cycles: 2,
      all_tabs_authoritative_backend: true
    }, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, marker: 'FLOKI_CHAT_LOCAL_FINAL_PRODUCTION_REPAIR_FAIL', error: error.stack || error.message }, null, 2));
  process.exit(1);
});
