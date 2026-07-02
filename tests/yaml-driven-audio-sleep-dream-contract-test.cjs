'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { loadYamlFile } = require('../src/config/yaml-lite.cjs');
const {
  PROJECT_ROOT,
  getAudioConfig,
  getSleepConfig,
  getDreamConfig
} = require('../src/config/floki-config.cjs');

function select(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}

function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );
  const raw = loadYamlFile(path.join(PROJECT_ROOT, 'config', 'chat.config.yaml'));
  const audio = getAudioConfig('chat');
  const sleep = getSleepConfig('chat');
  const dream = getDreamConfig('chat');

  const audioKeys = [
    'mic_device', 'mic_rate', 'mic_channels', 'mic_format',
    'wake_command_continuation_ms', 'recorder_max_restarts',
    'recorder_restart_backoff_max_ms', 'recorder_stop_timeout_ms',
    'microphone_readiness_timeout_ms', 'microphone_readiness_poll_ms',
    'whisper_model_size', 'piper_voice_name', 'piper_voice_size'
  ];
  const sleepKeys = [
    'timezone', 'start_hhmm', 'end_hhmm', 'idle_resume_seconds',
    'rem_interval_minutes', 'scheduler_tick_ms',
    'scheduler_heartbeat_refresh_ms', 'scheduler_heartbeat_stale_ms',
    'manual_nap_duration_minutes', 'manual_nap_rem_offset_minutes'
  ];
  const dreamKeys = [
    'temperature', 'top_p', 'num_predict', 'retry_temperature',
    'retry_top_p', 'retry_num_predict', 'retry_temperature_step',
    'retry_temperature_max', 'retry_top_p_step', 'retry_top_p_max',
    'quality_regeneration_attempts', 'quality_retry_backoff_seconds',
    'quality_retry_backoff_max_seconds'
  ];

  assert.deepEqual(select(audio, audioKeys), select(raw.audio, audioKeys));
  assert.deepEqual(select(sleep, sleepKeys), select(raw.sleep, sleepKeys));
  assert.deepEqual(select(dream, dreamKeys), select(raw.dream, dreamKeys));
  assert.ok(Number.isFinite(audio.wake_command_continuation_ms) && audio.wake_command_continuation_ms > 0);
  assert.ok(Number.isFinite(sleep.scheduler_tick_ms) && sleep.scheduler_tick_ms > 0);
  assert.ok(Number.isInteger(dream.quality_regeneration_attempts) && dream.quality_regeneration_attempts > 0);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_YAML_DRIVEN_AUDIO_SLEEP_DREAM_PASS',
    exact_values_read_from_active_yaml: true,
    no_test_owned_runtime_values: true,
    chat_mode_only: true
  }, null, 2));
}

try { run(); } catch (error) {
  console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_YAML_DRIVEN_AUDIO_SLEEP_DREAM_FAIL', error: error.stack || error.message }, null, 2));
  process.exit(1);
}
