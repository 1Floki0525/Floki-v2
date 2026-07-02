const EMPTY_COUNTS = Object.freeze({
  stale: 0,
  outOfOrder: 0,
  duplicate: 0,
  session: 0,
});

function roundRect(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function emptyOverlayState() {
  return Object.freeze({
    streamSessionId: null,
    frameSequence: null,
    resultSequence: null,
    objects: Object.freeze([]),
    persons: Object.freeze([]),
    faces: Object.freeze([]),
    frame: Object.freeze({ width: 0, height: 0 }),
    dropCounts: EMPTY_COUNTS,
  });
}

function increment(counts, key) {
  return Object.freeze({
    stale: Number(counts?.stale || 0) + (key === 'stale' ? 1 : 0),
    outOfOrder: Number(counts?.outOfOrder || 0) + (key === 'outOfOrder' ? 1 : 0),
    duplicate: Number(counts?.duplicate || 0) + (key === 'duplicate' ? 1 : 0),
    session: Number(counts?.session || 0) + (key === 'session' ? 1 : 0),
  });
}

function cleared(previous, key = null) {
  const state = previous || emptyOverlayState();
  return Object.freeze({
    ...state,
    objects: Object.freeze([]),
    persons: Object.freeze([]),
    faces: Object.freeze([]),
    dropCounts: key ? increment(state.dropCounts, key) : state.dropCounts,
  });
}

function overlaySequence(vision) {
  const raw = vision?.detection?.resultSequence ?? vision?.detection?.frameSequence ?? vision?.result_sequence ?? vision?.frame_sequence;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

export function reduceOverlayFrameState(previousState, vision, options = {}) {
  const previous = previousState || emptyOverlayState();
  if (options.blackout === true) return cleared(previous);
  const live = vision?.connectionStatus === 'active' && vision?.frame?.fresh === true;
  if (!live) return cleared(previous);

  const ageMs = Number(vision?.detection?.ageMs ?? vision?.detection?.age_ms ?? 0);
  const maxAgeMs = Math.max(1, Number(options.maxAgeMs || 5000));
  if (vision?.detection?.stale === true || vision?.detection?.fresh !== true || ageMs > maxAgeMs) {
    return cleared(previous, 'stale');
  }

  const nextSession = String(vision?.streamSessionId || vision?.stream_session_id || vision?.detection?.streamSessionId || vision?.detection?.stream_session_id || '');
  const previousSession = previous.streamSessionId ? String(previous.streamSessionId) : '';
  const sequence = overlaySequence(vision);
  if (nextSession && previousSession && nextSession !== previousSession) {
    return reduceOverlayFrameState(emptyOverlayState(), vision, options);
  }
  if (sequence !== null && previous.resultSequence !== null && sequence < Number(previous.resultSequence)) {
    return Object.freeze({ ...previous, dropCounts: increment(previous.dropCounts, 'outOfOrder') });
  }
  if (sequence !== null && previous.resultSequence !== null && sequence === Number(previous.resultSequence)) {
    return Object.freeze({ ...previous, dropCounts: increment(previous.dropCounts, 'duplicate') });
  }

  return Object.freeze({
    streamSessionId: nextSession || previous.streamSessionId || null,
    frameSequence: finite(vision?.detection?.frameSequence ?? vision?.detection?.frame_sequence, sequence),
    resultSequence: sequence,
    objects: Object.freeze(Array.isArray(vision?.objects) ? vision.objects : []),
    persons: Object.freeze(Array.isArray(vision?.persons) ? vision.persons : []),
    faces: Object.freeze(Array.isArray(vision?.faces) ? vision.faces : []),
    frame: Object.freeze({
      width: finite(vision?.frame?.width ?? vision?.image_width ?? vision?.sourceWidth, 0),
      height: finite(vision?.frame?.height ?? vision?.image_height ?? vision?.sourceHeight, 0),
    }),
    dropCounts: previous.dropCounts || EMPTY_COUNTS,
  });
}

function contentRect({ sourceWidth, sourceHeight, displayWidth, displayHeight, objectFit }) {
  const srcW = Math.max(1, finite(sourceWidth, 1));
  const srcH = Math.max(1, finite(sourceHeight, 1));
  const dstW = Math.max(1, finite(displayWidth, 1));
  const dstH = Math.max(1, finite(displayHeight, 1));
  const scale = objectFit === 'cover'
    ? Math.max(dstW / srcW, dstH / srcH)
    : Math.min(dstW / srcW, dstH / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return {
    left: (dstW - width) / 2,
    top: (dstH - height) / 2,
    width,
    height,
  };
}

export function mapNormalizedBoxToVideoRect(box, options = {}) {
  const source = contentRect(options);
  const x = finite(box?.x, NaN);
  const y = finite(box?.y, NaN);
  const width = finite(box?.width, NaN);
  const height = finite(box?.height, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const normalizedX = options.mirrored === true ? 1 - x - width : x;
  return {
    left: roundRect(source.left + normalizedX * source.width),
    top: roundRect(source.top + y * source.height),
    width: roundRect(width * source.width),
    height: roundRect(height * source.height),
  };
}

export function clampRectToDisplay(rect, displayWidth, displayHeight) {
  if (!rect) return null;
  const right = Math.min(finite(displayWidth, 0), rect.left + rect.width);
  const bottom = Math.min(finite(displayHeight, 0), rect.top + rect.height);
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  if (width <= 0 || height <= 0) return null;
  return {
    left: roundRect(left),
    top: roundRect(top),
    width: roundRect(width),
    height: roundRect(height),
  };
}
