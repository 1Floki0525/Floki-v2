'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildDreamStatus } = require('./dream-status.cjs');
const { buildFlokiLifecycleStatus } = require('./floki-lifecycle-status.cjs');
const { readManualNapState } = require('./manual-nap.cjs');
const { loadSleepCycleState, buildRemSchedule } = require('./sleep-cycle.cjs');

function currentDate(options = {}) {
  return options.now ? new Date(options.now) : new Date();
}

function timestamp(value, fallback = Date.now()) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeReadJson(filePath, fallback = {}) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function safeReadText(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (_error) {
    return '';
  }
}

function safeReadJsonl(filePath, limit = 5000) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Number(limit) || 5000))
      .map((line) => {
        try { return JSON.parse(line); } catch (_error) { return null; }
      })
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function cleanText(value, limit = 20000) {
  return String(value || '').trim().slice(0, limit);
}

function nestedDream(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  if (metadata.dream_json && typeof metadata.dream_json === 'object') return metadata.dream_json;
  if (metadata.model_dream_json && typeof metadata.model_dream_json === 'object') return metadata.model_dream_json;
  return metadata;
}

function textSection(fullText, heading, nextHeadings) {
  const text = String(fullText || '');
  const startNeedle = heading + ':';
  const start = text.indexOf(startNeedle);
  if (start < 0) return '';
  const bodyStart = start + startNeedle.length;
  let end = text.length;
  for (const next of nextHeadings) {
    const index = text.indexOf('\n' + next + ':', bodyStart);
    if (index >= 0 && index < end) end = index;
  }
  return text.slice(bodyStart, end).trim();
}

function emotionValues(value) {
  if (value && typeof value === 'object') {
    const valence = Number(value.valence);
    const arousal = Number(value.arousal);
    return {
      label: cleanText(value.label || value.name || 'mixed', 160),
      valence: Number.isFinite(valence) ? Math.max(0, Math.min(1, valence)) : 0.5,
      arousal: Number.isFinite(arousal) ? Math.max(0, Math.min(1, arousal)) : 0.5
    };
  }
  const label = cleanText(value || 'mixed', 160);
  const lower = label.toLowerCase();
  return {
    label,
    valence: /hope|love|warm|peace|joy|calm/.test(lower) ? 0.75 : /fear|grief|anger|sad|anx/.test(lower) ? 0.25 : 0.5,
    arousal: /vivid|fear|anger|intense|excited|anx/.test(lower) ? 0.75 : /peace|calm|quiet/.test(lower) ? 0.25 : 0.5
  };
}

function normalizeDreamRecord(record, index, options = {}) {
  const fallbackNow = currentDate(options).getTime();
  const metadataFile = record && record.dream_metadata_file || null;
  const textFile = record && record.dream_txt_file || null;
  const metadata = safeReadJson(metadataFile, {});
  const dream = nestedDream(metadata);
  const fullText = safeReadText(textFile || metadata.dream_txt_file);
  const createdAt = record && record.created_at || metadata.created_at || dream.created_at || new Date(fallbackNow).toISOString();
  const title = cleanText(record && record.title || metadata.title || dream.title || 'Untitled dream', 240);
  const story = cleanText(
    dream.dream_story ||
    metadata.dream_story ||
    textSection(fullText, 'Dream story', ['Memory consolidation', 'Remembered as', 'First-person reflection', 'Symbols']) ||
    fullText,
    30000
  );
  const consolidationSummary = cleanText(
    dream.consolidation_summary || metadata.consolidation_summary ||
    textSection(fullText, 'Memory consolidation', ['Remembered as', 'First-person reflection', 'Symbols']),
    5000
  );
  const rememberedAs = cleanText(
    dream.remembered_as || metadata.remembered_as ||
    textSection(fullText, 'Remembered as', ['First-person reflection', 'Symbols']),
    5000
  );
  const reflection = cleanText(
    dream.first_person_reflection || metadata.first_person_reflection ||
    textSection(fullText, 'First-person reflection', ['Symbols']),
    5000
  );
  const symbols = Array.isArray(dream.symbols)
    ? dream.symbols
    : Array.isArray(metadata.symbols)
      ? metadata.symbols
      : Array.isArray(record && record.symbols)
        ? record.symbols
        : [];
  const emotionalTone = emotionValues(
    dream.emotional_tone || metadata.emotional_tone || record && record.emotional_tone
  );
  const remCycleNumber = Number(
    record && record.rem_cycle_number ||
    metadata.rem_cycle_number ||
    dream.rem_cycle_number ||
    1
  ) || 1;
  const sleepWindowStart = metadata.sleep_window_start || dream.sleep_window_start || null;
  const sleepWindowEnd = metadata.sleep_window_end || dream.sleep_window_end || null;
  const memorySources = Array.isArray(metadata.memory_sources)
    ? metadata.memory_sources
    : Array.isArray(dream.memory_sources)
      ? dream.memory_sources
      : [];
  const knowledgeSources = Array.isArray(metadata.knowledge_sources)
    ? metadata.knowledge_sources
    : Array.isArray(dream.knowledge_sources)
      ? dream.knowledge_sources
      : [];
  const id = cleanText(record && (record.dream_id || record.id) || metadataFile || textFile || `dream-${index}`, 1000);
  return Object.freeze({
    id,
    title,
    theme: title,
    createdAt,
    timestamp: timestamp(createdAt, fallbackNow),
    remCycleNumber,
    remCycleIndex: remCycleNumber,
    sleepKind: record && record.sleep_kind || metadata.sleep_kind || dream.sleep_kind || null,
    sleepWindowStart,
    sleepWindowEnd,
    story,
    transcript: story,
    fullText,
    consolidationSummary,
    rememberedAs,
    reflection,
    symbols: symbols.map((value) => cleanText(value, 240)).filter(Boolean).slice(0, 24),
    emotionalTone,
    memorySourceCount: memorySources.length,
    knowledgeSourceCount: knowledgeSources.length,
    dreamTextFile: textFile || metadata.dream_txt_file || null,
    dreamMetadataFile: metadataFile || null,
    status: 'complete',
    isLucid: dream.is_lucid === true || metadata.is_lucid === true,
    duration: 0,
    memoryTags: [],
    visualElements: symbols.map(String),
    narrative: story,
    intensity: emotionalTone.arousal,
    cyclePhase: 'REM'
  });
}

