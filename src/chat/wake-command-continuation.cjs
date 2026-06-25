'use strict';

const { getWakeGateConfig } = require('../config/floki-config.cjs');
const { classifyWakeInput, shouldRouteToCognition } = require('./wake-word-gate.cjs');

function createWakeCommandContinuation(options = {}) {
  const wakeConfig = options.wake_gate_config || getWakeGateConfig('chat');
  const continuationMs = Number(options.continuation_ms);
  if (!Number.isFinite(continuationMs) || continuationMs <= 0) {
    throw new Error('audio.wake_command_continuation_ms must be a positive YAML number');
  }

  const classify = options.classify || ((text, speaking) => classifyWakeInput({
    text: String(text || ''),
    modality: 'spoken',
    source: 'user',
    voice_speaking: speaking === true
  }));

  let pending = null;
  let partialWakeUntilMs = 0;

  function nowValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : Date.now();
  }

  function expire(nowMs) {
    const now = nowValue(nowMs);
    if (pending && pending.expires_at_ms <= now) pending = null;
    if (partialWakeUntilMs <= now) partialWakeUntilMs = 0;
  }

  function clear() {
    pending = null;
    partialWakeUntilMs = 0;
  }

  function status(nowMs = Date.now()) {
    expire(nowMs);
    return Object.freeze({
      pending: Boolean(pending),
      pending_phrase: pending ? pending.phrase : '',
      pending_since_at: pending ? pending.since_at : null,
      pending_expires_at: pending ? pending.expires_at : null,
      partial_wake_detected: partialWakeUntilMs > nowValue(nowMs),
      continuation_ms: continuationMs
    });
  }

  function observePartial(input = {}) {
    const now = nowValue(input.now_ms);
    expire(now);
    if (input.speech_active !== true || input.speaking === true) return status(now);
    const classification = classify(String(input.text || ''), false);
    if (classification && classification.gate_open === true) {
      partialWakeUntilMs = now + continuationMs;
    }
    return status(now);
  }

  function armPending(phrase, nowMs, metadata = {}) {
    const now = nowValue(nowMs);
    const expires = now + continuationMs;
    pending = Object.freeze({
      phrase: String(phrase || wakeConfig.required_phrase).trim() || wakeConfig.required_phrase,
      since_at: new Date(now).toISOString(),
      expires_at: new Date(expires).toISOString(),
      expires_at_ms: expires,
      utterance_id: metadata.utterance_id || null
    });
    partialWakeUntilMs = expires;
  }

  function routeDecision(rawText, classification, source) {
    clear();
    return Object.freeze({
      action: 'route',
      raw_text: rawText,
      request_text: classification.request_text,
      classification,
      source
    });
  }

  function processFinalTranscript(input = {}) {
    const now = nowValue(input.now_ms);
    expire(now);
    const heard = String(input.text || '').trim();
    if (!heard) return Object.freeze({ action: 'ignore_empty', raw_text: '', classification: null });

    const direct = classify(heard, input.speaking === true);
    if (shouldRouteToCognition(direct) && direct.attention_only !== true) {
      return routeDecision(heard, direct, 'complete_wake_command');
    }

    if (shouldRouteToCognition(direct) && direct.attention_only === true) {
      armPending(heard, now, input);
      return Object.freeze({
        action: 'wait_for_command',
        raw_text: heard,
        request_text: '',
        classification: direct,
        pending: status(now)
      });
    }

    const pendingAtStart = pending;
    const partialWakeDetected = input.wake_detected_during_utterance === true || partialWakeUntilMs > now;
    const prefix = pendingAtStart ? pendingAtStart.phrase : partialWakeDetected ? wakeConfig.required_phrase : '';
    if (prefix) {
      const combined = prefix.replace(/[\s,;:.!?-]+$/g, '') + ', ' + heard;
      const combinedClassification = classify(combined, input.speaking === true);
      if (shouldRouteToCognition(combinedClassification) && combinedClassification.attention_only !== true) {
        return routeDecision(combined, combinedClassification, pendingAtStart ? 'continued_wake_command' : 'partial_wake_recovered');
      }
    }

    return Object.freeze({
      action: 'background',
      raw_text: heard,
      request_text: '',
      classification: direct,
      pending: status(now)
    });
  }

  return Object.freeze({ clear, status, observePartial, processFinalTranscript });
}

module.exports = { createWakeCommandContinuation };
