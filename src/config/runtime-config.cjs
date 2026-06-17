'use strict';

/**
 * Floki-v2 runtime config.
 *
 * Purpose:
 * - Lock the project to a modern runtime baseline.
 * - Record Java 25 as the future PaperMC 26.1.2 target.
 * - Keep Minecraft/Paper disabled during the Digital Brain foundation stages.
 *
 * This file does not start Java.
 * This file does not start PaperMC.
 * This file does not call Minecraft.
 */

const RUNTIME_CONFIG = Object.freeze({
  stage: 'stage_02_runtime_policy_no_minecraft',

  node: Object.freeze({
    minimum_major: 24,
    preferred_lts_major: 24,
    allowed_current_major: 26,
    maximum_known_major: 26,
    reason: 'Node 24 is the current LTS baseline; Node 26 Current is allowed for experimental local development.'
  }),

  npm: Object.freeze({
    minimum_major: 11,
    external_dependencies_allowed_current_stage: false,
    reason: 'Stage 02 uses only Node built-ins. No dependency sprawl until a module proves it needs one.'
  }),

  java: Object.freeze({
    minimum_major: 25,
    target_major: 25,
    required_for_future_papermc: true,
    enabled_in_current_stage: false,
    reason: 'PaperMC 26.1+ requires Java 25. Floki-v2 is not wiring Paper yet.'
  }),

  papermc: Object.freeze({
    future_target_server_version: '26.1.2',
    required_java_major: 25,
    enabled_in_current_stage: false,
    start_server_in_current_stage: false,
    wire_bridge_in_current_stage: false,
    reason: 'Minecraft comes after terminal-proven brain, speech, memory, emotion, identity, and static PNG vision.'
  }),

  forbidden_in_current_stage: Object.freeze({
    minecraft_runtime: true,
    papermc_startup: true,
    live_bridge: true,
    body_movement: true,
    mineflayer: true,
    pathfinding_libraries: true,
    rcon_body_control: true,
    desktop_automation: true,
    host_screenshot_vision: true,
    fake_success: true
  })
});

function parseMajorVersion(versionText, fieldName = 'version') {
  if (typeof versionText !== 'string' || versionText.trim() === '') {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }

  const cleaned = versionText.trim();

  const javaQuoted = cleaned.match(/version\s+"([0-9]+)(?:\.|")/i);
  if (javaQuoted) {
    return Number(javaQuoted[1]);
  }

  const leadingV = cleaned.match(/^v?([0-9]+)(?:\.|$)/i);
  if (leadingV) {
    return Number(leadingV[1]);
  }

  const openJdkLoose = cleaned.match(/\bopenjdk\s+([0-9]+)(?:\.|$)/i);
  if (openJdkLoose) {
    return Number(openJdkLoose[1]);
  }

  throw new Error(`could not parse major version from ${fieldName}: ${versionText}`);
}

function assertIntegerAtLeast(value, minimum, fieldName) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${fieldName} must be an integer`);
  }

  if (value < minimum) {
    throw new Error(`${fieldName} must be >= ${minimum}; got ${value}`);
  }

  return true;
}

function validateRuntimeConfig(config = RUNTIME_CONFIG) {
  assertIntegerAtLeast(config.node.minimum_major, 24, 'node.minimum_major');
  assertIntegerAtLeast(config.node.preferred_lts_major, 24, 'node.preferred_lts_major');
  assertIntegerAtLeast(config.java.minimum_major, 25, 'java.minimum_major');

  if (config.java.target_major !== 25) {
    throw new Error('java.target_major must be 25 for the PaperMC 26.1+ target');
  }

  if (config.papermc.required_java_major !== 25) {
    throw new Error('papermc.required_java_major must be 25');
  }

  if (config.java.enabled_in_current_stage !== false) {
    throw new Error('Java must not be used by the brain foundation stage yet');
  }

  if (config.papermc.enabled_in_current_stage !== false) {
    throw new Error('PaperMC must not be enabled during the brain foundation stage');
  }

  if (config.papermc.start_server_in_current_stage !== false) {
    throw new Error('PaperMC startup must remain disabled during this stage');
  }

  if (config.papermc.wire_bridge_in_current_stage !== false) {
    throw new Error('Live bridge wiring must remain disabled during this stage');
  }

  for (const [name, value] of Object.entries(config.forbidden_in_current_stage)) {
    if (value !== true) {
      throw new Error(`forbidden_in_current_stage.${name} must be true`);
    }
  }

  return true;
}

function validateNodeRuntime(versionText = process.version, config = RUNTIME_CONFIG) {
  const major = parseMajorVersion(versionText, 'node version');

  if (major < config.node.minimum_major) {
    throw new Error(`Node ${major} is too old. Floki-v2 requires Node ${config.node.minimum_major}+.`);
  }

  if (major > config.node.maximum_known_major) {
    throw new Error(`Node ${major} is newer than this policy has validated. Update runtime-config.cjs after checking upstream docs.`);
  }

  return {
    ok: true,
    major,
    version: versionText
  };
}

function validateJavaRuntime(javaVersionText, config = RUNTIME_CONFIG) {
  const major = parseMajorVersion(javaVersionText, 'java version');

  if (major < config.java.minimum_major) {
    throw new Error(`Java ${major} is too old. Future PaperMC ${config.papermc.future_target_server_version} requires Java ${config.java.minimum_major}+.`);
  }

  return {
    ok: true,
    major,
    target_major: config.java.target_major
  };
}

module.exports = {
  RUNTIME_CONFIG,
  parseMajorVersion,
  validateRuntimeConfig,
  validateNodeRuntime,
  validateJavaRuntime
};
