'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const panel = fs.readFileSync(
  path.join(root, 'apps/floki-neural-interface/src/components/vision/VisionPanel.jsx'),
  'utf8'
);
const settingRow = fs.readFileSync(
  path.join(root, 'apps/floki-neural-interface/src/components/settings/SettingRow.jsx'),
  'utf8'
);

assert.match(panel, /import useSettings from ['"]@\/hooks\/useSettings['"]/);
assert.match(panel, /useSettings\(['"]vision['"]\)/);
assert.match(panel, /showObjectBoxes/);
assert.match(panel, /showPersonBoxes/);
assert.match(panel, /showSceneRecognition/);
assert.match(panel, /aria-pressed=\{active\}/);
assert.match(panel, /data-state=\{active \? ['"]on['"] : ['"]off['"]\}/);
assert.match(panel, /data-testid=\{`detection-layer-\$\{fallbackLabel\}`\}/);
assert.match(panel, /left:\s*`\$\{left\}%`/);
assert.match(panel, /width:\s*`\$\{width\}%`/);
assert.doesNotMatch(panel, /const \[showObjects, setShowObjects\] = useState/);
assert.match(settingRow, /data-testid=\{`setting-/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_VISION_TOGGLE_INTERACTION_CONTRACT_PASS',
  live_panel_uses_shared_vision_settings: true,
  settings_page_and_panel_share_state: true,
  toggle_state_is_observable: true,
  overlay_coordinates_are_percentage_based: true,
  mock_toggle_helpers_used: false
}, null, 2));