function latestSessionDreams(dreams) {
  if (!dreams.length) return [];
  const newest = dreams[0];
  const sessionKey = newest.sleepWindowStart || newest.createdAt.slice(0, 10);
  return dreams.filter((dream) => (
    (dream.sleepWindowStart || dream.createdAt.slice(0, 10)) === sessionKey
  ));
}

function archiveCycles(dreams) {
  const sorted = dreams.slice().sort((left, right) => left.timestamp - right.timestamp);
  const groups = new Map();
  for (const dream of sorted) {
    const cycle = Number(dream.remCycleNumber || 1);
    if (!groups.has(cycle)) groups.set(cycle, []);
    groups.get(cycle).push(dream);
  }
  return Array.from(groups.entries()).map(([cycleNumber, entries]) => {
    const startTime = Math.min(...entries.map((entry) => entry.timestamp));
    const endTime = Math.max(startTime + 60000, ...entries.map((entry) => entry.timestamp + 60000));
    return Object.freeze({
      id: `archive-rem-${cycleNumber}-${startTime}`,
      cycleNumber,
      startTime,
      endTime,
      duration: endTime - startTime,
      dreamCount: entries.length,
      fragmentCount: entries.length,
      intensity: entries.reduce((sum, entry) => sum + entry.intensity, 0) / entries.length,
      lucidMoments: entries.filter((entry) => entry.isLucid).length,
      dominantEmotion: entries[entries.length - 1].emotionalTone.label,
      status: 'complete'
    });
  });
}

