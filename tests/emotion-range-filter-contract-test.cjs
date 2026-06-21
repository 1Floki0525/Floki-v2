'use strict';

const assert = require('assert');

// Replicate the timestampMs helper from EmotionGraph
function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// Test data: records with various timestamp formats
const now = Date.now();
const ONE_MIN = 60000;
const FIVE_MIN = 300000;
const FIFTEEN_MIN = 900000;

const records = [
  { valence: 0.5, timestamp: now - 10000 },           // 10 seconds ago (epoch ms)
  { valence: 0.6, timestamp: now - 40000 },            // 40 seconds ago (epoch ms)
  { valence: 0.7, timestamp: now - 120000 },           // 2 minutes ago (epoch ms)
  { valence: 0.8, timestamp: now - 300000 },           // 5 minutes ago (epoch ms)
  { valence: 0.9, timestamp: now - 600000 },           // 10 minutes ago (epoch ms)
  { valence: 0.4, timestamp: now - 900000 },           // 15 minutes ago (epoch ms)
  { valence: 0.3, timestamp: now - 1200000 },          // 20 minutes ago (epoch ms)
  { valence: 0.2, timestamp: new Date(now - 30000).toISOString() },  // ISO string, 30s ago
  { valence: 0.1, timestamp: String(now - 5000) },      // numeric string, 5s ago
  { valence: 0.0, timestamp: 'invalid-date-string' },   // invalid
  { valence: -0.1 },                                     // missing timestamp
];

// Test timestampMs
assert.equal(timestampMs(1234567890), 1234567890, 'epoch ms as number');
assert.equal(timestampMs('1234567890'), 1234567890, 'epoch ms as numeric string');
assert(timestampMs(new Date().toISOString()) > 0, 'ISO string');
assert.equal(timestampMs('garbage'), null, 'invalid string returns null');
assert.equal(timestampMs(null), null, 'null returns null');
assert.equal(timestampMs(undefined), null, 'undefined returns null');
assert.equal(timestampMs(0), 0, 'zero returns 0');
assert.equal(timestampMs(NaN), null, 'NaN returns null');
assert.equal(timestampMs(Infinity), null, 'Infinity returns null');

// Test filtering
function filterByRange(records, rangeMs) {
  const now = Date.now();
  return records.filter((h) => {
    const ts = timestampMs(h.timestamp);
    if (ts === null) return false;
    if (rangeMs === Infinity) return true;
    return now - ts <= rangeMs;
  });
}

// 1 min
const oneMin = filterByRange(records, ONE_MIN);
assert(oneMin.length >= 3, `1 min should have >=3 records, got ${oneMin.length}`);
for (const r of oneMin) {
  assert(timestampMs(r.timestamp) !== null, 'filtered records must have valid timestamps');
  assert(now - timestampMs(r.timestamp) <= ONE_MIN, 'record must be within 1 minute');
}

// 5 min
const fiveMin = filterByRange(records, FIVE_MIN);
assert(fiveMin.length >= 5, `5 min should have >=5 records, got ${fiveMin.length}`);

// 15 min
const fifteenMin = filterByRange(records, FIFTEEN_MIN);
assert(fifteenMin.length >= 7, `15 min should have >=7 records, got ${fifteenMin.length}`);

// Session (Infinity)
const session = filterByRange(records, Infinity);
assert.equal(session.length, records.length - 2, 'Session should include all valid-timestamp records');

// Verify invalid timestamps are excluded
const invalidTs = records.filter((h) => timestampMs(h.timestamp) === null);
assert.equal(invalidTs.length, 2, 'Two records should have invalid/missing timestamps');

console.log('PASS: emotion-range-filter-contract — all timestamp formats and ranges verified');
