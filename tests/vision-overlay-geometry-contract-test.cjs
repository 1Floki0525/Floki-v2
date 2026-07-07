'use strict';

const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function run() {
  const helper = await import(pathToFileURL(path.resolve(
    __dirname,
    '../apps/floki-neural-interface/src/lib/visionOverlayGeometry.js'
  )).href);
  const {
    reduceOverlayFrameState,
    mapNormalizedBoxToVideoRect
  } = helper;

  let state = reduceOverlayFrameState(undefined, {
    connectionStatus: 'active',
    streamSessionId: 'session-a',
    detection: { fresh: true, stale: false, frameSequence: 1, resultSequence: 1, ageMs: 100 },
    frame: { fresh: true, width: 1280, height: 720 },
    objects: [{ id: 'chair-1', bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
    persons: []
  }, { nowMs: 1000, maxAgeMs: 5000, blackout: false });
  assert.equal(state.objects.length, 1);

  state = reduceOverlayFrameState(state, {
    connectionStatus: 'active',
    streamSessionId: 'session-a',
    detection: { fresh: true, stale: false, frameSequence: 2, resultSequence: 2, ageMs: 100 },
    frame: { fresh: true, width: 1280, height: 720 },
    objects: [],
    persons: [{ id: 'person-2', bbox: { x: 0.5, y: 0.1, width: 0.2, height: 0.7 } }]
  }, { nowMs: 1100, maxAgeMs: 5000, blackout: false });
  assert.equal(state.objects.length, 0);
  assert.deepEqual(state.persons.map((entry) => entry.id), ['person-2']);

  const old = reduceOverlayFrameState(state, {
    connectionStatus: 'active',
    streamSessionId: 'session-a',
    detection: { fresh: true, stale: false, frameSequence: 1, resultSequence: 1, ageMs: 100 },
    frame: { fresh: true, width: 1280, height: 720 },
    objects: [{ id: 'old-chair', bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
    persons: []
  }, { nowMs: 1200, maxAgeMs: 5000, blackout: false });
  assert.deepEqual(old.persons.map((entry) => entry.id), ['person-2']);
  assert.equal(old.dropCounts.outOfOrder, 1);

  const duplicate = reduceOverlayFrameState(state, {
    connectionStatus: 'active',
    streamSessionId: 'session-a',
    detection: { fresh: true, stale: false, frameSequence: 2, resultSequence: 2, ageMs: 100 },
    frame: { fresh: true, width: 1280, height: 720 },
    objects: [{ id: 'dup-chair', bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
    persons: []
  }, { nowMs: 1300, maxAgeMs: 5000, blackout: false });
  assert.deepEqual(duplicate.persons.map((entry) => entry.id), ['person-2']);
  assert.equal(duplicate.dropCounts.duplicate, 1);

  const stale = reduceOverlayFrameState(state, {
    connectionStatus: 'active',
    streamSessionId: 'session-a',
    detection: { fresh: false, stale: true, frameSequence: 3, resultSequence: 3, ageMs: 6000 },
    frame: { fresh: true, width: 1280, height: 720 },
    objects: [{ id: 'stale-chair', bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
    persons: []
  }, { nowMs: 7000, maxAgeMs: 5000, blackout: false });
  assert.equal(stale.objects.length + stale.persons.length, 0);
  assert.equal(stale.dropCounts.stale, 1);

  const oldSession = reduceOverlayFrameState(state, {
    connectionStatus: 'active',
    streamSessionId: 'session-b',
    detection: { fresh: true, stale: false, frameSequence: 3, resultSequence: 3, ageMs: 100 },
    frame: { fresh: true, width: 1280, height: 720 },
    objects: [{ id: 'new-session-chair', bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
    persons: []
  }, { nowMs: 1400, maxAgeMs: 5000, blackout: false });
  assert.equal(oldSession.streamSessionId, 'session-b');
  assert.equal(oldSession.objects.length, 1);
  assert.equal(oldSession.persons.length, 0);

  const blackout = reduceOverlayFrameState(oldSession, {
    connectionStatus: 'active',
    streamSessionId: 'session-b',
    detection: { fresh: true, stale: false, frameSequence: 4, resultSequence: 4, ageMs: 100 },
    frame: { fresh: true, width: 1280, height: 720 },
    objects: [{ id: 'hidden-chair', bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
    persons: []
  }, { nowMs: 1500, maxAgeMs: 5000, blackout: true });
  assert.equal(blackout.objects.length + blackout.persons.length, 0);

  const stopped = reduceOverlayFrameState(oldSession, {
    connectionStatus: 'offline',
    streamSessionId: 'session-b',
    detection: { fresh: false, stale: true, frameSequence: 5, resultSequence: 5, ageMs: 100 },
    frame: { fresh: false, width: 1280, height: 720 },
    objects: [{ id: 'offline-chair', bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
    persons: []
  }, { nowMs: 1600, maxAgeMs: 5000, blackout: false });
  assert.equal(stopped.objects.length + stopped.persons.length, 0);

  const letterboxed = mapNormalizedBoxToVideoRect(
    { x: 0, y: 0, width: 1, height: 1 },
    { sourceWidth: 1280, sourceHeight: 720, displayWidth: 1000, displayHeight: 1000, objectFit: 'contain', mirrored: false }
  );
  assert.deepEqual(letterboxed, { left: 0, top: 218.75, width: 1000, height: 562.5 });

  const covered = mapNormalizedBoxToVideoRect(
    { x: 0, y: 0, width: 1, height: 1 },
    { sourceWidth: 1280, sourceHeight: 720, displayWidth: 1000, displayHeight: 1000, objectFit: 'cover', mirrored: false }
  );
  assert.deepEqual(covered, { left: -388.8889, top: 0, width: 1777.7778, height: 1000 });

  const mirrored = mapNormalizedBoxToVideoRect(
    { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    { sourceWidth: 1280, sourceHeight: 720, displayWidth: 1280, displayHeight: 720, objectFit: 'contain', mirrored: true }
  );
  assert.deepEqual(mirrored, { left: 768, top: 144, width: 384, height: 288 });

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_VISION_OVERLAY_GEOMETRY_CONTRACT_PASS',
    replacement: true,
    stale_cleared: true,
    session_reset: true,
    letterbox_aligned: true,
    mirror_aligned: true
  }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
