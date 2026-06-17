'use strict';

/**
 * Floki-v2 life clock config.
 *
 * Purpose:
 * - Make Floki's standalone brain clock match the future Minecraft world rate.
 * - Keep the clock configurable and testable before Minecraft exists.
 * - Provide sleep/dream phase signals without wiring a game server.
 *
 * No PaperMC calls.
 * No Minecraft calls.
 * No body control.
 */

const { nowIso, parseIso } = require('../util/time.cjs');

const LIFE_CLOCK_CONFIG = Object.freeze({
  stage: 'stage_05_life_clock_no_minecraft',

  minecraft_rate: Object.freeze({
    ticks_per_second: 20,
    ticks_per_day: 24000,
    real_seconds_per_day: 1200,
    real_minutes_per_day: 20
  }),

  phases: Object.freeze({
    dawn_start_tick: 23000,
    day_start_tick: 0,
    noon_tick: 6000,
    dusk_start_tick: 12000,
    night_start_tick: 13000,
    midnight_tick: 18000,
    sleep_recommended_tick: 13000,
    dream_cycle_tick: 14000,
    wake_recommended_tick: 0
  }),

  sleep: Object.freeze({
    enabled_in_terminal_stage: true,
    requires_future_in_game_sleep_event: false,
    consolidate_memories_on_sleep: true,
    seed_dreams_on_sleep: true,
    vivid_dream_generation_requires_cognition: true,
    vivid_dream_generation_enabled_now: false
  })
});

function validateLifeClockConfig(config = LIFE_CLOCK_CONFIG) {
  const rate = config.minecraft_rate;
  const phases = config.phases;

  assertPositiveInteger(rate.ticks_per_second, 'ticks_per_second');
  assertPositiveInteger(rate.ticks_per_day, 'ticks_per_day');
  assertPositiveInteger(rate.real_seconds_per_day, 'real_seconds_per_day');

  if (rate.ticks_per_day !== rate.ticks_per_second * rate.real_seconds_per_day) {
    throw new Error('ticks_per_day must equal ticks_per_second * real_seconds_per_day');
  }

  for (const [name, value] of Object.entries(phases)) {
    assertTick(value, name, rate.ticks_per_day);
  }

  if (config.sleep.vivid_dream_generation_enabled_now !== false) {
    throw new Error('vivid dream generation must stay disabled until cognition + emotion + personality are wired');
  }

  return true;
}

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }
}

function assertTick(value, fieldName, ticksPerDay) {
  if (!Number.isInteger(value) || value < 0 || value >= ticksPerDay) {
    throw new TypeError(`${fieldName} must be an integer tick from 0 to ${ticksPerDay - 1}`);
  }
}

function normalizeTick(tick, config = LIFE_CLOCK_CONFIG) {
  const ticksPerDay = config.minecraft_rate.ticks_per_day;
  const numeric = Number(tick);

  if (!Number.isFinite(numeric)) {
    throw new TypeError('tick must be finite');
  }

  return ((Math.floor(numeric) % ticksPerDay) + ticksPerDay) % ticksPerDay;
}

function elapsedRealMs(startIso, currentIso = nowIso()) {
  const start = parseIso(startIso, 'startIso');
  const current = parseIso(currentIso, 'currentIso');

  return Math.max(0, current.getTime() - start.getTime());
}

function realMsToMinecraftTicks(realMs, config = LIFE_CLOCK_CONFIG) {
  if (!Number.isFinite(realMs) || realMs < 0) {
    throw new TypeError('realMs must be a finite number >= 0');
  }

  return Math.floor((realMs / 1000) * config.minecraft_rate.ticks_per_second);
}

function makeLifeClockState(input = {}) {
  validateLifeClockConfig();

  const brainStartedAt = input.brain_started_at || nowIso();
  const currentAt = input.current_at || nowIso();
  const baseTick = typeof input.base_tick === 'number' ? input.base_tick : 0;

  const elapsedMs = elapsedRealMs(brainStartedAt, currentAt);
  const elapsedTicks = realMsToMinecraftTicks(elapsedMs);
  const minecraftTick = normalizeTick(baseTick + elapsedTicks);
  const dayIndex = Math.floor((baseTick + elapsedTicks) / LIFE_CLOCK_CONFIG.minecraft_rate.ticks_per_day);

  return {
    created_at: currentAt,
    brain_started_at: brainStartedAt,
    base_tick: normalizeTick(baseTick),
    elapsed_real_ms: elapsedMs,
    elapsed_minecraft_ticks: elapsedTicks,
    minecraft_day_index: dayIndex,
    minecraft_tick: minecraftTick,
    phase: phaseForTick(minecraftTick),
    sleep_recommended: isSleepRecommended(minecraftTick),
    dream_seed_recommended: isDreamSeedRecommended(minecraftTick)
  };
}

function phaseForTick(tick, config = LIFE_CLOCK_CONFIG) {
  const t = normalizeTick(tick, config);
  const phases = config.phases;

  if (t >= phases.dawn_start_tick || t < 1000) {
    return 'dawn';
  }

  if (t >= phases.day_start_tick && t < phases.dusk_start_tick) {
    return 'day';
  }

  if (t >= phases.dusk_start_tick && t < phases.night_start_tick) {
    return 'dusk';
  }

  return 'night';
}

function isSleepRecommended(tick, config = LIFE_CLOCK_CONFIG) {
  const t = normalizeTick(tick, config);
  return t >= config.phases.sleep_recommended_tick && t < config.phases.dawn_start_tick;
}

function isDreamSeedRecommended(tick, config = LIFE_CLOCK_CONFIG) {
  const t = normalizeTick(tick, config);
  return t >= config.phases.dream_cycle_tick && t < config.phases.dawn_start_tick;
}

module.exports = {
  LIFE_CLOCK_CONFIG,
  validateLifeClockConfig,
  normalizeTick,
  elapsedRealMs,
  realMsToMinecraftTicks,
  makeLifeClockState,
  phaseForTick,
  isSleepRecommended,
  isDreamSeedRecommended
};
