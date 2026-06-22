'use strict';

/**
 * runtime-event-bus.cjs
 *
 * Simple in-process EventEmitter for the chat.local runtime.
 * All runtime subsystems publish and subscribe through this single bus.
 * No network, no IPC — just an in-process EventEmitter.
 */

const { EventEmitter } = require('node:events');

/** Well-known event names. */
const RUNTIME_EVENTS = Object.freeze({
  TURN_START:       'turn:start',
  TURN_COMPLETE:    'turn:complete',
  TURN_ERROR:       'turn:error',

  SPEECH_START:     'speech:start',
  SPEECH_COMPLETE:  'speech:complete',
  SPEECH_ERROR:     'speech:error',

  HEARING_START:    'hearing:start',
  HEARING_COMPLETE: 'hearing:complete',
  HEARING_ERROR:    'hearing:error',

  VISION_UPDATE:    'vision:update',
  VISION_STALE:     'vision:stale',
  VISION_REFRESH:   'vision:refresh',
  VISION_ERROR:     'vision:error',

  SLEEP_ENTER:      'sleep:enter',
  SLEEP_EXIT:       'sleep:exit',
  SLEEP_REM_START:  'sleep:rem:start',
  SLEEP_REM_END:    'sleep:rem:end',

  SERVICE_START:    'service:start',
  SERVICE_STOP:     'service:stop',
  SERVICE_HEARTBEAT:'service:heartbeat',
  SERVICE_ERROR:    'service:error',

  SENSORY_EVENT:    'sensory:event',

  RUNTIME_START:    'runtime:start',
  RUNTIME_STOP:     'runtime:stop',
  RUNTIME_ERROR:    'runtime:error',
});

/**
 * Create a runtime event bus.
 *
 * The bus is a thin wrapper around EventEmitter with typed helpers
 * and a frozen event-name dictionary.
 */
function createRuntimeEventBus(options = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(Number(options.max_listeners || 64));

  let emittedCount = 0;

  function emit(eventName, payload = {}) {
    emittedCount += 1;
    const envelope = Object.freeze({
      event: eventName,
      timestamp: Date.now(),
      payload: Object.freeze({ ...payload }),
    });
    emitter.emit(eventName, envelope);
    return envelope;
  }

  function on(eventName, listener) {
    emitter.on(eventName, listener);
  }

  function once(eventName, listener) {
    emitter.once(eventName, listener);
  }

  function off(eventName, listener) {
    emitter.off(eventName, listener);
  }

  function removeAllListeners(eventName) {
    if (eventName) {
      emitter.removeAllListeners(eventName);
    } else {
      emitter.removeAllListeners();
    }
  }

  function listenerCount(eventName) {
    return emitter.listenerCount(eventName);
  }

  function stats() {
    return Object.freeze({
      emitted_count: emittedCount,
      listener_count: emitter.eventNames().reduce(
        (sum, name) => sum + emitter.listenerCount(name),
        0
      ),
      event_names: emitter.eventNames().slice(),
    });
  }

  return Object.freeze({
    emit,
    on,
    once,
    off,
    removeAllListeners,
    listenerCount,
    stats,
    EVENTS: RUNTIME_EVENTS,
  });
}

module.exports = {
  RUNTIME_EVENTS,
  createRuntimeEventBus,
};