function manualNapSession(nap, lifecycle, dreams, now) {
  const startedAt = timestamp(nap.started_at, now);
  const wakeAt = timestamp(nap.wake_at, startedAt + 30 * 60000);
  const sessionDreams = dreams.filter((dream) => dream.timestamp >= startedAt - 1000 && dream.timestamp <= wakeAt + 5 * 60000);
  const rawCycles = Array.isArray(nap.rem_cycles) ? nap.rem_cycles : [];
  const cycles = rawCycles.map((cycle, index) => {
    const scheduledAt = timestamp(cycle.scheduled_at, startedAt);
    const startTime = timestamp(cycle.dreaming_started_at, scheduledAt);
    const endTime = cycle.status === 'complete' || cycle.status === 'failed'
      ? timestamp(cycle.completed_at, Math.max(startTime + 60000, now))
      : cycle.status === 'dreaming'
        ? Math.max(startTime + 60000, now)
        : wakeAt;
    const cycleNumber = Number(cycle.cycle_number || index + 1);
    return Object.freeze({
      id: `manual-nap-rem-${cycleNumber}`,
      cycleNumber,
      startTime,
      endTime: Math.max(startTime + 60000, endTime),
      duration: Math.max(60000, endTime - startTime),
      dreamCount: sessionDreams.filter((dream) => dream.remCycleNumber === cycleNumber).length,
      fragmentCount: sessionDreams.filter((dream) => dream.remCycleNumber === cycleNumber).length,
      intensity: cycle.status === 'dreaming' ? 0.75 : 0.4,
      lucidMoments: 0,
      dominantEmotion: cycle.status === 'dreaming' ? 'forming' : cycle.status,
      status: cycle.status || 'pending',
      scheduledAt: cycle.scheduled_at || null,
      error: cycle.last_error || null
    });
  });
  const dreamingCycle = rawCycles.find((cycle) => cycle.status === 'dreaming');
  const pendingCycle = rawCycles.find((cycle) => cycle.status === 'pending');
  const failedCycle = rawCycles.find((cycle) => cycle.status === 'failed');
  const completeCycle = rawCycles.find((cycle) => cycle.status === 'complete');
  const state = failedCycle ? 'failed' : dreamingCycle ? 'dreaming' : completeCycle ? 'complete' : 'pre_rem';
  const latest = sessionDreams[0] || null;
  const theme = state === 'dreaming' ? 'Forming…' : state === 'pre_rem' ? 'Awaiting REM' : state === 'failed' ? 'Dream failed' : latest && latest.title || 'Dream complete';
  const elapsedEnd = nap.active === true ? Math.min(now, wakeAt) : timestamp(nap.completed_at, Math.min(now, wakeAt));
  return Object.freeze({
    sessionDate: new Date(startedAt).toISOString(),
    totalSleepDuration: Math.max(0, elapsedEnd - startedAt),
    cycles,
    activeSession: Object.freeze({
      active: nap.active === true,
      kind: 'manual_nap',
      status: state,
      isAsleep: nap.active === true,
      isDreaming: state === 'dreaming',
      startedAt: nap.started_at || null,
      wakeAt: nap.wake_at || null,
      elapsedMs: Math.max(0, elapsedEnd - startedAt),
      remainingMs: Math.max(0, wakeAt - now),
      durationMs: Math.max(0, wakeAt - startedAt),
      currentRemCycle: dreamingCycle && Number(dreamingCycle.cycle_number || 1) || null,
      nextRemCycleNumber: pendingCycle && Number(pendingCycle.cycle_number || 1) || null,
      nextRemCycleAt: pendingCycle && pendingCycle.scheduled_at || null,
      nextRemCountdownMs: pendingCycle
        ? Math.max(0, timestamp(pendingCycle.scheduled_at, now) - now)
        : null,
      remIntervalMinutes: Number(nap.rem_interval_minutes || 10),
      completedRemCycles: rawCycles.filter((cycle) => cycle.status === 'complete').length,
      totalRemCycles: rawCycles.length,
      runtimeSessionId: nap.runtime_session_id || null,
      theme,
      title: latest && latest.title || null,
      lastError: nap.last_rem_error || failedCycle && failedCycle.last_error || null,
      lifecycleState: lifecycle.state || null
    }),
    sessionDreams
  });
}

