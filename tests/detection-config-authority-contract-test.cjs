'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const {
  clearConfigCache,
  getDetectionConfig,
  getFlokiConfig,
  loadFlokiConfig
} = require(
  path.join(root, 'src/config/floki-config.cjs')
);

clearConfigCache();

const canonical = loadFlokiConfig('chat');
const compatibility = getFlokiConfig('chat');
const detection = getDetectionConfig('chat');

assert.ok(
  canonical.detection &&
  typeof canonical.detection === 'object' &&
  !Array.isArray(canonical.detection),
  'loadFlokiConfig must expose the top-level detection map'
);

assert.equal(
  compatibility.detection.hybrid_detector_enabled,
  true,
  'getFlokiConfig must expose the same top-level detection map'
);

assert.equal(detection.hybrid_detector_enabled, true);
assert.equal(detection.hybrid_require_all_components, true);
assert.equal(detection.object_detector_enabled, true);
assert.equal(detection.grounding_dino_enabled, true);
assert.equal(detection.person_verifier_enabled, true);
assert.equal(detection.yolo_model_path.endsWith('yolo11m.pt'), true);

assert.ok(
  detection.grounding_dino_prompts &&
  typeof detection.grounding_dino_prompts === 'object' &&
  !Array.isArray(detection.grounding_dino_prompts),
  'Grounding DINO prompts must remain a YAML map'
);

assert.equal(
  Object.isFrozen(detection),
  true,
  'detection config must be frozen'
);

assert.equal(
  Object.isFrozen(detection.grounding_dino_prompts),
  true,
  'Grounding DINO prompt map must be frozen'
);

const {
  getGroundingDinoConfig
} = require(
  path.join(
    root,
    'src/vision/grounding-dino-detection-service.cjs'
  )
);

const {
  getHybridDetectionConfig
} = require(
  path.join(
    root,
    'src/vision/hybrid-detection-service.cjs'
  )
);

const {
  getPersonVerifierConfig
} = require(
  path.join(
    root,
    'src/vision/person-presence-verifier.cjs'
  )
);

const {
  getDetectionConfig: getYoloDetectionConfig
} = require(
  path.join(
    root,
    'src/vision/yolo-detection-service.cjs'
  )
);

const dino = getGroundingDinoConfig();
const hybrid = getHybridDetectionConfig();
const verifier = getPersonVerifierConfig();
const yolo = getYoloDetectionConfig();

assert.equal(dino.promptConfigurationValid, true);
assert.equal(dino.enabled, true);
assert.equal(dino.required, true);
assert.ok(dino.prompts.length >= 12);

assert.equal(hybrid.enabled, true);
assert.equal(hybrid.requireAllComponents, true);

assert.equal(verifier.enabled, true);
assert.equal(yolo.enabled, true);
assert.equal(yolo.yoloModelPath.endsWith('yolo11m.pt'), true);

for (const relative of [
  'src/vision/yolo-detection-service.cjs',
  'src/vision/grounding-dino-detection-service.cjs',
  'src/vision/hybrid-detection-service.cjs',
  'src/vision/person-presence-verifier.cjs',
]) {
  const source = fs.readFileSync(
    path.join(root, relative),
    'utf8'
  );

  assert.doesNotMatch(
    source,
    /getVisionConfig\((['"])chat\1\)\.detection/,
    `${relative} must not read detection through vision config`
  );

  assert.match(
    source,
    /getDetectionConfig:\s*getYamlDetectionConfig/,
    `${relative} must import the top-level YAML detection accessor`
  );
}

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_DETECTION_CONFIG_AUTHORITY_CONTRACT_PASS',
  config_path: 'detection',
  prompts_container: 'map',
  yolo_yaml_authority: true,
  grounding_dino_yaml_authority: true,
  hybrid_yaml_authority: true,
  person_verifier_yaml_authority: true,
  live_services_started: false,
  backups_created: false
}, null, 2));
