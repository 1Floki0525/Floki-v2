'use strict';

/**
 * Floki-v2 time utilities.
 *
 * Purpose:
 * - Provide stable wall-clock timestamps for persisted state.
 * - Provide monotonic timings for diagnostics and latency measurements.
 * - Keep all persisted time values explicit and ISO-8601 UTC.
 *
 * This file does not call models, Minecraft, the OS desktop, or network APIs.
 */

const { performance } = require('node:perf_hooks');

function nowDate() {
  return new Date();
}

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function monotonicMs() {
  return performance.now();
}

function toIso(value, fieldName = 'time') {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(`${fieldName} must be a valid Date`);
    }
    return value.toISOString();
  }

  if (typeof value === 'number') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new TypeError(`${fieldName} must be a valid millisecond timestamp`);
    }
    return date.toISOString();
  }

  if (typeof value === 'string') {
    assertIsoString(value, fieldName);
    return value;
  }

  throw new TypeError(`${fieldName} must be a Date, millisecond timestamp, or ISO string`);
}

function parseIso(value, fieldName = 'time') {
  assertIsoString(value, fieldName);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${fieldName} must be parseable as a valid ISO date`);
  }
  return date;
}

function assertIsoString(value, fieldName = 'time') {
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be an ISO-8601 UTC string`);
  }

  const isoUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  if (!isoUtcPattern.test(value)) {
    throw new TypeError(`${fieldName} must be ISO-8601 UTC format like 2026-06-16T12:00:00.000Z`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${fieldName} must be a valid normalized ISO-8601 UTC timestamp`);
  }

  return true;
}

function elapsedMs(startMonotonicMs, endMonotonicMs = monotonicMs()) {
  if (!Number.isFinite(startMonotonicMs) || !Number.isFinite(endMonotonicMs)) {
    throw new TypeError('elapsedMs requires finite monotonic millisecond values');
  }

  return Math.max(0, endMonotonicMs - startMonotonicMs);
}

function makeTimeContext() {
  return {
    wall_time_iso: nowIso(),
    wall_time_ms: nowMs(),
    monotonic_ms: monotonicMs()
  };
}

function sleep(ms) {
  if (!Number.isInteger(ms) || ms < 0 || ms > 60000) {
    throw new TypeError('sleep(ms) requires an integer from 0 to 60000');
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  nowDate,
  nowMs,
  nowIso,
  monotonicMs,
  toIso,
  parseIso,
  assertIsoString,
  elapsedMs,
  makeTimeContext,
  sleep
};
