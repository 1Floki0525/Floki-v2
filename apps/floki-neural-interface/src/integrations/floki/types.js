// Connection states
export const ConnectionState = {
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
};

// Floki conversational states
export const FlokiState = {
  IDLE: 'Idle',
  LISTENING: 'Listening',
  HEARING_SPEECH: 'Hearing Speech',
  TRANSCRIBING: 'Transcribing',
  THINKING: 'Thinking',
  REMEMBERING: 'Remembering',
  LOOKING: 'Looking',
  RESPONDING: 'Responding',
  SPEAKING: 'Speaking',
  SLEEPING: 'Sleeping',
  ERROR: 'Error',
};

// Sleep states
export const SleepState = {
  AWAKE: 'Awake',
  ALERT: 'Alert',
  RELAXED: 'Relaxed',
  TIRED: 'Tired',
  ENTERING_SLEEP: 'Entering Sleep',
  ASLEEP: 'Asleep',
  REM_CYCLE_1: 'REM Cycle 1',
  REM_CYCLE_2: 'REM Cycle 2',
  DREAMING: 'Dreaming',
  WAKING: 'Waking',
};

// Vision observation freshness
export const ObservationFreshness = {
  LIVE: 'Live',
  FRESH: 'Fresh',
  AGING: 'Aging',
  STALE: 'Stale',
  OFFLINE: 'Offline',
};

// Service status
export const ServiceStatus = {
  RUNNING: 'Running',
  STOPPED: 'Stopped',
  DEGRADED: 'Degraded',
};

// Neural event modules
export const NeuralModule = {
  HEARING: 'Hearing',
  VISION: 'Vision',
  THALAMUS: 'Thalamus',
  TEMPORAL: 'Temporal',
  AMYGDALA: 'Amygdala',
  EMOTIONS: 'Emotions',
  HIPPOCAMPUS: 'Hippocampus',
  MEMORY: 'Memory',
  PERSONALITY: 'Personality',
  PINEAL: 'Pineal',
  FRONTAL: 'Frontal',
  BROCA: 'Broca',
  SLEEP: 'Sleep',
  REM: 'REM',
  DREAM: 'Dream',
  SYSTEM: 'System',
};

// Neural event severity
export const EventSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  DEBUG: 'debug',
};

// Privacy levels
export const PrivacyLevel = {
  PUBLIC: 'Public',
  SAFE_SUMMARY: 'Safe Summary',
  PRIVATE_METADATA: 'Private Metadata',
  REDACTED: 'Redacted',
};

// Latency health states
export const LatencyHealth = {
  HEALTHY: 'Healthy',
  SLOW: 'Slow',
  CRITICAL: 'Critical',
};

// Message types
export const MessageType = {
  TYPED: 'typed',
  SPOKEN: 'spoken',
};

/**
 * Factory functions for creating properly shaped data objects.
 * Use these when parsing or constructing local interface data.
 */
export function createChatMessage({
  id = crypto.randomUUID(),
  role = 'user',
  content = '',
  type = MessageType.TYPED,
  timestamp = Date.now(),
  isStreaming = false,
  latency = null,
} = {}) {
  return { id, role, content, type, timestamp, isStreaming, latency };
}

export function createLatencyTrace({
  transcriptionTime = 0,
  memoryContextTime = 0,
  visionContextTime = 0,
  cognitionTime = 0,
  timeToFirstToken = 0,
  totalGenerationTime = 0,
  textToSpeechTime = 0,
  totalResponseTime = 0,
} = {}) {
  return {
    transcriptionTime,
    memoryContextTime,
    visionContextTime,
    cognitionTime,
    timeToFirstToken,
    totalGenerationTime,
    textToSpeechTime,
    totalResponseTime,
  };
}

export function createVisionFrame({
  objects = [],
  faces = [],
  scene = { label: '', confidence: 0 },
  timestamp = Date.now(),
  frameRate = 30,
  connectionStatus = 'active',
} = {}) {
  return { objects, faces, scene, timestamp, frameRate, connectionStatus };
}

export function createNeuralEvent({
  id = crypto.randomUUID(),
  timestamp = Date.now(),
  module = NeuralModule.SYSTEM,
  eventType = 'info',
  summary = '',
  severity = EventSeverity.INFO,
  traceId = crypto.randomUUID().slice(0, 8),
  duration = 0,
  privacyLevel = PrivacyLevel.PUBLIC,
} = {}) {
  return { id, timestamp, module, eventType, summary, severity, traceId, duration, privacyLevel };
}

export function createServiceStatus({
  name = '',
  status = ServiceStatus.RUNNING,
  lastHeartbeat = Date.now(),
  uptime = 0,
  latency = 0,
  lastError = null,
} = {}) {
  return { name, status, lastHeartbeat, uptime, latency, lastError };
}

export function createEmotionState({
  valence = 0.6,
  arousal = 0.4,
  trust = 0.7,
  curiosity = 0.5,
  hope = 0.5,
  fear = 0.1,
  frustration = 0.1,
  attachment = 0.4,
  confidence = 0.6,
  uncertainty = 0.2,
  timestamp = Date.now(),
} = {}) {
  return { valence, arousal, trust, curiosity, hope, fear, frustration, attachment, confidence, uncertainty, timestamp };
}

export function createSleepStatus({
  state = SleepState.AWAKE,
  alertness = 0.9,
  sleepPressure = 0.1,
  remActive = false,
  currentRemCycle = 0,
  dreaming = false,
  thinking = false,
  speaking = false,
  listening = true,
  externalEyesActive = true,
  currentMode = 'Chat Mode',
  lastInteraction = Date.now(),
  sessionUptime = 0,
} = {}) {
  return {
    state, alertness, sleepPressure, remActive, currentRemCycle,
    dreaming, thinking, speaking, listening, externalEyesActive,
    currentMode, lastInteraction, sessionUptime,
  };
}

export function createDreamFragment({
  id = crypto.randomUUID(),
  timestamp = Date.now(),
  remCycleIndex = 1,
  cyclePhase = 'Core REM',
  duration = 0,
  memoryTags = [],
  visualElements = [],
  emotionalTone = { valence: 0, arousal: 0 },
  narrative = '',
  intensity = 0.5,
  isLucid = false,
  status = 'archived',
} = {}) {
  return {
    id, timestamp, remCycleIndex, cyclePhase, duration,
    memoryTags, visualElements, emotionalTone, narrative,
    intensity, isLucid, status,
  };
}

export function createRemCycle({
  id = crypto.randomUUID(),
  cycleNumber = 1,
  startTime = Date.now(),
  endTime = Date.now(),
  duration = 0,
  fragmentCount = 0,
  intensity = 0.5,
  lucidMoments = 0,
  dominantEmotion = 'neutral',
  sleepPressureAtStart = 0,
  alertnessAtEnd = 0,
} = {}) {
  return {
    id, cycleNumber, startTime, endTime, duration,
    fragmentCount, intensity, lucidMoments,
    dominantEmotion, sleepPressureAtStart, alertnessAtEnd,
  };
}