'use strict';

/**
 * YAML-driven audio, sleep, dream contract test.
 *
 * Proves that:
 * - Sleep timezone/start/end/idle resume/REM offsets come from YAML.
 * - Dream temperature/top_p/num_predict/retry values come from YAML.
 * - Audio mic device/rate/channels/format/whisper model/voice settings come from YAML.
 * - Timeout values come from YAML.
 * - Life clock values come from YAML.
 */

const assert = require('node:assert/strict');

const cfg = require('../src/config/floki-config.cjs');

function run() {
  cfg.clearConfigCache();
  const chatSleep = cfg.getSleepConfig('chat');
  const chatDream = cfg.getDreamConfig('chat');
  const chatAudio = cfg.getAudioConfig('chat');
  const chatTimeouts = cfg.getTimeoutConfig('chat');
  const chatLifeClock = cfg.getLifeClockConfig('chat');

  assert.equal(typeof chatSleep.timezone, 'string', 'sleep.timezone must be a string from YAML');
  assert.ok(chatSleep.timezone.length > 0, 'sleep.timezone must be non-empty');
  assert.equal(chatSleep.timezone, 'America/Toronto', 'sleep.timezone must match YAML value');

  assert.equal(typeof chatSleep.start_hhmm, 'string', 'sleep.start_hhmm must be a string from YAML');
  assert.ok(chatSleep.start_hhmm.length > 0, 'sleep.start_hhmm must be non-empty');
  assert.equal(chatSleep.start_hhmm, '23:00', 'sleep.start_hhmm must match YAML value');

  assert.equal(typeof chatSleep.end_hhmm, 'string', 'sleep.end_hhmm must be a string from YAML');
  assert.ok(chatSleep.end_hhmm.length > 0, 'sleep.end_hhmm must be non-empty');
  assert.equal(chatSleep.end_hhmm, '07:00', 'sleep.end_hhmm must match YAML value');

  assert.equal(typeof chatSleep.idle_resume_seconds, 'number', 'sleep.idle_resume_seconds must be a number from YAML');
  assert.ok(chatSleep.idle_resume_seconds > 0, 'sleep.idle_resume_seconds must be positive');
  assert.equal(chatSleep.idle_resume_seconds, 120, 'sleep.idle_resume_seconds must match YAML value');

  assert.ok(chatSleep.rem_offsets_minutes, 'sleep.rem_offsets_minutes must be an object from YAML');
  assert.equal(typeof chatSleep.rem_offsets_minutes, 'object', 'sleep.rem_offsets_minutes must be an object');
  const remKeys = Object.keys(chatSleep.rem_offsets_minutes);
  assert.ok(remKeys.length >= 3, 'sleep.rem_offsets_minutes must have at least 3 cycles');
  assert.equal(chatSleep.rem_offsets_minutes.cycle_1, 90, 'rem_offsets_minutes.cycle_1 must match YAML');
  assert.equal(chatSleep.rem_offsets_minutes.cycle_2, 180, 'rem_offsets_minutes.cycle_2 must match YAML');
  assert.equal(chatSleep.rem_offsets_minutes.cycle_3, 270, 'rem_offsets_minutes.cycle_3 must match YAML');

  assert.equal(typeof chatDream.temperature, 'number', 'dream.temperature must be a number from YAML');
  assert.ok(chatDream.temperature > 0 && chatDream.temperature < 1, 'dream.temperature must be between 0 and 1');
  assert.equal(chatDream.temperature, 0.45, 'dream.temperature must match YAML value');

  assert.equal(typeof chatDream.top_p, 'number', 'dream.top_p must be a number from YAML');
  assert.ok(chatDream.top_p > 0 && chatDream.top_p <= 1, 'dream.top_p must be between 0 and 1');
  assert.equal(chatDream.top_p, 0.85, 'dream.top_p must match YAML value');

  assert.equal(typeof chatDream.num_predict, 'number', 'dream.num_predict must be a number from YAML');
  assert.ok(chatDream.num_predict > 0, 'dream.num_predict must be positive');
  assert.equal(chatDream.num_predict, 2800, 'dream.num_predict must match YAML value');

  assert.equal(typeof chatDream.retry_temperature, 'number', 'dream.retry_temperature must be a number from YAML');
  assert.equal(chatDream.retry_temperature, 0, 'dream.retry_temperature must match YAML value');

  assert.equal(typeof chatDream.retry_top_p, 'number', 'dream.retry_top_p must be a number from YAML');
  assert.equal(chatDream.retry_top_p, 0.1, 'dream.retry_top_p must match YAML value');

  assert.equal(typeof chatDream.retry_num_predict, 'number', 'dream.retry_num_predict must be a number from YAML');
  assert.equal(chatDream.retry_num_predict, 2200, 'dream.retry_num_predict must match YAML value');

  assert.equal(typeof chatAudio.mic_device, 'string', 'audio.mic_device must be a string from YAML');
  assert.ok(chatAudio.mic_device.length > 0, 'audio.mic_device must be non-empty');
  assert.equal(chatAudio.mic_device, 'default', 'audio.mic_device must match YAML value');

  assert.equal(typeof chatAudio.mic_rate, 'number', 'audio.mic_rate must be a number from YAML');
  assert.ok(chatAudio.mic_rate > 0, 'audio.mic_rate must be positive');
  assert.equal(chatAudio.mic_rate, 16000, 'audio.mic_rate must match YAML value');

  assert.equal(typeof chatAudio.mic_channels, 'number', 'audio.mic_channels must be a number from YAML');
  assert.ok(chatAudio.mic_channels > 0, 'audio.mic_channels must be positive');
  assert.equal(chatAudio.mic_channels, 1, 'audio.mic_channels must match YAML value');

  assert.equal(typeof chatAudio.mic_format, 'string', 'audio.mic_format must be a string from YAML');
  assert.ok(chatAudio.mic_format.length > 0, 'audio.mic_format must be non-empty');
  assert.equal(chatAudio.mic_format, 'S16_LE', 'audio.mic_format must match YAML value');

  assert.equal(typeof chatAudio.live_capture_seconds, 'number', 'audio.live_capture_seconds must be a number from YAML');
  assert.equal(chatAudio.live_capture_seconds, 2, 'audio.live_capture_seconds must match YAML value');

  assert.equal(typeof chatAudio.proof_capture_seconds, 'number', 'audio.proof_capture_seconds must be a number from YAML');
  assert.equal(chatAudio.proof_capture_seconds, 4, 'audio.proof_capture_seconds must match YAML value');

  assert.equal(typeof chatAudio.whisper_model_size, 'string', 'audio.whisper_model_size must be a string from YAML');
  assert.ok(chatAudio.whisper_model_size.length > 0, 'audio.whisper_model_size must be non-empty');
  assert.equal(chatAudio.whisper_model_size, 'small', 'audio.whisper_model_size must match YAML value');

  assert.equal(typeof chatAudio.voice_lock_ttl_ms, 'number', 'audio.voice_lock_ttl_ms must be a number from YAML');
  assert.equal(chatAudio.voice_lock_ttl_ms, 120000, 'audio.voice_lock_ttl_ms must match YAML value');

  assert.equal(typeof chatAudio.piper_voice_name, 'string', 'audio.piper_voice_name must be a string from YAML');
  assert.ok(chatAudio.piper_voice_name.length > 0, 'audio.piper_voice_name must be non-empty');
  assert.equal(chatAudio.piper_voice_name, 'en_US-ryan-high', 'audio.piper_voice_name must match YAML value');

  assert.equal(typeof chatAudio.piper_voice_size, 'string', 'audio.piper_voice_size must be a string from YAML');
  assert.equal(chatAudio.piper_voice_size, 'large', 'audio.piper_voice_size must match YAML value');

  assert.equal(typeof chatTimeouts.ollama_http_ms, 'number', 'timeouts.ollama_http_ms must be a number from YAML');
  assert.equal(chatTimeouts.ollama_http_ms, 120000, 'timeouts.ollama_http_ms must match YAML value');

  assert.equal(typeof chatTimeouts.model_warmup_ms, 'number', 'timeouts.model_warmup_ms must be a number from YAML');
  assert.equal(chatTimeouts.model_warmup_ms, 30000, 'timeouts.model_warmup_ms must match YAML value');

  assert.equal(typeof chatTimeouts.piper_synthesis_ms, 'number', 'timeouts.piper_synthesis_ms must be a number from YAML');
  assert.equal(chatTimeouts.piper_synthesis_ms, 60000, 'timeouts.piper_synthesis_ms must match YAML value');

  assert.equal(typeof chatTimeouts.speaker_playback_ms, 'number', 'timeouts.speaker_playback_ms must be a number from YAML');
  assert.equal(chatTimeouts.speaker_playback_ms, 60000, 'timeouts.speaker_playback_ms must match YAML value');

  assert.equal(typeof chatTimeouts.vad_ms, 'number', 'timeouts.vad_ms must be a number from YAML');
  assert.equal(chatTimeouts.vad_ms, 120000, 'timeouts.vad_ms must match YAML value');

  assert.equal(typeof chatTimeouts.whisper_ms, 'number', 'timeouts.whisper_ms must be a number from YAML');
  assert.equal(chatTimeouts.whisper_ms, 120000, 'timeouts.whisper_ms must match YAML value');

  assert.equal(typeof chatTimeouts.command_runner_ms, 'number', 'timeouts.command_runner_ms must be a number from YAML');
  assert.equal(chatTimeouts.command_runner_ms, 600000, 'timeouts.command_runner_ms must match YAML value');

  assert.equal(typeof chatTimeouts.knowledge_autoload_ms, 'number', 'timeouts.knowledge_autoload_ms must be a number from YAML');
  assert.equal(chatTimeouts.knowledge_autoload_ms, 5000, 'timeouts.knowledge_autoload_ms must match YAML value');

  assert.equal(typeof chatTimeouts.speech_loop_start_ms, 'number', 'timeouts.speech_loop_start_ms must be a number from YAML');
  assert.equal(chatTimeouts.speech_loop_start_ms, 20000, 'timeouts.speech_loop_start_ms must match YAML value');

  assert.equal(typeof chatLifeClock.ticks_per_second, 'number', 'life_clock.ticks_per_second must be a number from YAML');
  assert.equal(chatLifeClock.ticks_per_second, 20, 'life_clock.ticks_per_second must match YAML value');

  assert.equal(typeof chatLifeClock.ticks_per_day, 'number', 'life_clock.ticks_per_day must be a number from YAML');
  assert.equal(chatLifeClock.ticks_per_day, 24000, 'life_clock.ticks_per_day must match YAML value');

  assert.equal(typeof chatLifeClock.real_seconds_per_day, 'number', 'life_clock.real_seconds_per_day must be a number from YAML');
  assert.equal(chatLifeClock.real_seconds_per_day, 1200, 'life_clock.real_seconds_per_day must match YAML value');

  assert.ok(chatLifeClock.phase_ticks, 'life_clock.phase_ticks must be an object from YAML');
  assert.equal(typeof chatLifeClock.phase_ticks, 'object', 'life_clock.phase_ticks must be an object');
  assert.equal(chatLifeClock.phase_ticks.dawn, 23000, 'life_clock.phase_ticks.dawn must match YAML');
  assert.equal(chatLifeClock.phase_ticks.noon, 6000, 'life_clock.phase_ticks.noon must match YAML');
  assert.equal(chatLifeClock.phase_ticks.dusk, 12000, 'life_clock.phase_ticks.dusk must match YAML');
  assert.equal(chatLifeClock.phase_ticks.night, 13000, 'life_clock.phase_ticks.night must match YAML');
  assert.equal(chatLifeClock.phase_ticks.midnight, 18000, 'life_clock.phase_ticks.midnight must match YAML');

  cfg.clearConfigCache();
  const gameSleep = cfg.getSleepConfig('game');
  const gameDream = cfg.getDreamConfig('game');
  const gameAudio = cfg.getAudioConfig('game');
  const gameTimeouts = cfg.getTimeoutConfig('game');
  const gameLifeClock = cfg.getLifeClockConfig('game');

  assert.equal(typeof gameSleep.timezone, 'string', 'game sleep.timezone must come from YAML');
  assert.equal(typeof gameDream.temperature, 'number', 'game dream.temperature must come from YAML');
  assert.equal(typeof gameAudio.mic_rate, 'number', 'game audio.mic_rate must come from YAML');
  assert.equal(typeof gameTimeouts.ollama_http_ms, 'number', 'game timeouts.ollama_http_ms must come from YAML');
  assert.equal(typeof gameLifeClock.ticks_per_second, 'number', 'game life_clock.ticks_per_second must come from YAML');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_YAML_DRIVEN_AUDIO_SLEEP_DREAM_PASS',
    sleep_timezone_from_yaml: chatSleep.timezone === 'America/Toronto',
    sleep_start_from_yaml: chatSleep.start_hhmm === '23:00',
    sleep_end_from_yaml: chatSleep.end_hhmm === '07:00',
    sleep_idle_resume_from_yaml: chatSleep.idle_resume_seconds === 120,
    sleep_rem_offsets_from_yaml: Object.keys(chatSleep.rem_offsets_minutes).length >= 3,
    dream_temperature_from_yaml: chatDream.temperature === 0.45,
    dream_top_p_from_yaml: chatDream.top_p === 0.85,
    dream_num_predict_from_yaml: chatDream.num_predict === 2800,
    dream_retry_from_yaml: chatDream.retry_temperature === 0,
    audio_mic_device_from_yaml: chatAudio.mic_device === 'default',
    audio_mic_rate_from_yaml: chatAudio.mic_rate === 16000,
    audio_mic_channels_from_yaml: chatAudio.mic_channels === 1,
    audio_mic_format_from_yaml: chatAudio.mic_format === 'S16_LE',
    audio_whisper_model_from_yaml: chatAudio.whisper_model_size === 'small',
    audio_voice_lock_ttl_from_yaml: chatAudio.voice_lock_ttl_ms === 120000,
    audio_piper_voice_from_yaml: chatAudio.piper_voice_name === 'en_US-ryan-high',
    timeouts_all_from_yaml: typeof chatTimeouts.ollama_http_ms === 'number',
    life_clock_ticks_from_yaml: chatLifeClock.ticks_per_second === 20,
    life_clock_phase_ticks_from_yaml: typeof chatLifeClock.phase_ticks.dawn === 'number',
    game_config_sections_also_from_yaml: typeof gameSleep.timezone === 'string',
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_YAML_DRIVEN_AUDIO_SLEEP_DREAM_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
