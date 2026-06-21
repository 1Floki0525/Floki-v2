'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
  loadYamlFile
} = require(path.join(root, 'src/config/yaml-lite.cjs'));

const config = loadYamlFile(
  path.join(root, 'config/chat.config.yaml')
);

const prompts = config?.detection?.grounding_dino_prompts;

assert.ok(
  prompts &&
  typeof prompts === 'object' &&
  !Array.isArray(prompts),
  'grounding_dino_prompts must be a YAML map'
);

const values = Object.keys(prompts)
  .sort()
  .map((key) => String(prompts[key] || '').trim())
  .filter(Boolean);

assert.ok(
  values.length >= 12,
  'Grounding DINO prompt map must contain the configured prompts'
);

const {
  getGroundingDinoConfig
} = require(
  path.join(
    root,
    'src/vision/grounding-dino-detection-service.cjs'
  )
);

const dino = getGroundingDinoConfig();

assert.equal(dino.promptConfigurationValid, true);
assert.deepEqual(dino.prompts, values);
assert.equal(dino.prompts[0], 'a human person');
assert.equal(
  dino.prompts.includes(
    'a person shown inside a framed photograph'
  ),
  true
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_HYBRID_YAML_MAP_AUTHORITY_PASS',
  yaml_arrays_used: false,
  prompt_count: values.length,
  component_substitution_allowed: false,
  live_services_started: false
}, null, 2));