function nightlySession(lifecycle, sleepState, dreams, now) {
  const startedAt = timestamp(lifecycle.sleep_window_start, now);
  const wakeAt = timestamp(lifecycle.sleep_window_end, now + 8 * 60 * 60000);
  const sessionDreams = dreams.filter((dream) => (
    dream.timestamp >= startedAt - 1000 &&
    dream.timestamp <= wakeAt + 5 * 60000
  ));
  const isDreaming = lifecycle.is_dreaming === true || lifecycle.is_rem_dreaming === true;
  const stateMatchesWindow = Boolean(
    sleepState &&
    sleepState.sleep_window_start === lifecycle.sleep_window_start &&
    sleepState.sleep_window_end === lifecycle.sleep_window_end
  );
  const rawCycles = stateMatchesWindow && Array.isArray(sleepState.rem_cycles)
    ? sleepState.rem_cycles
    : buildRemSchedule({
        start_at: lifecycle.sleep_window_start,
        end_at: lifecycle.sleep_window_end
      });

  const cycles = rawCycles.map((cycle, index) => {
    const cycleNumber = Number(cycle.cycle_number || index + 1);
    const scheduledAt = timestamp(cycle.scheduled_at, startedAt);
    const cycleDreams = sessionDreams.filter(
      (dream) => Number(dream.remCycleNumber) === cycleNumber
    );
    const startTime = timestamp(cycle.dreaming_started_at, scheduledAt);
    const endTime = cycle.status === 'complete' || cycle.status === 'failed'
      ? timestamp(cycle.completed_at, Math.max(startTime + 60000, now))
      : cycle.status === 'dreaming'
        ? Math.max(startTime + 60000, now)
        : Math.min(wakeAt, scheduledAt + 10 * 60000);

    return Object.freeze({
      id: `nightly-rem-${cycleNumber}`,
      cycleNumber,
      startTime,
      endTime: Math.max(startTime + 60000, endTime),
      duration: Math.max(60000, endTime - startTime),
      dreamCount: cycleDreams.length,
      fragmentCount: cycleDreams.length,
      intensity: cycle.status === 'dreaming'
        ? 0.75
        : cycleDreams.length
          ? cycleDreams.reduce((sum, dream) => sum + dream.intensity, 0) / cycleDreams.length
          : 0.4,
      lucidMoments: cycleDreams.filter((dream) => dream.isLucid).length,
      dominantEmotion: cycle.status === 'dreaming'
        ? 'forming'
        : cycleDreams.length
          ? cycleDreams[cycleDreams.length - 1].emotionalTone.label
          : cycle.status || 'pending',
      status: cycle.status || 'pending',
      scheduledAt: cycle.scheduled_at || null,
      error: cycle.last_attempt_error || cycle.last_error || null
    });
  });

  const dreamingCycle = rawCycles.find((cycle) => cycle.status === 'dreaming');
  const pendingCycles = rawCycles
    .filter((cycle) => cycle.status === 'pending')
    .sort((left, right) => timestamp(left.scheduled_at) - timestamp(right.scheduled_at));
  const pendingCycle = pendingCycles.find(
    (cycle) => timestamp(cycle.scheduled_at) >= now
  ) || pendingCycles[0] || null;
  const failedCycle = rawCycles.find((cycle) => cycle.status === 'failed');
  const latest = sessionDreams[0] || null;
  const status = failedCycle
    ? 'failed'
    : isDreaming || dreamingCycle
      ? 'dreaming'
      : 'pre_rem';
  const theme = status === 'dreaming'
    ? 'Forming…'
    : status === 'failed'
      ? 'Dream failed'
      : latest && latest.title || 'Awaiting REM';

  return Object.freeze({
    sessionDate: new Date(startedAt).toISOString(),
    totalSleepDuration: Math.max(0, Math.min(now, wakeAt) - startedAt),
    cycles,
    activeSession: Object.freeze({
      active: true,
      kind: 'nightly_sleep',
      status,
      isAsleep: true,
      isDreaming: status === 'dreaming',
      startedAt: lifecycle.sleep_window_start || null,
      wakeAt: lifecycle.sleep_window_end || null,
      elapsedMs: Math.max(0, Math.min(now, wakeAt) - startedAt),
      remainingMs: Math.max(0, wakeAt - now),
      durationMs: Math.max(0, wakeAt - startedAt),
      currentRemCycle: dreamingCycle
        ? Number(dreamingCycle.cycle_number || 1)
        : lifecycle.current_rem_cycle_number || null,
      nextRemCycleNumber: pendingCycle
        ? Number(pendingCycle.cycle_number || 1)
        : lifecycle.next_rem_cycle_number || null,
      nextRemCycleAt: pendingCycle && pendingCycle.scheduled_at ||
        lifecycle.next_rem_cycle_at || null,
      nextRemCountdownMs: pendingCycle
        ? Math.max(0, timestamp(pendingCycle.scheduled_at, now) - now)
        : lifecycle.next_rem_cycle_at
          ? Math.max(0, timestamp(lifecycle.next_rem_cycle_at, now) - now)
          : null,
      remIntervalMinutes: Number(
        stateMatchesWindow && sleepState.rem_interval_minutes || 10
      ),
      completedRemCycles: rawCycles.filter((cycle) => cycle.status === 'complete').length,
      totalRemCycles: rawCycles.length,
      runtimeSessionId: null,
      timezone: 'America/Toronto',
      theme,
      title: latest && latest.title || null,
      lastError: failedCycle && (
        failedCycle.last_attempt_error || failedCycle.last_error
      ) || lifecycle.last_architecture_error || null,
      lifecycleState: lifecycle.state || null
    }),
    sessionDreams
  });
}
function buildDreamTimeline(options = {}) {
  const nowDate = currentDate(options);
  const now = nowDate.getTime();
  const dreamStatus = options.dream_status || buildDreamStatus({
    ...options,
    now: nowDate,
    write_report: false
  });
  const lifecycle = options.lifecycle_status || buildFlokiLifecycleStatus({
    ...options,
    now: nowDate
  });
  const manualNap = Object.prototype.hasOwnProperty.call(options, 'manual_nap_state')
    ? options.manual_nap_state
    : readManualNapState({ ...options, now: nowDate });
  const sleepState = Object.prototype.hasOwnProperty.call(options, 'sleep_cycle_state')
    ? options.sleep_cycle_state
    : loadSleepCycleState(options);
  const records = Array.isArray(options.records)
    ? options.records
    : safeReadJsonl(dreamStatus.dream_index_file, options.limit || 5000);
  const dreams = records
    .map((record, index) => normalizeDreamRecord(record, index, { now: nowDate }))
    .filter((dream) => dream.story || dream.title)
    .sort((left, right) => right.timestamp - left.timestamp);

  let session;
  if (manualNap && manualNap.active === true) {
    session = manualNapSession(manualNap, lifecycle, dreams, now);
  } else if (lifecycle.is_asleep === true) {
    session = nightlySession(lifecycle, sleepState, dreams, now);
  } else {
    const sessionDreams = latestSessionDreams(dreams);
    const cycles = archiveCycles(sessionDreams);
    const start = sessionDreams.length
      ? timestamp(sessionDreams[sessionDreams.length - 1].sleepWindowStart || sessionDreams[sessionDreams.length - 1].createdAt, now)
      : now;
    const end = cycles.length ? Math.max(...cycles.map((cycle) => cycle.endTime)) : start;
    session = Object.freeze({
      sessionDate: sessionDreams.length ? new Date(start).toISOString() : null,
      totalSleepDuration: Math.max(0, end - start),
      cycles,
      sessionDreams,
      activeSession: Object.freeze({
        active: false,
        kind: null,
        status: 'idle',
        isAsleep: false,
        isDreaming: false,
        startedAt: null,
        wakeAt: null,
        elapsedMs: 0,
        remainingMs: 0,
        durationMs: 0,
        currentRemCycle: null,
        nextRemCycleNumber: lifecycle.next_rem_cycle_number || null,
        nextRemCycleAt: lifecycle.next_rem_cycle_at || null,
        nextRemCountdownMs: lifecycle.next_rem_cycle_at
          ? Math.max(0, timestamp(lifecycle.next_rem_cycle_at, now) - now)
          : null,
        remIntervalMinutes: 10,
        theme: dreams[0] && dreams[0].title || 'No indexed dreams',
        title: dreams[0] && dreams[0].title || null,
        lastError: null,
        lifecycleState: lifecycle.state || null
      })
    });
  }

  const theme = session.activeSession.theme || dreams[0] && dreams[0].title || 'No indexed dreams';
  const compatibilityFragments = dreams.map((dream) => Object.freeze({
    ...dream,
    narrative: dream.story,
    remCycleIndex: dream.remCycleNumber,
    memoryTags: [],
    visualElements: dream.symbols
  }));

  return Object.freeze({
    sessionDate: session.sessionDate,
    totalSleepDuration: session.totalSleepDuration,
    cycles: session.cycles,
    dreams,
    sessionDreams: session.sessionDreams,
    totalDreams: dreams.length,
    dominantTheme: theme,
    activeSession: session.activeSession,
    generatedAt: now,
    source: dreamStatus.dream_index_file,
    dreamRoot: dreamStatus.dream_root,
    archiveTotalDreams: dreams.length,
    archiveLatestTitle: dreams[0] && dreams[0].title || dreamStatus.latest_dream_title || null,
    liveStatus: Object.freeze({
      currentlySleeping: lifecycle.is_asleep === true,
      currentlyDreaming: lifecycle.is_dreaming === true || lifecycle.is_rem_dreaming === true,
      lifecycleState: lifecycle.state || null,
      currentRemCycle: lifecycle.current_rem_cycle_number || null,
      nextRemCycleAt: lifecycle.next_rem_cycle_at || null
    }),
    fragments: compatibilityFragments,
    totalFragments: compatibilityFragments.length,
    lucidMoments: compatibilityFragments.filter((dream) => dream.isLucid).length
  });
}

module.exports = {
  buildDreamTimeline,
  normalizeDreamRecord,
  archiveCycles
};
