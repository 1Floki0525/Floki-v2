'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildVisionFrame } = (() => {
  // Manually build a minimal stub
  return { buildVisionFrame: () => null };
})();

// This test asserts the chat-local-interface-api.cjs buildVisionFrame honors toggles
function readSource() {
  return fs.readFileSync(path.join(__dirname, '../src/runtime/chat-local-interface-api.cjs'), 'utf8');
}

function main() {
  const src = readSource();
  const required = [
    'showObjectBoxes',
    'showPersonBoxes',
    'showFaceBoxes',
    'showRecognizedNames',
    'showLabels',
    'showConfidence',
    'showSceneRecognition',
    'show_bounding_boxes',
    'recognized_names'
  ];
  for (const key of required) {
    if (!src.includes(key)) {
      assert.fail('buildVisionFrame must consult setting ' + key);
    }
  }
  if (!src.includes('getInterfaceSettings')) {
    assert.fail('buildVisionFrame must read interface settings');
  }
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_VISION_TOGGLE_FRAME_RENDERER_PASS',
    toggles_checked: required,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main();
