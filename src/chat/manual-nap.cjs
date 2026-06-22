'use strict';
const path = require('node:path');
const { statePath, readJsonFileSync, writeJsonFileAtomicSync, existsSync } = require('../util/fs-safe.cjs');
const { loadYamlFile } = require('../config/yaml-lite.cjs');
const { PROJECT_ROOT } = require('../config/floki-config.cjs');
const DEFAULT_STATE_FILE = statePath('chat/sleep/manual-nap-state.json');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'config', 'chat.config.yaml');
function now(options = {}) { return options.now ? new Date(options.now) : new Date(); }
function napConfig() {
  const sleep = loadYamlFile(CONFIG_FILE).sleep || {};
  const duration = Number(sleep.manual_nap_duration_minutes);
  const remOffset = Number(sleep.manual_nap_rem_offset_minutes);
  if (duration !== 30) throw new Error('sleep.manual_nap_duration_minutes must remain exactly 30');
  if (!(remOffset > 0 && remOffset < duration)) throw new Error('manual nap REM offset must be inside the nap');
  return Object.freeze({ duration_minutes: duration, rem_offset_minutes: remOffset });
}
function file(options = {}) { return options.state_file || DEFAULT_STATE_FILE; }
function raw(options = {}) { return existsSync(file(options)) ? readJsonFileSync(file(options)) : null; }
function save(state, options = {}) { writeJsonFileAtomicSync(file(options), state); return state; }
function readManualNapState(options = {}) {
  const state = raw(options);
  if (!state || state.active !== true || now(options) < new Date(state.wake_at)) return state;
  return save(Object.freeze({ ...state, active: false, completed: true, completed_at: now(options).toISOString(), wake_reason: 'duration_elapsed', last_transition_at: now(options).toISOString() }), options);
}
function beginManualNap(options = {}) {
  const cfg = napConfig();
  const at = now(options);
  const current = readManualNapState({ ...options, now: at });
  if (current && current.active === true) return current;
  return save(Object.freeze({
    kind: 'manual_nap', active: true, completed: false, duration_minutes: cfg.duration_minutes,
    started_at: at.toISOString(), wake_at: new Date(at.getTime() + cfg.duration_minutes * 60000).toISOString(), last_transition_at: at.toISOString(), wake_reason: null,
    consolidation: options.consolidation || null,
    rem_cycles: [Object.freeze({ cycle_number: 1, scheduled_at: new Date(at.getTime() + cfg.rem_offset_minutes * 60000).toISOString(), status: 'pending', dreaming_started_at: null, dreaming_process_pid: null, completed_at: null, dream_txt_file: null, dream_metadata_file: null, last_error: null })],
    nightly_schedule_modified: false, chat_mode_only: true, game_mode_started: false
  }), options);
}
function wakeManualNap(reason = 'manual_wake', options = {}) {
  const state = raw(options);
  if (!state || state.active !== true) return state || Object.freeze({ active: false, completed: true, wake_reason: 'not_active', nightly_schedule_modified: false });
  return save(Object.freeze({ ...state, active: false, completed: true, completed_at: now(options).toISOString(), wake_reason: reason, last_transition_at: now(options).toISOString() }), options);
}
function claimDueRemCycle(options = {}) {
  const state = readManualNapState(options);
  if (!state || state.active !== true) return null;
  const index = state.rem_cycles.findIndex((cycle) => cycle.status === 'pending' && new Date(cycle.scheduled_at) <= now(options));
  if (index < 0) return null;
  const cycle = Object.freeze({ ...state.rem_cycles[index], status: 'dreaming', dreaming_started_at: now(options).toISOString(), dreaming_process_pid: process.pid });
  const next = Object.freeze({ ...state, rem_cycles: state.rem_cycles.map((item, i) => i === index ? cycle : item), last_transition_at: now(options).toISOString() });
  save(next, options);
  return Object.freeze({ state: next, cycle });
}
function finishRemCycle(result, error, options = {}) {
  const state = raw(options);
  if (!state) return null;
  return save(Object.freeze({ ...state, rem_cycles: state.rem_cycles.map((cycle) => cycle.status !== 'dreaming' ? cycle : Object.freeze({ ...cycle, status: error ? 'failed' : 'complete', dreaming_process_pid: null, completed_at: now(options).toISOString(), dream_txt_file: result && result.dream_txt_file || null, dream_metadata_file: result && result.dream_metadata_file || null, last_error: error ? error.message : null })), last_transition_at: now(options).toISOString(), last_rem_error: error ? error.message : null }), options);
}
module.exports = { DEFAULT_STATE_FILE, napConfig, readManualNapState, beginManualNap, wakeManualNap, claimDueRemCycle, finishRemCycle };
