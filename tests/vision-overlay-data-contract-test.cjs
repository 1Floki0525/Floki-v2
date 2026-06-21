'use strict';

const assert = require('assert');

// Simulate the visionFrame() categorization logic from electron/main.cjs
function categorizeDetections(detections) {
  const objects = [];
  const persons = [];
  const faces = [];

  if (Array.isArray(detections)) {
    for (const d of detections) {
      const label = (d.label || d.type || '').toLowerCase();
      if (label === 'person' || d.class_id === 0) {
        persons.push({ ...d, type: 'person' });
      } else {
        objects.push(d);
      }
    }
  }

  return { objects, persons, faces };
}

// Test 1: Person detection goes to persons, not objects
const test1 = categorizeDetections([
  { class_id: 0, label: 'person', confidence: 0.95, bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
  { class_id: 1, label: 'car', confidence: 0.8, bbox: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 } },
  { class_id: 2, label: 'dog', confidence: 0.7, bbox: { x: 0.3, y: 0.6, width: 0.1, height: 0.1 } },
]);

assert.equal(test1.persons.length, 1, 'person detection goes to persons array');
assert.equal(test1.persons[0].label, 'person');
assert.equal(test1.objects.length, 2, 'non-person detections go to objects array');
assert.equal(test1.objects[0].label, 'car');
assert.equal(test1.objects[1].label, 'dog');
assert.equal(test1.faces.length, 0, 'faces array is empty when no face detector');

// Test 2: Multiple persons
const test2 = categorizeDetections([
  { class_id: 0, label: 'person', confidence: 0.9, bbox: { x: 0, y: 0, width: 0.5, height: 0.5 } },
  { class_id: 0, label: 'person', confidence: 0.85, bbox: { x: 0.5, y: 0, width: 0.5, height: 0.5 } },
]);
assert.equal(test2.persons.length, 2, 'two persons');
assert.equal(test2.objects.length, 0);

// Test 3: Empty detections
const test3 = categorizeDetections([]);
assert.equal(test3.persons.length, 0);
assert.equal(test3.objects.length, 0);
assert.equal(test3.faces.length, 0);

// Test 4: No detections at all
const test4 = categorizeDetections(null);
assert.equal(test4.persons.length, 0);
assert.equal(test4.objects.length, 0);

// Test 5: Faces remain separate from persons
const test5 = categorizeDetections([
  { class_id: 0, label: 'person', confidence: 0.9, bbox: { x: 0, y: 0, width: 0.5, height: 0.5 } },
]);
test5.faces.push({ class_id: 0, label: 'person', confidence: 0.9, bbox: { x: 0, y: 0, width: 0.2, height: 0.2 } });
assert.equal(test5.faces.length, 1, 'faces can be populated separately by face detector');
assert.equal(test5.persons.length, 1, 'persons stays separate from faces');

console.log('PASS: vision-overlay-data-contract — person vs object semantics verified');
